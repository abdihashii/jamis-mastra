import type { ChannelHandlerContext } from '@mastra/core/channels';
import type { Span } from '@mastra/core/observability';
import type { RequestContext } from '@mastra/core/request-context';
import type { Message, Thread } from 'chat';
import type { SendblueMessagePayload } from 'chat-adapter-sendblue';
import type { SqlLike } from '../../lib/operator-time-zone';

import { createHash } from 'node:crypto';

import { SpanType } from '@mastra/core/observability';
import { createTool } from '@mastra/core/tools';
import { createSendblueAdapter } from 'chat-adapter-sendblue';
import { z } from 'zod';

import { clearPendingOperatorTimeZoneNotification, consumePendingOperatorTimeZoneChange, readPendingOperatorTimeZoneNotification, readPendingOperatorTimeZoneProposal, saveOperatorTimeZoneProposal, withOperatorTimeZoneTransaction } from '../../lib/operator-time-zone';
import { isIanaTimeZone } from '../../lib/time';
import { requireEnv, requireOperatorTimeZone } from '../env';
import { DEVICE_LOGIN_TIMEOUT_ERROR, MODEL_AUTH_FAILURE, runDeviceLogin } from '../gateways/openai-codex-auth';

export const CODEX_AUTH_CHANNEL_ERROR = 'JAMIS lost access to ChatGPT and did not complete your request. Re-authentication is required.';
export const GENERIC_CHANNEL_ERROR = 'JAMIS could not complete that request. The error was logged.';
export const OPENAI_LOGIN_IN_PROGRESS = 'OpenAI login is already in progress.';
export const OPENAI_LOGIN_SUCCESS = 'OpenAI login complete.';
export const OPENAI_LOGIN_TIMEOUT = 'OpenAI login timed out. Send "login openai" to try again.';
export const OPENAI_LOGIN_FAILURE = 'OpenAI login failed. The error was logged.';
export const OPERATOR_TIME_ZONE_DECLINED = 'Operator time zone change declined.';
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

// Chat SDK dispatches direct messages through Adapter.isDM().
export const sendblueAdapter = Object.assign(adapter, {
	isDM: (threadId: string): boolean => !adapter.decodeThreadId(threadId).groupId,
});

export function isOperator(message: Message): boolean {
	return message.author.userId.trim() === operatorNumber;
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

/** ponytail: one process-wide operator queue; use shared coordination if JAMIS scales past one process. */
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
	const hasSource = !!thread.id
		&& !!message.id.trim()
		&& message.threadId === thread.id
		&& messageAt instanceof Date
		&& Number.isFinite(messageAt.getTime());
	const correlation = context && hasSource && messageAt ? { context, messageAt } : undefined;
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
		let deliveryFailed = false;
		const boundarySpan = span;
		observedThread = boundarySpan
			? new Proxy(thread, {
					get(target, property, receiver) {
						if (property !== 'post')
							return Reflect.get(target, property, receiver);
						return async (postable: unknown) => {
							try {
								const result = await Reflect.apply(target.post, target, [postable]);
								if (!deliveryFailed)
									boundarySpan.update({ metadata: { stage: 'reply_delivery', classification: 'delivered' } });
								return result;
							}
							catch (error) {
								deliveryFailed = true;
								boundarySpan.update({ metadata: { stage: 'reply_delivery', classification: 'failed' } });
								throw error;
							}
						};
					},
				})
			: thread;
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
			await deliverPendingOperatorTimeZoneNotification(observedThread, sql);
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
			await defaultHandler(observedThread, message);
		});
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
