import type { ChannelHandlerContext } from '@mastra/core/channels';
import type { StorageThreadType } from '@mastra/core/memory';
import type { Span } from '@mastra/core/observability';
import type { RequestContext } from '@mastra/core/request-context';
import type { MemoryStorage } from '@mastra/core/storage';
import type { Message, Thread } from 'chat';
import type { SendblueMessagePayload } from 'chat-adapter-sendblue';
import type { linearCreateInputSchema } from '../../lib/linear';

import type { SqlLike } from '../../lib/operator-time-zone';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import process from 'node:process';
import { SpanType } from '@mastra/core/observability';
import { createTool } from '@mastra/core/tools';
import { createSendblueAdapter } from 'chat-adapter-sendblue';

import { z } from 'zod';
import { createLinearClient, linearCreateOperationSchema } from '../../lib/linear';
import { cancelLinearConversation, claimLinearCreate, finishLinearCreate, notifyLinearOutcome, postLinearCreateProposal, readLinearProposal, receiveLinearMessage } from '../../lib/linear-proposals';
import { clearOperatorTimeZoneConversation, clearPendingOperatorTimeZoneNotification, consumePendingOperatorTimeZoneChange, readPendingOperatorTimeZoneNotification, readPendingOperatorTimeZoneProposal, saveOperatorTimeZoneProposal, withOperatorTimeZoneTransaction } from '../../lib/operator-time-zone';
import { isIanaTimeZone } from '../../lib/time';
import { requireEnv, requireOperatorTimeZone } from '../env';
import { DEVICE_LOGIN_TIMEOUT_ERROR, MODEL_AUTH_FAILURE, runDeviceLogin } from '../gateways/openai-codex-auth';
import { clearDeploymentSnapshot, settleDeploymentSnapshotReply } from '../tools/deployment-monitoring';

export const CODEX_AUTH_CHANNEL_ERROR = 'JAMIS lost access to ChatGPT and did not complete your request. Re-authentication is required.';
export const GENERIC_CHANNEL_ERROR = 'JAMIS could not complete that request. The error was logged.';
export const OPENAI_LOGIN_IN_PROGRESS = 'OpenAI login is already in progress.';
export const OPENAI_LOGIN_SUCCESS = 'OpenAI login complete.';
export const OPENAI_LOGIN_TIMEOUT = 'OpenAI login timed out. Send "login openai" to try again.';
export const OPENAI_LOGIN_FAILURE = 'OpenAI login failed. The error was logged.';
export const OPERATOR_TIME_ZONE_DECLINED = 'Operator time zone change declined.';
export const NEW_SESSION_SUCCESS = 'New session started.';
export const SENDBLUE_CHANNEL_SPAN_NAME = 'sendblue.channel';
export const SENDBLUE_CORRELATION_KEY = 'sendblue_message_digest';

export function hashSendblueMessageHandle(messageHandle: string): string {
	return createHash('sha256').update(messageHandle).digest('hex');
}

export function formatSendblueError(error: Error): string {
	return error.message.includes(MODEL_AUTH_FAILURE) ? CODEX_AUTH_CHANNEL_ERROR : GENERIC_CHANNEL_ERROR;
}

const operatorNumber = requireEnv('JAMIS_ALLOWED_NUMBER').trim();
const adapter = createSendblueAdapter({
	webhookSecret: requireEnv('SENDBLUE_WEBHOOK_SECRET'),
});
const postMessage = adapter.postMessage.bind(adapter);

export function requireSendbluePostAcceptance(value: unknown): void {
	const result = z.object({
		id: z.string().min(1),
		raw: z.object({ message_handle: z.string().min(1), status: z.enum(['QUEUED', 'SENT', 'DELIVERED']), error_code: z.number().nullable().optional() }),
	}).safeParse(value);
	if (!result.success || result.data.id !== result.data.raw.message_handle || result.data.raw.error_code)
		throw new Error('Sendblue posting unavailable.');
}

// Chat SDK dispatches direct messages through Adapter.isDM().
export const sendblueAdapter = Object.assign(adapter, {
	isDM: (threadId: string): boolean => !adapter.decodeThreadId(threadId).groupId,
	// Chat SDK discards the raw response in Thread.post; validate before that boundary.
	postMessage: async (...args: Parameters<typeof adapter.postMessage>) => {
		const result = await postMessage(...args);
		requireSendbluePostAcceptance(result);
		return result;
	},
});

export function isOperator(message: Message): boolean {
	return message.author.userId.trim() === operatorNumber;
}

/** Called inside the serialized operator queue; does not send a reply or run the agent. */
export async function startJamisDmSession(
	memory: MemoryStorage,
	thread: Thread,
	message: Message,
	beforeCreate?: () => Promise<void>,
): Promise<{ status: 'created' | 'replayed' | 'superseded'; thread: StorageThreadType }> {
	if (!isOperator(message) || thread.adapter.name !== 'sendblue' || !thread.isDM
		|| !thread.id || message.threadId !== thread.id || !message.id?.trim()) {
		throw new Error('A validated operator Sendblue DM is required to start a Jamis session.');
	}

	const coordinates = {
		channel_platform: 'sendblue',
		channel_externalThreadId: thread.id,
		channel_externalChannelId: thread.channelId,
	};
	const metadata = { ...coordinates, channel_ownerId: 'jamis' };
	const { threads } = await memory.listThreads({ filter: { metadata }, perPage: 1 });
	let current: StorageThreadType | undefined = threads[0];
	if (!current) {
		// Match native legacy selection without claiming or changing the old thread.
		const { threads: candidates } = await memory.listThreads({
			filter: { metadata: coordinates },
			perPage: 10,
			orderBy: { field: 'createdAt', direction: 'ASC' },
		});
		current = candidates.find(candidate => !('channel_ownerId' in (candidate.metadata ?? {})));
	}

	const threadId = `jamis-dm-${hashSendblueMessageHandle(JSON.stringify(['jamis', thread.id, thread.channelId, message.id]))}`;
	const existing = await memory.getThreadById({ threadId });
	if (existing)
		return { status: current?.id === existing.id ? 'replayed' : 'superseded', thread: existing };

	const createdAt = new Date(Math.max(Date.now(), current ? current.createdAt.getTime() + 1 : 0));
	await beforeCreate?.();
	const fresh = await memory.saveThread({
		thread: {
			id: threadId,
			resourceId: current?.resourceId ?? `sendblue:${message.author.userId}`,
			title: 'sendblue conversation',
			createdAt,
			updatedAt: createdAt,
			metadata,
		},
	});
	return { status: 'created', thread: fresh };
}

export function isOpenAILoginCommand(message: Message): boolean {
	return message.text.trim().toLowerCase() === 'login openai';
}

export interface SendblueChannelCapability {
	readonly message: Message;
	readonly thread: Thread;
}

interface SendblueChannelCapabilityInternal extends SendblueChannelCapability {
	messageId: string;
	messageAt: Date;
	threadId: string;
	used: boolean;
}

const sendblueChannelCapabilities = new WeakMap<RequestContext, SendblueChannelCapabilityInternal>();
const linearTurns = new AsyncLocalStorage<{
	capability: SendblueChannelCapabilityInternal;
	requestContext: RequestContext;
	sql?: SqlLike;
	active: boolean;
}>();

async function postLinearText(thread: Thread, text: string): Promise<void> {
	try {
		const result = z.object({ id: z.string().min(1) }).safeParse(await thread.post(text));
		if (!result.success)
			throw new Error('Posting not accepted');
	}
	catch {
		throw new Error('Linear channel posting unavailable.');
	}
}

/** Runtime authority follows native delegation without serializing channel objects or a bearer capability. */
export async function proposeLinearCreate(raw: z.input<typeof linearCreateInputSchema>): Promise<{ status: 'denied' | 'proposed' | 'unavailable' }> {
	const turn = linearTurns.getStore();
	if (!turn?.active || turn.capability.used)
		return { status: 'denied' };
	const session = z.object({ thread: z.object({ id: z.string().min(1) }) }).safeParse(turn.requestContext.getRaw('MastraMemory'));
	if (!session.success)
		return { status: 'denied' };
	turn.capability.used = true;
	try {
		const op = await createLinearClient().prepareCreate(raw);
		if (await readPendingOperatorTimeZoneProposal(turn.sql))
			return { status: 'denied' };
		const saved = await postLinearCreateProposal(op, turn.capability.threadId, session.data.thread.id, turn.capability.messageId, text => postLinearText(turn.capability.thread, text), turn.sql);
		return { status: saved ? 'proposed' : 'denied' };
	}
	catch {
		return { status: 'unavailable' };
	}
}

async function activeJamisSession(context: ChannelHandlerContext, thread: Thread): Promise<string | null> {
	const memory = await context.mastra?.getStorage()?.getStore('memory');
	if (!memory)
		return null;
	const coordinates = { channel_platform: 'sendblue', channel_externalThreadId: thread.id, channel_externalChannelId: thread.channelId };
	const owned = await memory.listThreads({ filter: { metadata: { ...coordinates, channel_ownerId: 'jamis' } }, perPage: 1 });
	if (owned.threads[0])
		return owned.threads[0].id;
	const legacy = await memory.listThreads({ filter: { metadata: coordinates }, perPage: 10, orderBy: { field: 'createdAt', direction: 'ASC' } });
	return legacy.threads.find(candidate => !('channel_ownerId' in (candidate.metadata ?? {})))?.id ?? null;
}

async function handleLinearConfirmation(thread: Thread, message: Message, context: ChannelHandlerContext, fresh: boolean, sql?: SqlLike): Promise<boolean> {
	const proposal = await readLinearProposal(thread.id, sql);
	if (!proposal)
		return false;
	if (proposal.state !== 'pending') {
		await notifyLinearOutcome(proposal, text => postLinearText(thread, text), sql);
		return true;
	}
	if (!fresh)
		return true;
	const confirmation = message.text.trim() === 'confirm';
	const timeZone = await readPendingOperatorTimeZoneProposal(sql);
	const allowed = !timeZone && confirmation
		&& await isImmediatelyFollowingOperatorMessage(thread, message, proposal.source_message_id);
	const claimed = await claimLinearCreate(proposal, await activeJamisSession(context, thread), message.id, allowed, sql);
	if (!claimed) {
		if (confirmation || /^(?:no|decline|cancel)[.!]?$/i.test(message.text.trim())) {
			await thread.post('Linear create proposal canceled.');
			return true;
		}
		return false;
	}
	let outcome;
	try {
		const op = linearCreateOperationSchema.parse(proposal.operation);
		outcome = await createLinearClient(process.env, true).executeCreate(op);
	}
	catch {
		outcome = { status: 'failed' as const };
	}
	await finishLinearCreate(proposal.id, outcome, sql);
	await notifyLinearOutcome({ ...proposal, state: outcome.status, outcome }, text => postLinearText(thread, text), sql);
	return true;
}

export function getSendblueChannelCapability(requestContext: RequestContext): SendblueChannelCapability | undefined {
	return sendblueChannelCapabilities.get(requestContext);
}

export async function proposeOperatorTimeZoneChange(
	timeZone: string | null,
	requestContext: RequestContext,
	sql?: SqlLike,
): Promise<{ status: 'denied' | 'proposed' | 'rejected' }> {
	const capability = sendblueChannelCapabilities.get(requestContext);
	if (!capability || capability.used)
		return { status: 'denied' };
	capability.used = true;

	const proposed = timeZone === null ? null : timeZone.trim();
	if (proposed !== null && !isIanaTimeZone(proposed)) {
		await capability.thread.post(`Invalid operator time zone: "${proposed}". Nothing was proposed.`);
		return { status: 'rejected' };
	}
	const target = proposed ?? requireOperatorTimeZone();
	// ponytail: Sendblue and PostgreSQL cannot commit atomically. This fails closed;
	// add a narrow outbox only if requiring a fresh proposal after a crash becomes material.
	return await withOperatorTimeZoneTransaction(async (transaction) => {
		const saved = await saveOperatorTimeZoneProposal(
			proposed,
			capability.threadId,
			capability.messageId,
			capability.messageAt,
			transaction,
		);
		if (!saved)
			return { status: 'denied' as const };
		await capability.thread.post(proposed === null
			? `Proposed operator time zone reset to ${target} (default). Reply yes to confirm; any other reply cancels.`
			: `Proposed operator time zone: ${target}. Reply yes to confirm; any other reply cancels.`);
		return { status: 'proposed' as const };
	}, sql);
}

const operatorTimeZoneChangeOutputSchema = z.object({
	status: z.enum(['denied', 'proposed', 'rejected']),
});

export const operatorTimeZoneChangeTool = createTool({
	id: 'propose-operator-time-zone-change',
	description: 'Propose one exact IANA operator time zone, or null to reset to the deployment default. This only records a proposal; the operator must confirm it in the immediately following direct message.',
	inputSchema: z.object({
		timeZone: z.string().nullable().describe('Exact IANA time zone, or null to reset the override.'),
	}),
	outputSchema: operatorTimeZoneChangeOutputSchema,
	toModelOutput: output => ({
		type: 'text',
		value: output.status === 'denied'
			? 'Operator time-zone changes are unavailable in this context.'
			: 'The channel response was already sent. Do not send another response.',
	}),
	execute: async ({ timeZone }, { agent, requestContext }) => agent?.agentId === 'jamis'
		? await proposeOperatorTimeZoneChange(timeZone, requestContext)
		: { status: 'denied' as const },
});

function isOperatorTimeZoneConfirmation(text: string): boolean {
	return /^(?:yes|confirm)[.!]?$/i.test(text.trim());
}

function isOperatorTimeZoneDecline(text: string): boolean {
	return /^(?:no|decline|cancel)[.!]?$/i.test(text.trim());
}

async function isImmediatelyFollowingOperatorMessage(thread: Thread, message: Message, proposalMessageId: string): Promise<boolean> {
	try {
		const { messages } = await thread.adapter.fetchMessages(thread.id, { limit: 50 });
		const operatorMessages = messages
			.filter(candidate => candidate.threadId === thread.id && isOperator(candidate));
		const currentIndex = operatorMessages.findIndex(candidate => candidate.id === message.id);
		return currentIndex > 0 && operatorMessages[currentIndex - 1]?.id === proposalMessageId;
	}
	catch {
		console.error('[operator-time-zone] Failed to verify confirmation adjacency with Sendblue.');
		return false;
	}
}

async function deliverPendingOperatorTimeZoneNotification(thread: Thread, sql?: SqlLike): Promise<void> {
	const pending = await readPendingOperatorTimeZoneNotification(sql);
	if (!pending || pending.threadId !== thread.id)
		return;
	const effective = pending.overrideTimeZone ?? requireOperatorTimeZone();
	// ponytail: acknowledgment delivery is at least once; add provider idempotency only if duplicate status messages become material.
	await thread.post(pending.overrideTimeZone
		? `Operator time zone changed to ${effective} (override).`
		: `Operator time zone reset to ${effective} (default).`);
	await clearPendingOperatorTimeZoneNotification(pending.threadId, pending.messageId, sql);
}

/** ponytail: one process-wide login; use shared coordination only if JAMIS scales past one process. */
let openAILoginInFlight: Promise<void> | null = null;

/** ponytail: one process-wide operator queue; add durable intake for crash recovery or multiple processes. */
let directMessageTail = Promise.resolve();

function enqueueDirectMessage(task: () => Promise<void>): Promise<void> {
	const current = directMessageTail
		.catch(() => undefined)
		.then(task);
	directMessageTail = current;
	return current;
}

async function handleOpenAILoginCommand(thread: Thread): Promise<{ completion?: Promise<void> }> {
	if (openAILoginInFlight) {
		await thread.post(OPENAI_LOGIN_IN_PROGRESS);
		return {};
	}

	let acknowledge!: () => void;
	const acknowledged = new Promise<void>(resolve => (acknowledge = resolve));
	const completion = runDeviceLogin(async ({ url, userCode }) => {
		await thread.post(`Open ${url} and enter code: ${userCode}`);
		acknowledge();
	}).then(async () => {
		try {
			await thread.post(OPENAI_LOGIN_SUCCESS);
		}
		catch {
			console.error('[openai-codex] Device login status=complete detail=notification_failed.');
		}
	}, async (error) => {
		const timedOut = error instanceof Error && error.message === DEVICE_LOGIN_TIMEOUT_ERROR;
		const status = timedOut ? 'timeout' : 'failed';
		console.error(`[openai-codex] Device login status=${status}.`);
		try {
			await thread.post(timedOut ? OPENAI_LOGIN_TIMEOUT : OPENAI_LOGIN_FAILURE);
		}
		catch {
			console.error(`[openai-codex] Device login status=${status} detail=notification_failed.`);
		}
	}).finally(() => {
		openAILoginInFlight = null;
		acknowledge();
	});
	openAILoginInFlight = completion;
	await acknowledged;
	return { completion };
}

export async function handleSendblueDirectMessage(
	thread: Thread,
	message: Message,
	defaultHandler: (thread: Thread, message: Message) => Promise<void>,
	context?: ChannelHandlerContext,
	sql?: SqlLike,
): Promise<void> {
	if (!isOperator(message) || thread.adapter.name !== 'sendblue' || !thread.isDM)
		return;

	const messageAt = message.metadata?.dateSent;
	const hasMessageIdentity = !!thread.id
		&& !!message.id.trim()
		&& message.threadId === thread.id;
	const linearContext = hasMessageIdentity ? context : undefined;
	const hasSource = hasMessageIdentity && messageAt instanceof Date
		&& Number.isFinite(messageAt.getTime());
	const correlation = context && hasSource && messageAt ? { context, messageAt } : undefined;
	let defaultHandlerStarted = false;
	let deliveryFailed = false;
	let spanEndedLater = false;
	let span: Span<SpanType.GENERIC> | undefined;
	let observedThread = thread;
	if (correlation) {
		const digest = hashSendblueMessageHandle(message.id);
		correlation.context.requestContext.setRaw(SENDBLUE_CORRELATION_KEY, digest);
		span = correlation.context.mastra?.observability.getDefaultInstance()?.startSpan({
			name: SENDBLUE_CHANNEL_SPAN_NAME,
			type: SpanType.GENERIC,
			requestContext: correlation.context.requestContext,
			metadata: { stage: 'channel_intake', classification: 'accepted' },
		});
		const boundarySpan = span;
		observedThread = new Proxy(thread, {
			get(target, property, receiver) {
				if (property !== 'post')
					return Reflect.get(target, property, receiver);
				return async (postable: unknown) => {
					try {
						const result = await Reflect.apply(target.post, target, [postable]);
						if (!deliveryFailed) {
							boundarySpan?.update({ metadata: { stage: 'reply_delivery', classification: 'delivered' } });
							settleDeploymentSnapshotReply(thread.id, message.id, postable !== GENERIC_CHANNEL_ERROR && postable !== CODEX_AUTH_CHANNEL_ERROR);
						}
						return result;
					}
					catch (error) {
						deliveryFailed = true;
						boundarySpan?.update({ metadata: { stage: 'reply_delivery', classification: 'failed' } });
						settleDeploymentSnapshotReply(thread.id, message.id, false);
						throw error;
					}
				};
			},
		});
		const capability: SendblueChannelCapabilityInternal = {
			message,
			messageId: message.id,
			messageAt: correlation.messageAt,
			thread: observedThread,
			threadId: thread.id,
			used: false,
		};
		sendblueChannelCapabilities.set(correlation.context.requestContext, capability);
	}

	try {
		if (isOpenAILoginCommand(message)) {
			return await enqueueDirectMessage(async () => {
				if (linearContext && await receiveLinearMessage(thread.id, message.id, sql))
					await cancelLinearConversation(thread.id, sql);
				const { completion } = await handleOpenAILoginCommand(observedThread);
				if (correlation) {
					try {
						await consumePendingOperatorTimeZoneChange(thread.id, message.id, correlation.messageAt, false, sql);
					}
					catch {
						console.error('[operator-time-zone] Failed to clear a pending proposal during OpenAI login.');
					}
				}
				if (span && completion) {
					spanEndedLater = true;
					void completion.then(() => span.end(), () => span.end());
				}
			});
		}

		return await enqueueDirectMessage(async () => {
			if (message.text.trim() === '/new') {
				let result: Awaited<ReturnType<typeof startJamisDmSession>>;
				try {
					if (linearContext)
						await receiveLinearMessage(thread.id, message.id, sql);
					await deliverPendingOperatorTimeZoneNotification(observedThread, sql);
					const memory = await context?.mastra?.getStorage()?.getStore('memory');
					if (!memory)
						throw new Error('Memory storage is required to start a Jamis session.');
					result = await startJamisDmSession(memory, thread, message, async () => {
						// Cancel before writing so a lost write acknowledgement cannot leak old state.
						await clearOperatorTimeZoneConversation(sql);
						await cancelLinearConversation(thread.id, sql);
						clearDeploymentSnapshot(thread.id);
					});
				}
				catch {
					console.error(deliveryFailed
						? '[jamis-dm-session] Setting notification acceptance failed.'
						: '[jamis-dm-session] Session rollover failed.');
					if (!deliveryFailed) {
						await observedThread.post(GENERIC_CHANNEL_ERROR);
						span?.update({ metadata: { stage: 'channel_intake', classification: 'failed' } });
					}
					return;
				}
				if (result.status !== 'superseded') {
					try {
						await observedThread.post(NEW_SESSION_SUCCESS);
					}
					catch {
						console.error('[jamis-dm-session] Session started; confirmation acceptance failed.');
					}
				}
				return;
			}
			const freshLinearTurn = linearContext ? await receiveLinearMessage(thread.id, message.id, sql) : false;
			await deliverPendingOperatorTimeZoneNotification(observedThread, sql);
			if (linearContext && await handleLinearConfirmation(observedThread, message, linearContext, freshLinearTurn, sql)) {
				// Never allow one confirm to authorize both kinds of proposal.
				if (correlation)
					await consumePendingOperatorTimeZoneChange(thread.id, message.id, correlation.messageAt, false, sql);
				return;
			}
			if (correlation) {
				const confirmationRequested = isOperatorTimeZoneConfirmation(message.text);
				const proposal = confirmationRequested ? await readPendingOperatorTimeZoneProposal(sql) : null;
				const confirmed = !!proposal
					&& proposal.threadId === thread.id
					&& await isImmediatelyFollowingOperatorMessage(observedThread, message, proposal.messageId);
				const pending = await consumePendingOperatorTimeZoneChange(thread.id, message.id, correlation.messageAt, confirmed, sql);
				if (!pending)
					return;
				if (pending.applied) {
					await deliverPendingOperatorTimeZoneNotification(observedThread, sql);
					return;
				}
				if (pending.consumedProposal && isOperatorTimeZoneDecline(message.text)) {
					await observedThread.post(OPERATOR_TIME_ZONE_DECLINED);
					return;
				}
				if (pending.consumedProposal && confirmationRequested) {
					await observedThread.post('Operator time zone change canceled.');
					return;
				}
			}
			defaultHandlerStarted = true;
			const capability = correlation && sendblueChannelCapabilities.get(correlation.context.requestContext);
			if (!capability || !freshLinearTurn) {
				await defaultHandler(observedThread, message);
				return;
			}
			const turn = { capability, requestContext: correlation!.context.requestContext, sql, active: true };
			try {
				await linearTurns.run(turn, () => defaultHandler(observedThread, message));
			}
			finally {
				turn.active = false;
			}
		});
	}
	catch (error) {
		if (!defaultHandlerStarted && !deliveryFailed)
			span?.update({ metadata: { stage: 'channel_intake', classification: 'failed' } });
		throw error;
	}
	finally {
		if (correlation)
			sendblueChannelCapabilities.delete(correlation.context.requestContext);
		if (!spanEndedLater)
			span?.end();
	}
}

// The Sendblue adapter attaches the raw platform payload; group_id is the
// group's stable Sendblue ID and is empty for direct messages.
export function isGroupMessage(message: Message, groupId: string): boolean {
	const raw = message.raw as Partial<SendblueMessagePayload> | undefined;
	return !!groupId && !!raw?.group_id && raw.group_id === groupId;
}
