import type { ChannelHandlerContext } from '@mastra/core/channels';
import type { AnyExportedSpan } from '@mastra/core/observability';
import type { AdapterPostableMessage, Message, Thread } from 'chat';
import type { SqlLike } from '../../../lib/operator-time-zone';

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Mastra } from '@mastra/core/mastra';
import { TracingEventType } from '@mastra/core/observability';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { Observability } from '@mastra/observability';
import { parseMarkdown } from 'chat';
import { createSendblueAdapter, toPlainText } from 'chat-adapter-sendblue';
import { MODEL_AUTH_FAILURE } from '../../gateways/openai-codex-auth.js';
import { clearDeploymentSnapshot, getDeploymentSnapshot, settleDeploymentSnapshotReply, stageDeploymentSnapshot } from '../../tools/deployment-monitoring';

process.env.JAMIS_ALLOWED_NUMBER = '+15555550101';
process.env.SENDBLUE_API_KEY = 'test-api-key';
process.env.SENDBLUE_API_SECRET = 'test-api-secret';
process.env.SENDBLUE_FROM_NUMBER = '+15555550100';
process.env.SENDBLUE_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.OPERATOR_TIMEZONE = 'America/Chicago';

const {
	CODEX_AUTH_CHANNEL_ERROR,
	formatSendblueError,
	GENERIC_CHANNEL_ERROR,
	EMPTY_REPLY_CHANNEL_ERROR,
	getSendblueChannelCapability,
	handleSendblueDirectMessage,
	hashSendblueMessageHandle,
	isOpenAILoginCommand,
	NEW_SESSION_SUCCESS,
	operatorTimeZoneChangeTool,
	OPENAI_LOGIN_FAILURE,
	OPENAI_LOGIN_IN_PROGRESS,
	OPENAI_LOGIN_SUCCESS,
	OPENAI_LOGIN_TIMEOUT,
	proposeOperatorTimeZoneChange,
	requireSendbluePostAcceptance,
	SENDBLUE_CHANNEL_SPAN_NAME,
	SENDBLUE_CORRELATION_KEY,
} = await import('../sendblue.js');

const { consumePendingOperatorTimeZoneChange } = await import('../../../lib/operator-time-zone.js');

const operatorNumber = process.env.JAMIS_ALLOWED_NUMBER!;

test('Sendblue outbound payloads preserve literal code, paths, URLs, and prose formatting', async () => {
	const path = 'src/mastra/channels/__tests__/fixtures/';
	const payloads: unknown[] = [];
	const response = { message_handle: 'outbound', status: 'QUEUED' as const };
	const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
		payloads.push(JSON.parse(String(init?.body)));
		return Response.json(response);
	}) as typeof globalThis.fetch);
	try {
		const adapter = createSendblueAdapter({ apiKey: 'test-api-key', apiSecret: 'test-api-secret' });
		for (const [input, expected] of [
			[`\`${path}\``, path],
			[`\`\`\`ts\n"__tests__"; **literal**; *star*; _name_; ~~keep~~\n\`\`\``, '"__tests__"; **literal**; *star*; _name_; ~~keep~~'],
			[`\`\`\`\n${path}\n\`\`\``, path],
			[`Read ${path} and /src/__tests__/file_name.ts.`, `Read ${path} and /src/__tests__/file_name.ts.`],
			['`**one** _two_` and `*three* __four__`', '**one** _two_ and *three* __four__'],
			['`[keep](https://example.com/a_b)` https://example.com/__one__ https://example.com/a*b', '[keep](https://example.com/a_b) https://example.com/__one__ https://example.com/a*b'],
			['%%URLPH0%% %%LITERAL0%% %%LITERAL%0%% `%%LITERAL0%%` https://example.com/a_b', '%%URLPH0%% %%LITERAL0%% %%LITERAL%0%% %%LITERAL0%% https://example.com/a_b'],
			['%%LIT**ERAL**0%% `keep`', '%%LITERAL0%% keep'],
			['# Heading\n**bold** *italic* _emphasis_ ~~strike~~\n- first\n+ second\n---\n[docs](https://example.com/a_b)', 'Heading\nbold italic emphasis strike\n• first\n• second\n\ndocs (https://example.com/a_b)'],
			['`# literal\n- item\n___`', '# literal\n- item\n___'],
			['***strong***\nline two', 'strong\nline two'],
		]) {
			expect(toPlainText(input)).toBe(expected);
			for (const coordinates of [{ fromNumber: '+15555550100', contactNumber: operatorNumber }, { fromNumber: '+15555550100', groupId: 'test-group' }]) {
				const threadId = adapter.encodeThreadId(coordinates);
				for (const message of [input, { markdown: input }, { text: input }]) {
					// The pinned adapter also accepts its legacy text form at runtime.
					const result = await adapter.postMessage(threadId, message as AdapterPostableMessage);
					expect(payloads.pop()).toMatchObject({ content: expected, from_number: coordinates.fromNumber, ...('groupId' in coordinates ? { group_id: coordinates.groupId } : { number: coordinates.contactNumber }) });
					expect(result).toMatchObject({ id: 'outbound', raw: response, threadId });
					requireSendbluePostAcceptance(result);
				}
			}
		}
		const ast = parseMarkdown(`Read \`${path}\` and **reply**.`);
		expect(adapter.renderFormatted(ast)).toBe(`Read ${path} and reply.`);
		for (const coordinates of [{ fromNumber: '+15555550100', contactNumber: operatorNumber }, { fromNumber: '+15555550100', groupId: 'test-group' }]) {
			const threadId = adapter.encodeThreadId(coordinates);
			await adapter.postMessage(threadId, { ast });
			expect(payloads.pop()).toMatchObject({ content: `Read ${path} and reply.` });
			async function* chunks() {
				yield `Read \`src/mastra/`;
				yield { type: 'markdown_text' as const, text: `channels/__tests__/fixtures/\`\n\n` };
				yield '**reply**.';
			}
			requireSendbluePostAcceptance(await adapter.stream(threadId, chunks()));
			expect(payloads.splice(0)).toMatchObject([{ content: `Read ${path}` }, { content: 'reply.' }]);
		}
	} finally {
		fetch.mockRestore();
	}
});

test('Sendblue posting requires a known accepted status and matching nonempty handle', () => {
	for (const status of ['QUEUED', 'SENT', 'DELIVERED'])
		expect(() => requireSendbluePostAcceptance({ id: 'outbound', raw: { message_handle: 'outbound', status } })).not.toThrow();
	for (const value of [
		{},
		{ id: '', raw: { message_handle: '', status: 'SENT' } },
		{ id: 'outbound', raw: { message_handle: 'other', status: 'SENT' } },
		{ id: 'outbound', raw: { message_handle: 'outbound', status: 'ERROR', error_message: 'private upstream text' } },
		{ id: 'outbound', raw: { message_handle: 'outbound' } },
		{ id: 'outbound', raw: { message_handle: 'outbound', status: 'SENT', error_code: 1 } },
	])
		expect(() => requireSendbluePostAcceptance(value)).toThrow('Sendblue posting unavailable.');
});

const directThreadId = 'sendblue:test-line:test-operator';
let messageSequence = 0;
const messageHistory = new Map<string, Message[]>();

beforeEach(() => {
	messageHistory.clear();
	messageSequence = 0;
	clearDeploymentSnapshot(directThreadId);
});

function makeMessage(
	text: string,
	userId: string = operatorNumber,
	id = 'message-1',
	threadId = directThreadId,
	dateSent = new Date(Date.UTC(2030, 0, 1) + messageSequence++ * 1000),
): Message {
	const message = { id, threadId, text, author: { userId }, metadata: { dateSent } } as Message;
	messageHistory.set(threadId, [...(messageHistory.get(threadId) ?? []), message]);
	return message;
}

function makeThread(
	messages: string[],
	onPost?: (message: string) => Promise<void>,
	options: { adapterName?: string; id?: string; isDM?: boolean } = {},
): Thread {
	return {
		id: options.id ?? directThreadId,
		channelId: 'test-line',
		isDM: options.isDM ?? true,
		adapter: {
			name: options.adapterName ?? 'sendblue',
			fetchMessages: async (threadId: string) => ({ messages: messageHistory.get(threadId) ?? [] }),
		},
		post: async (message: string) => {
			messages.push(message);
			await onPost?.(message);
			return {};
		},
	} as unknown as Thread;
}

function makeHandlerContext(observability?: Observability): ChannelHandlerContext {
	return {
		mastra: observability ? { observability } as never : undefined,
		requestContext: new RequestContext(),
		signalMetadata: {},
	};
}

function captureObservability(spans: AnyExportedSpan[]): Observability {
	return new Observability({
		configs: {
			default: {
				serviceName: 'test',
				requestContextKeys: [SENDBLUE_CORRELATION_KEY],
				exporters: [{
					name: 'capture',
					onTracingEvent: (event) => {
						if (event.type === TracingEventType.SPAN_ENDED)
							spans.push(event.exportedSpan);
					},
					flush: async () => {},
					shutdown: async () => {},
					exportTracingEvent: async () => {},
				}],
			},
		},
	});
}

function memorySql(initialOverride?: string | null) {
	let override = initialOverride;
	let proposal: { messageAt: Date; messageId: string; threadId: string; timeZone: string | null } | undefined;
	let lastMessage: { messageAt: Date; messageId: string; threadId: string } | undefined;
	let notification: { messageId: string; overrideTimeZone: string | null; threadId: string } | undefined;
	let applied = 0;
	const sql = (async (strings, ...values) => {
		const query = strings.join('?').replace(/\s+/g, ' ').trim();
		if (query.includes('SET proposal_time_zone = NULL') && query.includes('last_message_at = NULL')) {
			proposal = undefined;
			lastMessage = undefined;
			return [];
		}
		if (query.includes('SET proposal_time_zone =') && query.includes('AND last_message_id =')) {
			const [timeZone, threadId, messageId, messageAt] = values as [string | null, string, string, Date];
			if (notification
				|| !lastMessage
				|| lastMessage.threadId !== threadId
				|| lastMessage.messageId !== messageId
				|| lastMessage.messageAt.getTime() !== messageAt.getTime()) {
				return [];
			}
			proposal = { messageAt, timeZone, threadId, messageId };
			return [{ proposal_time_zone: timeZone }];
		}
		if (query.includes('WITH previous AS')) {
			const messageAt = values[0] as Date;
			const confirm = values[1] as boolean;
			const threadId = values[2] as string;
			const messageId = values[4] as string;
			if (notification || (lastMessage && messageAt.getTime() <= lastMessage.messageAt.getTime()))
				return [];
			const current = proposal;
			proposal = undefined;
			lastMessage = { messageAt, messageId, threadId };
			const didApply = !!current && confirm && current.threadId === threadId;
			if (didApply) {
				override = current.timeZone;
				notification = { messageId, overrideTimeZone: current.timeZone, threadId };
				applied++;
			}
			return [{
				applied: didApply,
				consumed_proposal: !!current,
				proposal_time_zone: current?.timeZone ?? null,
			}];
		}
		if (query.includes('SELECT proposal_thread_id, proposal_message_id')) {
			return proposal
				? [{ proposal_message_id: proposal.messageId, proposal_thread_id: proposal.threadId }]
				: [];
		}
		if (query.includes('SELECT notification_thread_id, notification_message_id')) {
			return notification
				? [{
						notification_message_id: notification.messageId,
						notification_override_time_zone: notification.overrideTimeZone,
						notification_thread_id: notification.threadId,
					}]
				: [];
		}
		if (query.includes('SET notification_thread_id = NULL')) {
			const [threadId, messageId] = values as [string, string];
			if (notification?.threadId === threadId && notification.messageId === messageId)
				notification = undefined;
			return [];
		}
		if (query.includes('SELECT override_time_zone'))
			return [{ override_time_zone: override ?? null }];
		if (query.includes('INSERT INTO operator_time_zone')) {
			if (values.length)
				override = values[0] as string | null;
			return [];
		}
		return [];
	}) as SqlLike;
	sql.begin = async (operation) => {
		const snapshot = {
			applied,
			lastMessage: lastMessage && { ...lastMessage },
			notification: notification && { ...notification },
			override,
			proposal: proposal && { ...proposal },
		};
		try {
			return await operation(sql);
		} catch (error) {
			applied = snapshot.applied;
			lastMessage = snapshot.lastMessage;
			notification = snapshot.notification;
			override = snapshot.override;
			proposal = snapshot.proposal;
			throw error;
		}
	};
	return {
		applied: () => applied,
		notification: () => notification && { ...notification },
		override: () => override,
		proposal: () => proposal && {
			messageId: proposal.messageId,
			threadId: proposal.threadId,
			timeZone: proposal.timeZone,
		},
		sql,
	};
}

async function seedProposal(
	fixture: ReturnType<typeof memorySql>,
	timeZone: string,
	messageId: string,
	dateSent?: Date,
): Promise<Message> {
	const context = makeHandlerContext();
	const message = makeMessage(`Use ${timeZone}`, operatorNumber, messageId, directThreadId, dateSent);
	await handleSendblueDirectMessage(
		makeThread([]),
		message,
		async () => { await proposeOperatorTimeZoneChange(timeZone, context.requestContext, fixture.sql); },
		context,
		fixture.sql,
	);
	return message;
}

describe('Sendblue error formatting', () => {
	test('renders the model-auth sentinel as an actionable message', () => {
		const error = new Error(`wrapped: ${MODEL_AUTH_FAILURE} raw-provider-text test-access-token test-refresh-token`);

		expect(formatSendblueError(error)).toBe(CODEX_AUTH_CHANNEL_ERROR);
		expect(formatSendblueError(error)).not.toMatch(/raw-provider-text|access-token|refresh-token/);
	});

	test('hides every other error', () => {
		expect(formatSendblueError(new Error('provider response contained a credential'))).toBe(GENERIC_CHANNEL_ERROR);
	});
});

describe('Sendblue request correlation', () => {
	test('a completed silent run gets one safe fallback and a recorded reply-generation failure', async () => {
		const fixture = memorySql();
		const spans: AnyExportedSpan[] = [];
		const observability = captureObservability(spans);
		const replies: string[] = [];
		const incoming = makeMessage('private smoke request');
		await handleSendblueDirectMessage(makeThread(replies), incoming, async () => {}, makeHandlerContext(observability), fixture.sql);
		await observability.flush();
		expect(replies).toEqual([EMPTY_REPLY_CHANNEL_ERROR]);
		const channel = spans.find(span => span.name === SENDBLUE_CHANNEL_SPAN_NAME)!;
		expect(channel.metadata).toEqual({ [SENDBLUE_CORRELATION_KEY]: hashSendblueMessageHandle(incoming.id), stage: 'reply_generation', classification: 'failed' });
		expect(channel.errorInfo).toBeDefined();
		expect(JSON.stringify(channel)).not.toContain('private smoke request');
		const failedContext = makeHandlerContext(observability);
		const failed = makeMessage('another private smoke', operatorNumber, 'failed-fallback');
		const failedReplies: string[] = [];
		await expect(handleSendblueDirectMessage(
			makeThread(failedReplies, async () => { throw new Error('private provider diagnostic'); }),
			failed,
			async () => {},
			failedContext,
			fixture.sql,
		)).rejects.toThrow('private provider diagnostic');
		await observability.flush();
		expect(failedReplies).toEqual([EMPTY_REPLY_CHANNEL_ERROR]);
		expect(getSendblueChannelCapability(failedContext.requestContext)).toBeUndefined();
		const failedSpan = spans.find(span => span.metadata?.[SENDBLUE_CORRELATION_KEY] === hashSendblueMessageHandle(failed.id))!;
		expect(failedSpan.metadata).toMatchObject({ stage: 'reply_delivery', classification: 'failed' });
		expect(JSON.stringify(failedSpan)).not.toMatch(/private provider diagnostic|another private smoke/);
		await observability.shutdown();
	});
	test('hashes provider handles deterministically without sharing correlation', () => {
		const first = hashSendblueMessageHandle('provider-message-1');

		expect(first).toBe(hashSendblueMessageHandle('provider-message-1'));
		expect(first).not.toBe(hashSendblueMessageHandle('provider-message-2'));
		expect(first).toMatch(/^[a-f\d]{64}$/);
		expect(first).not.toContain('provider-message-1');
	});

	test('binds the live thread and message only to the authenticated request context', async () => {
		const fixture = memorySql();
		const contexts = [makeHandlerContext(), makeHandlerContext()];
		const messages = [
			makeMessage('first', operatorNumber, 'provider-message-a'),
			makeMessage('second', operatorNumber, 'provider-message-b'),
		];
		const seen: unknown[] = [];

		await Promise.all(messages.map((message, index) => handleSendblueDirectMessage(
			makeThread([]),
			message,
			async (thread) => {
				const capability = getSendblueChannelCapability(contexts[index]!.requestContext);
				const unrelated = getSendblueChannelCapability(contexts[1 - index]!.requestContext);
				seen.push(capability);
				expect(capability?.message).toBe(message);
				expect(capability?.thread).toBe(thread);
				if (unrelated) {
					expect(unrelated.message).toBe(messages[1 - index]);
					expect(unrelated).not.toBe(capability);
				}
			},
			contexts[index],
			fixture.sql,
		)));

		expect(seen).toHaveLength(2);
		expect(contexts.map(context => context.requestContext.getRaw(SENDBLUE_CORRELATION_KEY))).toEqual(
			messages.map(message => hashSendblueMessageHandle(message.id)),
		);
		expect(contexts[0]!.requestContext.getRaw(SENDBLUE_CORRELATION_KEY))
			.not
			.toBe(contexts[1]!.requestContext.getRaw(SENDBLUE_CORRELATION_KEY));
		for (const context of contexts)
			expect(getSendblueChannelCapability(context.requestContext)).toBeUndefined();

		const forged = new RequestContext();
		forged.setRaw(SENDBLUE_CORRELATION_KEY, hashSendblueMessageHandle('forged'));
		expect(getSendblueChannelCapability(forged)).toBeUndefined();
	});

	test('does not correlate rejected, malformed, or missing-context messages', async () => {
		const fixture = memorySql();
		for (const [thread, message] of [
			[makeThread([]), makeMessage('not operator', '+15555550999')],
			[makeThread([], undefined, { adapterName: 'slack' }), makeMessage('wrong adapter')],
			[makeThread([], undefined, { isDM: false }), makeMessage('group')],
		] as const) {
			const context = makeHandlerContext();
			await handleSendblueDirectMessage(thread, message, async () => {}, context, fixture.sql);
			expect(context.requestContext.getRaw(SENDBLUE_CORRELATION_KEY)).toBeUndefined();
			expect(getSendblueChannelCapability(context.requestContext)).toBeUndefined();
		}

		for (const id of ['', '   ']) {
			const malformedContext = makeHandlerContext();
			const malformed = makeMessage('malformed', operatorNumber, id, directThreadId);
			await handleSendblueDirectMessage(makeThread([]), malformed, async () => {
				expect(getSendblueChannelCapability(malformedContext.requestContext)).toBeUndefined();
			}, malformedContext, fixture.sql);
			expect(malformedContext.requestContext.getRaw(SENDBLUE_CORRELATION_KEY)).toBeUndefined();
		}

		let missingContextCalls = 0;
		await handleSendblueDirectMessage(
			makeThread([]),
			makeMessage('missing context'),
			async () => { missingContextCalls++; },
			undefined,
			fixture.sql,
		);
		expect(missingContextCalls).toBe(1);
	});

	test('records only fixed channel outcomes and never raw failure details', async () => {
		const fixture = memorySql();
		const spans: AnyExportedSpan[] = [];
		const observability = captureObservability(spans);

		const deliveredContext = makeHandlerContext(observability);
		const delivered = makeMessage('private operator text', operatorNumber, 'raw-provider-handle-delivered');
		const failedContext = makeHandlerContext(observability);
		const failed = makeMessage('another private text', operatorNumber, 'raw-provider-handle-failed');
		await Promise.all([
			handleSendblueDirectMessage(
				makeThread([]),
				delivered,
				async thread => void await thread.post('private reply text'),
				deliveredContext,
				fixture.sql,
			),
			expect(handleSendblueDirectMessage(
				makeThread([], async () => { throw new Error('raw provider failure body'); }),
				failed,
				async thread => void await thread.post('reply that fails'),
				failedContext,
				fixture.sql,
			)).rejects.toThrow('raw provider failure body'),
		]);

		await observability.flush();
		const channelSpans = spans.filter(span => span.name === SENDBLUE_CHANNEL_SPAN_NAME);
		expect(new Set(channelSpans.map(span => span.traceId)).size).toBe(2);
		expect(channelSpans.map(span => span.metadata)).toEqual([
			{
				[SENDBLUE_CORRELATION_KEY]: hashSendblueMessageHandle(delivered.id),
				stage: 'reply_delivery',
				classification: 'delivered',
			},
			{
				[SENDBLUE_CORRELATION_KEY]: hashSendblueMessageHandle(failed.id),
				stage: 'reply_delivery',
				classification: 'failed',
			},
		]);
		expect(JSON.stringify(channelSpans)).not.toMatch(
			/raw-provider-handle|private operator text|private reply text|another private text|reply that fails|raw provider failure body|15555550101/,
		);
		await observability.shutdown();
	});

	test('records pre-agent failures as fixed channel-intake failures', async () => {
		const spans: AnyExportedSpan[] = [];
		const observability = captureObservability(spans);
		const context = makeHandlerContext(observability);
		const incoming = makeMessage('private operator text', operatorNumber, 'raw-provider-handle-intake');
		const failingSql = (async () => {
			throw new Error('raw storage failure body');
		}) as SqlLike;
		let defaultCalls = 0;

		await expect(handleSendblueDirectMessage(
			makeThread([]),
			incoming,
			async () => { defaultCalls++; },
			context,
			failingSql,
		)).rejects.toThrow('raw storage failure body');

		await observability.flush();
		const channelSpan = spans.find(span => span.name === SENDBLUE_CHANNEL_SPAN_NAME);
		expect(defaultCalls).toBe(0);
		expect(channelSpan?.metadata).toEqual({
			[SENDBLUE_CORRELATION_KEY]: hashSendblueMessageHandle(incoming.id),
			stage: 'channel_intake',
			classification: 'failed',
		});
		expect(JSON.stringify(channelSpan)).not.toMatch(
			/raw-provider-handle|private operator text|raw storage failure body|15555550101/,
		);
		await observability.shutdown();
	});
});

describe('Jamis new session command', () => {
	async function fixture(observability?: Observability) {
		const storage = new InMemoryStore();
		const memory = (await storage.getStore('memory'))!;
		const mastra = new Mastra({ storage, observability, logger: false });
		return { memory, context: () => ({ mastra, requestContext: new RequestContext(), signalMetadata: {} }) };
	}

	test('recognizes only the trimmed exact command and never stores it or invokes the agent', async () => {
		const sessions = await fixture();
		const timeZone = memorySql();
		const replies: string[] = [];
		const thread = makeThread(replies);
		let defaultCalls = 0;
		for (const text of ['/new', ' /new\n', '\t/new ']) {
			await handleSendblueDirectMessage(thread, makeMessage(text, operatorNumber, `command-${text}`), async () => {
				defaultCalls++;
			}, sessions.context(), timeZone.sql);
		}
		expect(defaultCalls).toBe(0);
		expect(replies).toEqual([NEW_SESSION_SUCCESS, NEW_SESSION_SUCCESS, NEW_SESSION_SUCCESS]);
		const { threads } = await sessions.memory.listThreads({});
		expect(threads).toHaveLength(3);
		for (const stored of threads)
			expect((await sessions.memory.listMessages({ threadId: stored.id })).total).toBe(0);

		for (const text of ['/NEW', '/New', '/new now', 'please /new', '/new!']) {
			await handleSendblueDirectMessage(thread, makeMessage(text, operatorNumber, `ordinary-${text}`), async () => {
				defaultCalls++;
			}, sessions.context(), timeZone.sql);
		}
		expect(defaultCalls).toBe(5);
		expect((await sessions.memory.listThreads({})).total).toBe(3);
	});

	test('rejects nonoperator, adapter, group, and invalid source scope without rotating', async () => {
		const sessions = await fixture();
		const timeZone = memorySql();
		const replies: string[] = [];
		let defaultCalls = 0;
		for (const [thread, message] of [
			[makeThread(replies), makeMessage('/new', '+15555550999')],
			[makeThread(replies, undefined, { adapterName: 'slack' }), makeMessage('/new')],
			[makeThread(replies, undefined, { isDM: false }), makeMessage('/new')],
		] as const) {
			await handleSendblueDirectMessage(thread, message, async () => {
				defaultCalls++;
			}, sessions.context(), timeZone.sql);
		}
		expect(replies).toEqual([]);
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		try {
			for (const message of [makeMessage('/new', operatorNumber, ''), makeMessage('/new', operatorNumber, 'wrong-thread', 'different-thread')]) {
				await handleSendblueDirectMessage(makeThread(replies), message, async () => {
					defaultCalls++;
				}, sessions.context(), timeZone.sql);
			}
		} finally {
			errors.mockRestore();
		}
		expect(defaultCalls).toBe(0);
		expect(replies).toEqual([GENERIC_CHANNEL_ERROR, GENERIC_CHANNEL_ERROR]);
		expect((await sessions.memory.listThreads({})).total).toBe(0);
	});

	test('awaits the durable write before confirming', async () => {
		const sessions = await fixture();
		const timeZone = memorySql();
		const replies: string[] = [];
		const save = sessions.memory.saveThread.bind(sessions.memory);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const write = spyOn(sessions.memory, 'saveThread').mockImplementation(async (args) => {
			started.resolve();
			await release.promise;
			return await save(args);
		});
		const command = handleSendblueDirectMessage(makeThread(replies), makeMessage('/new'), async () => {
			throw new Error('command reached the agent');
		}, sessions.context(), timeZone.sql);
		try {
			await started.promise;
			expect(replies).toEqual([]);
			expect((await sessions.memory.listThreads({})).total).toBe(0);
		} finally {
			release.resolve();
			await command;
			write.mockRestore();
		}
		expect(replies).toEqual([NEW_SESSION_SUCCESS]);
		expect((await sessions.memory.listThreads({})).total).toBe(1);
	});

	test('cancels old proposals and monitoring targets, retains settings, and preserves later state on replays', async () => {
		const sessions = await fixture();
		const timeZone = memorySql('America/Chicago');
		await seedProposal(timeZone, 'Asia/Tokyo', 'old-proposal');
		stageDeploymentSnapshot(directThreadId, 'old-monitoring', {} as never, []);
		settleDeploymentSnapshotReply(directThreadId, 'old-monitoring', true);
		const replies: string[] = [];
		const thread = makeThread(replies);
		const first = makeMessage('/new', operatorNumber, 'new-first');
		await handleSendblueDirectMessage(thread, first, async () => {
			throw new Error('command reached the agent');
		}, sessions.context(), timeZone.sql);
		expect(timeZone.proposal()).toBeUndefined();
		expect(timeZone.override()).toBe('America/Chicago');
		expect(getDeploymentSnapshot(directThreadId, 'old-monitoring')).toBeUndefined();

		// The first ordinary message shares the command's provider timestamp.
		await seedProposal(timeZone, 'America/Denver', 'later-proposal', first.metadata.dateSent);
		stageDeploymentSnapshot(directThreadId, 'later-monitoring', {} as never, []);
		settleDeploymentSnapshotReply(directThreadId, 'later-monitoring', true);
		await handleSendblueDirectMessage(thread, first, async () => {
			throw new Error('replay reached the agent');
		}, sessions.context(), timeZone.sql);
		expect(timeZone.proposal()?.messageId).toBe('later-proposal');
		expect(getDeploymentSnapshot(directThreadId, 'later-monitoring')).toBeDefined();
		expect((await sessions.memory.listThreads({})).total).toBe(1);

		const second = makeMessage('/new', operatorNumber, 'new-second');
		await handleSendblueDirectMessage(thread, second, async () => {}, sessions.context(), timeZone.sql);
		await seedProposal(timeZone, 'Asia/Tokyo', 'latest-proposal', second.metadata.dateSent);
		stageDeploymentSnapshot(directThreadId, 'latest-monitoring', {} as never, []);
		settleDeploymentSnapshotReply(directThreadId, 'latest-monitoring', true);
		const repliesBeforeReplay = replies.slice();
		await handleSendblueDirectMessage(thread, first, async () => {
			throw new Error('superseded command reached the agent');
		}, sessions.context(), timeZone.sql);
		expect(replies).toEqual(repliesBeforeReplay);
		expect(timeZone.proposal()?.messageId).toBe('latest-proposal');
		expect(getDeploymentSnapshot(directThreadId, 'latest-monitoring')).toBeDefined();
		expect(timeZone.override()).toBe('America/Chicago');
		expect((await sessions.memory.listThreads({})).total).toBe(2);
	});

	test('delivers an already-applied setting notification before rollover and retains its override', async () => {
		const sessions = await fixture();
		const timeZone = memorySql();
		await seedProposal(timeZone, 'Asia/Tokyo', 'applied-proposal');
		const confirmation = makeMessage('yes', operatorNumber, 'applied-confirmation');
		await consumePendingOperatorTimeZoneChange(directThreadId, confirmation.id, confirmation.metadata.dateSent, true, timeZone.sql);
		expect(timeZone.notification()).toBeDefined();
		const replies: string[] = [];
		const command = makeMessage('/new', operatorNumber, 'new-after-applied-setting');
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		try {
			await handleSendblueDirectMessage(makeThread([], async () => {
				throw new Error('private setting notification failure');
			}), command, async () => {}, sessions.context(), timeZone.sql);
			expect(timeZone.notification()).toBeDefined();
			expect((await sessions.memory.listThreads({})).total).toBe(0);
			expect(errors.mock.calls).toEqual([['[jamis-dm-session] Setting notification acceptance failed.']]);
		} finally {
			errors.mockRestore();
		}
		await handleSendblueDirectMessage(makeThread(replies), command, async () => {
			throw new Error('command reached the agent');
		}, sessions.context(), timeZone.sql);
		expect(replies).toEqual(['Operator time zone changed to Asia/Tokyo (override).', NEW_SESSION_SUCCESS]);
		expect(timeZone.notification()).toBeUndefined();
		expect(timeZone.override()).toBe('Asia/Tokyo');
	});

	test('reports storage failures without success, including a committed write with a lost acknowledgement', async () => {
		const spans: AnyExportedSpan[] = [];
		const observability = captureObservability(spans);
		const sessions = await fixture(observability);
		const timeZone = memorySql();
		const replies: string[] = [];
		const thread = makeThread(replies);
		const old = await sessions.memory.saveThread({ thread: {
			id: 'previous-session',
			resourceId: 'same-operator',
			title: 'Previous session',
			createdAt: new Date('2020-01-01T00:00:00.000Z'),
			updatedAt: new Date('2020-01-01T00:00:00.000Z'),
			metadata: { channel_platform: 'sendblue', channel_externalThreadId: thread.id, channel_externalChannelId: thread.channelId, channel_ownerId: 'jamis' },
		} });
		const command = makeMessage('/new');
		const save = sessions.memory.saveThread.bind(sessions.memory);
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		let write = spyOn(sessions.memory, 'saveThread').mockRejectedValue(new Error('private storage failure'));
		try {
			await handleSendblueDirectMessage(thread, command, async () => {
				throw new Error('command reached the agent');
			}, sessions.context(), timeZone.sql);
			expect(replies).toEqual([GENERIC_CHANNEL_ERROR]);
			expect((await sessions.memory.listThreads({})).threads).toEqual([old]);
			write.mockRestore();
			write = spyOn(sessions.memory, 'saveThread').mockImplementation(async (args) => {
				await save(args);
				throw new Error('private lost acknowledgement');
			});
			await handleSendblueDirectMessage(thread, command, async () => {}, sessions.context(), timeZone.sql);
			expect(replies).toEqual([GENERIC_CHANNEL_ERROR, GENERIC_CHANNEL_ERROR]);
			expect((await sessions.memory.listThreads({})).total).toBe(2);
			write.mockRestore();
			await handleSendblueDirectMessage(thread, command, async () => {}, sessions.context(), timeZone.sql);
			expect(replies.at(-1)).toBe(NEW_SESSION_SUCCESS);
			expect((await sessions.memory.listThreads({})).total).toBe(2);
			expect(await sessions.memory.getThreadById({ threadId: old.id })).toEqual(old);
			const failingSql = (async () => {
				throw new Error('private setting storage failure');
			}) as SqlLike;
			await handleSendblueDirectMessage(thread, makeMessage('/new', operatorNumber, 'new-with-unavailable-setting-storage'), async () => {}, sessions.context(), failingSql);
			expect(replies.at(-1)).toBe(GENERIC_CHANNEL_ERROR);
			expect((await sessions.memory.listThreads({})).total).toBe(2);
			write = spyOn(sessions.memory, 'saveThread').mockRejectedValue(new Error('private storage failure'));
			await expect(handleSendblueDirectMessage(makeThread([], async () => {
				throw new Error('private error reply failure');
			}), makeMessage('/new', operatorNumber, 'new-with-failed-error-reply'), async () => {}, sessions.context(), timeZone.sql)).rejects.toThrow('private error reply failure');
			await observability.flush();
			expect(spans.filter(span => span.name === SENDBLUE_CHANNEL_SPAN_NAME).map(span => [span.metadata?.stage, span.metadata?.classification])).toEqual([
				['channel_intake', 'failed'],
				['channel_intake', 'failed'],
				['reply_delivery', 'delivered'],
				['channel_intake', 'failed'],
				['reply_delivery', 'failed'],
			]);
			expect(errors.mock.calls.flat().join(' ')).not.toContain('private');
		} finally {
			write.mockRestore();
			errors.mockRestore();
			await observability.shutdown();
		}
	});

	test('keeps the new session on confirmation failure and records reply acceptance failure', async () => {
		const spans: AnyExportedSpan[] = [];
		const observability = captureObservability(spans);
		const sessions = await fixture(observability);
		const timeZone = memorySql();
		const replies: string[] = [];
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		const command = makeMessage('/new');
		try {
			await handleSendblueDirectMessage(makeThread(replies, async () => {
				throw new Error('private Sendblue failure');
			}), command, async () => {}, sessions.context(), timeZone.sql);
			await observability.flush();
			expect(spans.find(span => span.name === SENDBLUE_CHANNEL_SPAN_NAME)?.metadata).toMatchObject({ stage: 'reply_delivery', classification: 'failed' });
			expect(errors.mock.calls).toEqual([['[jamis-dm-session] Session started; confirmation acceptance failed.']]);
			expect((await sessions.memory.listThreads({})).total).toBe(1);
			await handleSendblueDirectMessage(makeThread(replies), command, async () => {}, sessions.context(), timeZone.sql);
			expect(replies).toEqual([NEW_SESSION_SUCCESS, NEW_SESSION_SUCCESS]);
			expect((await sessions.memory.listThreads({})).total).toBe(1);
		} finally {
			errors.mockRestore();
			await observability.shutdown();
		}
	});
});

describe('OpenAI login command routing', () => {
	test('normalizes outer whitespace and case but rejects near matches', () => {
		for (const text of ['login openai', ' LOGIN OPENAI\n', '\tLogin OpenAI '])
			expect(isOpenAILoginCommand(makeMessage(text))).toBe(true);
		for (const text of ['login  openai', 'login openai now', 'please login openai', 'login openai!'])
			expect(isOpenAILoginCommand(makeMessage(text))).toBe(false);
	});

	test('ignores non-operators before command handling', async () => {
		const messages: string[] = [];
		let defaultCalls = 0;
		await handleSendblueDirectMessage(
			makeThread(messages),
			makeMessage('login openai', '+15555550999'),
			async () => { defaultCalls++; },
		);

		expect(messages).toEqual([]);
		expect(defaultCalls).toBe(0);
	});

	test('routes every other operator message through the model', async () => {
		const fixture = memorySql();
		const messages: string[] = [];
		let defaultCalls = 0;
		await handleSendblueDirectMessage(
			makeThread(messages),
			makeMessage('login openai now'),
			async () => { defaultCalls++; },
			undefined,
			fixture.sql,
		);

		expect(messages).toEqual([EMPTY_REPLY_CHANNEL_ERROR]);
		expect(defaultCalls).toBe(1);
	});
});

describe('operator time zone change routing', () => {
	test('binds a validated proposal to the authenticated operator DM and source message', async () => {
		const fixture = memorySql();
		const context = makeHandlerContext();
		const messages: string[] = [];
		let result: unknown;

		await handleSendblueDirectMessage(
			makeThread(messages),
			makeMessage('I\'m in Denver', operatorNumber, 'proposal-1'),
			async () => {
				result = await proposeOperatorTimeZoneChange('America/Denver', context.requestContext, fixture.sql);
			},
			context,
			fixture.sql,
		);

		expect(result).toEqual({ status: 'proposed' });
		expect(messages).toEqual([
			'Proposed operator time zone: America/Denver. Reply yes to confirm; any other reply cancels.',
		]);
		expect(fixture.proposal()).toEqual({
			messageId: 'proposal-1',
			threadId: directThreadId,
			timeZone: 'America/Denver',
		});
		expect(fixture.override()).toBeUndefined();
	});

	test('rejects invalid proposals before writing', async () => {
		const fixture = memorySql();
		const context = makeHandlerContext();
		const messages: string[] = [];
		let result: unknown;

		await handleSendblueDirectMessage(
			makeThread(messages),
			makeMessage('Use Mars time', operatorNumber, 'proposal-invalid'),
			async () => {
				result = await proposeOperatorTimeZoneChange('Mars/Olympus_Mons', context.requestContext, fixture.sql);
			},
			context,
			fixture.sql,
		);

		expect(result).toEqual({ status: 'rejected' });
		expect(messages).toEqual(['Invalid operator time zone: "Mars/Olympus_Mons". Nothing was proposed.']);
		expect(fixture.proposal()).toBeUndefined();
	});

	test('denies non-Sendblue, group, nonoperator, missing-context, forged, and direct tool calls', async () => {
		const fixture = memorySql();
		let defaultCalls = 0;
		for (const thread of [
			makeThread([], undefined, { adapterName: 'slack' }),
			makeThread([], undefined, { isDM: false }),
		]) {
			await handleSendblueDirectMessage(
				thread,
				makeMessage('Use America/Denver'),
				async () => { defaultCalls++; },
				makeHandlerContext(),
				fixture.sql,
			);
		}
		await handleSendblueDirectMessage(
			makeThread([]),
			makeMessage('Use America/Denver', '+15555550999'),
			async () => { defaultCalls++; },
			makeHandlerContext(),
			fixture.sql,
		);

		const missing = await proposeOperatorTimeZoneChange('America/Denver', new RequestContext(), fixture.sql);
		const forgedContext = new RequestContext();
		forgedContext.setRaw('__jamis_operator_time_zone_channel', {
			messageId: 'forged',
			threadId: directThreadId,
		});
		const forged = await proposeOperatorTimeZoneChange('America/Denver', forgedContext, fixture.sql);
		const direct = await operatorTimeZoneChangeTool.execute!(
			{ timeZone: 'America/Denver' },
			{ requestContext: new RequestContext() } as never,
		);
		const subagentContext = makeHandlerContext();
		let subagent: unknown;
		await handleSendblueDirectMessage(
			makeThread([]),
			makeMessage('Use America/Denver', operatorNumber, 'subagent-proposal'),
			async () => {
				subagent = await operatorTimeZoneChangeTool.execute!(
					{ timeZone: 'America/Denver' },
					{ agent: { agentId: 'weather-agent' }, requestContext: subagentContext.requestContext } as never,
				);
			},
			subagentContext,
			fixture.sql,
		);

		expect(defaultCalls).toBe(0);
		expect(missing).toEqual({ status: 'denied' });
		expect(forged).toEqual({ status: 'denied' });
		expect(direct).toEqual({ status: 'denied' });
		expect(subagent).toEqual({ status: 'denied' });
		expect(fixture.proposal()).toBeUndefined();
	});

	test('does not confirm without Mastra channel context', async () => {
		const fixture = memorySql();
		await seedProposal(fixture, 'America/Denver', 'proposal-missing-context');

		let defaultCalls = 0;
		await handleSendblueDirectMessage(
			makeThread([]),
			makeMessage('yes', operatorNumber, 'confirm-missing-context'),
			async () => { defaultCalls++; },
			undefined,
			fixture.sql,
		);

		expect(defaultCalls).toBe(1);
		expect(fixture.applied()).toBe(0);
		expect(fixture.proposal()?.messageId).toBe('proposal-missing-context');
	});

	test('rolls back a proposal when the channel post fails', async () => {
		const fixture = memorySql();
		const context = makeHandlerContext();
		await expect(handleSendblueDirectMessage(
			makeThread([], async () => { throw new Error('post failed'); }),
			makeMessage('Use America/Denver', operatorNumber, 'proposal-post-failed'),
			async () => { await proposeOperatorTimeZoneChange('America/Denver', context.requestContext, fixture.sql); },
			context,
			fixture.sql,
		)).rejects.toThrow('post failed');

		let defaultCalls = 0;
		await handleSendblueDirectMessage(
			makeThread([]),
			makeMessage('yes', operatorNumber, 'confirm-post-failed'),
			async () => { defaultCalls++; },
			makeHandlerContext(),
			fixture.sql,
		);

		expect(fixture.proposal()).toBeUndefined();
		expect(fixture.applied()).toBe(0);
		expect(defaultCalls).toBe(1);
	});

	test('declines and clears the pending proposal', async () => {
		const fixture = memorySql();
		await seedProposal(fixture, 'America/Denver', 'proposal-2');

		const context = makeHandlerContext();
		const decline = makeMessage('no', operatorNumber, 'decline-1');
		const messages: string[] = [];
		let defaultCalls = 0;
		await handleSendblueDirectMessage(
			makeThread(messages, async () => {
				expect(getSendblueChannelCapability(context.requestContext)?.message).toBe(decline);
			}),
			decline,
			async () => { defaultCalls++; },
			context,
			fixture.sql,
		);

		expect(messages).toEqual(['Operator time zone change declined.']);
		expect(defaultCalls).toBe(0);
		expect(context.requestContext.getRaw(SENDBLUE_CORRELATION_KEY)).toBe(hashSendblueMessageHandle(decline.id));
		expect(getSendblueChannelCapability(context.requestContext)).toBeUndefined();
		expect(fixture.proposal()).toBeUndefined();
		expect(fixture.override()).toBeUndefined();
	});

	test('an unrelated next message clears the proposal and a later yes cannot revive it', async () => {
		const fixture = memorySql();
		await seedProposal(fixture, 'America/Denver', 'proposal-3');

		let defaultCalls = 0;
		for (const [text, id] of [['what time is it?', 'unrelated-1'], ['yes', 'late-yes']] as const) {
			await handleSendblueDirectMessage(
				makeThread([]),
				makeMessage(text, operatorNumber, id),
				async () => { defaultCalls++; },
				makeHandlerContext(),
				fixture.sql,
			);
		}

		expect(defaultCalls).toBe(2);
		expect(fixture.proposal()).toBeUndefined();
		expect(fixture.override()).toBeUndefined();
	});

	test('an unrelated change request cancels and replaces the pending proposal', async () => {
		const fixture = memorySql();
		await seedProposal(fixture, 'America/Denver', 'proposal-replaced');
		await seedProposal(fixture, 'Asia/Tokyo', 'proposal-replacement');

		expect(fixture.proposal()?.timeZone).toBe('Asia/Tokyo');
	});

	test('an older or replayed yes cannot confirm a later proposal', async () => {
		const fixture = memorySql();
		const oldYes = makeMessage('yes', operatorNumber, 'old-yes', directThreadId, new Date('2030-01-01T00:00:00.000Z'));
		let defaultCalls = 0;
		await handleSendblueDirectMessage(
			makeThread([]),
			oldYes,
			async () => { defaultCalls++; },
			makeHandlerContext(),
			fixture.sql,
		);

		await seedProposal(fixture, 'America/Denver', 'proposal-after-old-yes', new Date('2030-01-01T00:01:00.000Z'));
		await handleSendblueDirectMessage(
			makeThread([]),
			oldYes,
			async () => { defaultCalls++; },
			makeHandlerContext(),
			fixture.sql,
		);

		const delayedYes = makeMessage('yes', operatorNumber, 'delayed-old-yes', directThreadId, new Date('2030-01-01T00:00:30.000Z'));
		await handleSendblueDirectMessage(
			makeThread([]),
			delayedYes,
			async () => { defaultCalls++; },
			makeHandlerContext(),
			fixture.sql,
		);

		expect(defaultCalls).toBe(1);
		expect(fixture.applied()).toBe(0);
		expect(fixture.proposal()?.timeZone).toBe('America/Denver');
	});

	test('provider history rejects a reordered yes with an intervening operator message', async () => {
		const fixture = memorySql();
		await seedProposal(fixture, 'America/Denver', 'proposal-before-gap', new Date('2030-01-01T00:00:00.000Z'));
		makeMessage('what time is it?', operatorNumber, 'intervening-gap', directThreadId, new Date('2030-01-01T00:01:00.000Z'));
		const yes = makeMessage('yes', operatorNumber, 'confirm-after-gap', directThreadId, new Date('2030-01-01T00:02:00.000Z'));
		const messages: string[] = [];

		await handleSendblueDirectMessage(makeThread(messages), yes, async () => {}, makeHandlerContext(), fixture.sql);

		expect(messages).toEqual(['Operator time zone change canceled.']);
		expect(fixture.override()).toBeUndefined();
		expect(fixture.proposal()).toBeUndefined();
	});

	test('does not create a proposal after a newer message was already processed', async () => {
		const fixture = memorySql();
		const proposal = makeMessage('Use America/Denver', operatorNumber, 'proposal-delayed', directThreadId, new Date('2030-01-01T00:00:00.000Z'));
		const yes = makeMessage('yes', operatorNumber, 'yes-before-proposal-handler', directThreadId, new Date('2030-01-01T00:01:00.000Z'));
		await handleSendblueDirectMessage(makeThread([]), yes, async () => {}, makeHandlerContext(), fixture.sql);

		const context = makeHandlerContext();
		let result: unknown;
		await handleSendblueDirectMessage(
			makeThread([]),
			proposal,
			async () => { result = await proposeOperatorTimeZoneChange('America/Denver', context.requestContext, fixture.sql); },
			context,
			fixture.sql,
		);

		expect(result).toBeUndefined();
		expect(fixture.proposal()).toBeUndefined();
	});

	test('confirms a change only in its source thread and reports the durable override', async () => {
		const fixture = memorySql();
		await seedProposal(fixture, 'America/Denver', 'proposal-4');

		const wrongThreadMessages: string[] = [];
		await handleSendblueDirectMessage(
			makeThread(wrongThreadMessages, undefined, { id: 'sendblue:test-line:other-thread' }),
			makeMessage('yes', operatorNumber, 'wrong-thread-confirm', 'sendblue:test-line:other-thread'),
			async () => {},
			makeHandlerContext(),
			fixture.sql,
		);
		expect(fixture.override()).toBeUndefined();
		expect(fixture.proposal()).toBeUndefined();
	});

	test('confirms a change once and suppresses its replay', async () => {
		const fixture = memorySql();
		await seedProposal(fixture, 'America/Denver', 'proposal-5');

		const messages: string[] = [];
		let replayDefaultCalls = 0;
		const confirmation = makeMessage('yes', operatorNumber, 'confirm-1');
		await handleSendblueDirectMessage(makeThread(messages), confirmation, async () => {}, makeHandlerContext(), fixture.sql);
		await handleSendblueDirectMessage(
			makeThread(messages),
			confirmation,
			async () => { replayDefaultCalls++; },
			makeHandlerContext(),
			fixture.sql,
		);

		expect(messages).toEqual([
			'Operator time zone changed to America/Denver (override).',
		]);
		expect(replayDefaultCalls).toBe(0);
		expect(fixture.override()).toBe('America/Denver');
		expect(fixture.applied()).toBe(1);
	});

	test('retries a persisted confirmation notification after post failure', async () => {
		const fixture = memorySql();
		await seedProposal(fixture, 'America/Denver', 'proposal-notification-retry');
		const confirmation = makeMessage('yes', operatorNumber, 'confirm-notification-retry');

		await expect(handleSendblueDirectMessage(
			makeThread([], async () => { throw new Error('post failed'); }),
			confirmation,
			async () => {},
			makeHandlerContext(),
			fixture.sql,
		)).rejects.toThrow('post failed');
		expect(fixture.override()).toBe('America/Denver');
		expect(fixture.notification()?.messageId).toBe('confirm-notification-retry');

		const messages: string[] = [];
		let defaultCalls = 0;
		await handleSendblueDirectMessage(
			makeThread(messages),
			confirmation,
			async () => { defaultCalls++; },
			makeHandlerContext(),
			fixture.sql,
		);

		expect(messages).toEqual(['Operator time zone changed to America/Denver (override).']);
		expect(defaultCalls).toBe(0);
		expect(fixture.notification()).toBeUndefined();
	});

	test('replayed proposal and confirmation IDs cannot revive or clear later state', async () => {
		const fixture = memorySql();
		const firstProposal = await seedProposal(fixture, 'America/Denver', 'proposal-replay');
		const firstConfirmation = makeMessage('yes', operatorNumber, 'confirm-replay');
		await handleSendblueDirectMessage(
			makeThread([]),
			firstConfirmation,
			async () => {},
			makeHandlerContext(),
			fixture.sql,
		);

		const replayContext = makeHandlerContext();
		let replayResult: unknown;
		await handleSendblueDirectMessage(
			makeThread([]),
			firstProposal,
			async () => { replayResult = await proposeOperatorTimeZoneChange('America/Denver', replayContext.requestContext, fixture.sql); },
			replayContext,
			fixture.sql,
		);
		expect(replayResult).toBeUndefined();
		expect(fixture.proposal()).toBeUndefined();

		await seedProposal(fixture, 'Asia/Tokyo', 'proposal-after-replay');
		await handleSendblueDirectMessage(
			makeThread([]),
			firstConfirmation,
			async () => {},
			makeHandlerContext(),
			fixture.sql,
		);
		expect(fixture.proposal()?.timeZone).toBe('Asia/Tokyo');
		expect(fixture.override()).toBe('America/Denver');
	});

	test('confirms reset and reveals the deployment default', async () => {
		const fixture = memorySql('Asia/Tokyo');
		const context = makeHandlerContext();
		let proposal: unknown;
		await handleSendblueDirectMessage(
			makeThread([]),
			makeMessage('Reset my operator time zone', operatorNumber, 'proposal-reset'),
			async () => { proposal = await proposeOperatorTimeZoneChange(null, context.requestContext, fixture.sql); },
			context,
			fixture.sql,
		);

		const messages: string[] = [];
		await handleSendblueDirectMessage(
			makeThread(messages),
			makeMessage('confirm', operatorNumber, 'confirm-reset'),
			async () => {},
			makeHandlerContext(),
			fixture.sql,
		);

		expect(proposal).toEqual({ status: 'proposed' });
		expect(messages).toEqual(['Operator time zone reset to America/Chicago (default).']);
		expect(fixture.override()).toBeNull();
	});

	test('atomically consumes concurrent confirmations once', async () => {
		const fixture = memorySql();
		await seedProposal(fixture, 'America/Denver', 'proposal-6');

		const results = await Promise.all([
			consumePendingOperatorTimeZoneChange(directThreadId, 'confirm-a', new Date('2040-01-01T00:00:00.000Z'), true, fixture.sql),
			consumePendingOperatorTimeZoneChange(directThreadId, 'confirm-b', new Date('2040-01-01T00:00:01.000Z'), true, fixture.sql),
		]);

		expect(results.filter(result => result?.applied)).toHaveLength(1);
		expect(fixture.applied()).toBe(1);
	});

	test('serializes a following confirmation behind proposal completion', async () => {
		const fixture = memorySql();
		const proposalContext = makeHandlerContext();
		let releaseProposal!: () => void;
		const proposalReleased = new Promise<void>(resolve => (releaseProposal = resolve));
		let proposalStarted!: () => void;
		const started = new Promise<void>(resolve => (proposalStarted = resolve));

		const proposal = handleSendblueDirectMessage(
			makeThread([]),
			makeMessage('Use America/Denver', operatorNumber, 'proposal-queued'),
			async () => {
				proposalStarted();
				await proposalReleased;
				await proposeOperatorTimeZoneChange('America/Denver', proposalContext.requestContext, fixture.sql);
			},
			proposalContext,
			fixture.sql,
		);
		await started;

		const messages: string[] = [];
		const confirmation = handleSendblueDirectMessage(
			makeThread(messages),
			makeMessage('yes', operatorNumber, 'confirm-queued'),
			async () => { throw new Error('confirmation reached the model'); },
			makeHandlerContext(),
			fixture.sql,
		);
		await Promise.resolve();
		expect(fixture.applied()).toBe(0);

		releaseProposal();
		await Promise.all([proposal, confirmation]);

		expect(fixture.applied()).toBe(1);
		expect(messages).toEqual(['Operator time zone changed to America/Denver (override).']);
	});
});

describe('OpenAI login flow', () => {
	let tempDir: string;
	let originalCwd: string;
	let originalFetch: typeof globalThis.fetch;
	let originalDateNow: typeof Date.now;
	let originalSetTimeout: typeof globalThis.setTimeout;
	let originalConsoleError: typeof console.error;
	let fetchCalls: string[];
	let errors: string[];

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'sendblue-login-'));
		originalCwd = process.cwd();
		originalFetch = globalThis.fetch;
		originalDateNow = Date.now;
		originalSetTimeout = globalThis.setTimeout;
		originalConsoleError = console.error;
		fetchCalls = [];
		errors = [];
		process.chdir(tempDir);
		console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
	});

	afterEach(async () => {
		console.error = originalConsoleError;
		globalThis.fetch = originalFetch;
		Date.now = originalDateNow;
		globalThis.setTimeout = originalSetTimeout;
		process.chdir(originalCwd);
		await rm(tempDir, { recursive: true, force: true });
	});

	function mockFetch(handler: (url: string) => Response | Promise<Response>): void {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			fetchCalls.push(url);
			return handler(url);
		}) as typeof globalThis.fetch;
	}

	function runTimersImmediately(onTimer?: () => void): void {
		globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
			queueMicrotask(() => {
				onTimer?.();
				callback(...args);
			});
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof globalThis.setTimeout;
	}

	function holdTimers(): () => void {
		let release!: () => void;
		const released = new Promise<void>(resolve => (release = resolve));
		globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
			void released.then(() => callback(...args));
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof globalThis.setTimeout;
		return release;
	}

	function mockSuccessfulDeviceFlow(): void {
		const idToken = `x.${Buffer.from(JSON.stringify({ chatgpt_account_id: 'test-account-secret' })).toString('base64url')}.x`;
		mockFetch((url) => {
			if (url.includes('/deviceauth/usercode'))
				return Response.json({ device_auth_id: 'test-device-auth-secret', user_code: 'ABCD-EFGH', interval: 1 });
			if (url.includes('/deviceauth/token'))
				return Response.json({ authorization_code: 'test-authorization-code-secret', code_verifier: 'test-code-verifier-secret' });
			if (url.includes('/oauth/token')) {
				return Response.json({
					access_token: 'test-access-secret',
					refresh_token: 'test-refresh-secret',
					expires_in: 3600,
					id_token: idToken,
				});
			}
			throw new Error(`unexpected URL: ${url}`);
		});
	}

	test('posts URL/code before polling, suppresses duplicates, and saves only the completed credential', async () => {
		const releasePolling = holdTimers();
		mockSuccessfulDeviceFlow();

		let urlPostStarted!: () => void;
		let releaseUrlPost!: () => void;
		let loginCompleted!: () => void;
		const postStarted = new Promise<void>(resolve => (urlPostStarted = resolve));
		const postReleased = new Promise<void>(resolve => (releaseUrlPost = resolve));
		const completed = new Promise<void>(resolve => (loginCompleted = resolve));
		const fixture = memorySql();
		const loginContext = makeHandlerContext();
		const loginMessage = makeMessage('login openai', operatorNumber, 'login-correlated');
		const duplicateSpans: AnyExportedSpan[] = [];
		const duplicateObservability = captureObservability(duplicateSpans);
		const duplicateContext = makeHandlerContext(duplicateObservability);
		const duplicateMessage = makeMessage('LOGIN OPENAI', operatorNumber, 'login-duplicate');
		const messages: string[] = [];
		const thread = makeThread(messages, async (message) => {
			if (message.startsWith('Open ')) {
				expect(getSendblueChannelCapability(loginContext.requestContext)?.message).toBe(loginMessage);
				urlPostStarted();
				await postReleased;
			}
			if (message === OPENAI_LOGIN_SUCCESS)
				loginCompleted();
		});
		let defaultCalls = 0;
		const defaultHandler = async () => {
			defaultCalls++;
		};

		const login = handleSendblueDirectMessage(thread, loginMessage, defaultHandler, loginContext, fixture.sql);
		await postStarted;
		expect(fetchCalls.filter(url => url.includes('/deviceauth/usercode')).length).toBe(1);
		expect(fetchCalls.some(url => url.includes('/deviceauth/token'))).toBe(false);

		releaseUrlPost();
		await login;
		expect(loginContext.requestContext.getRaw(SENDBLUE_CORRELATION_KEY)).toBe(hashSendblueMessageHandle(loginMessage.id));
		expect(getSendblueChannelCapability(loginContext.requestContext)).toBeUndefined();
		expect(fetchCalls.some(url => url.includes('/deviceauth/token'))).toBe(false);

		await handleSendblueDirectMessage(
			thread,
			duplicateMessage,
			defaultHandler,
			duplicateContext,
			fixture.sql,
		);
		expect(messages[1]).toBe(OPENAI_LOGIN_IN_PROGRESS);
		expect(fetchCalls.filter(url => url.includes('/deviceauth/usercode')).length).toBe(1);
		await duplicateObservability.flush();
		expect(duplicateSpans.map(span => span.metadata?.[SENDBLUE_CORRELATION_KEY])).toEqual([
			hashSendblueMessageHandle(duplicateMessage.id),
		]);
		await duplicateObservability.shutdown();

		releasePolling();
		await completed;
		expect(messages).toEqual([
			'Open https://auth.openai.com/codex/device and enter code: ABCD-EFGH',
			OPENAI_LOGIN_IN_PROGRESS,
			OPENAI_LOGIN_SUCCESS,
		]);
		expect(defaultCalls).toBe(0);
		expect(fetchCalls.map(url => new URL(url).pathname)).toEqual([
			'/api/accounts/deviceauth/usercode',
			'/api/accounts/deviceauth/token',
			'/oauth/token',
		]);

		const credentialPath = join(tempDir, 'data', 'openai-codex-auth.json');
		const persisted = JSON.parse(await Bun.file(credentialPath).text());
		expect(persisted).toMatchObject({
			access: 'test-access-secret',
			refresh: 'test-refresh-secret',
			accountId: 'test-account-secret',
		});
		expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
		expect([...messages, ...errors].join('\n')).not.toMatch(
			/test-access-secret|test-refresh-secret|test-account-secret|test-device-auth-secret|test-authorization-code-secret|test-code-verifier-secret/,
		);
	});

	test('reports timeout without polling or persisting partial state', async () => {
		let now = 0;
		Date.now = () => now;
		runTimersImmediately(() => (now = 15 * 60 * 1000));
		mockFetch((url) => {
			if (url.includes('/deviceauth/usercode'))
				return Response.json({ device_auth_id: 'test-device-auth-secret', user_code: 'ABCD-EFGH', interval: 1 });
			throw new Error(`unexpected URL: ${url}`);
		});
		const messages: string[] = [];
		let timeoutReported!: () => void;
		const reported = new Promise<void>(resolve => (timeoutReported = resolve));
		const thread = makeThread(messages, async (message) => {
			if (message === OPENAI_LOGIN_TIMEOUT)
				timeoutReported();
		});

		await handleSendblueDirectMessage(thread, makeMessage('login openai'), async () => {});
		await reported;

		expect(messages).toEqual([
			'Open https://auth.openai.com/codex/device and enter code: ABCD-EFGH',
			OPENAI_LOGIN_TIMEOUT,
		]);
		expect(fetchCalls.length).toBe(1);
		expect(errors).toEqual(['[openai-codex] Device login status=timeout.']);
		expect(await Bun.file(join(tempDir, 'data', 'openai-codex-auth.json')).exists()).toBe(false);
	});

	test('redacts provider failure details from messages and logs', async () => {
		runTimersImmediately();
		mockFetch((url) => {
			if (url.includes('/deviceauth/usercode'))
				return Response.json({ device_auth_id: 'test-device-auth-secret', user_code: 'ABCD-EFGH', interval: 1 });
			if (url.includes('/deviceauth/token'))
				return new Response('raw-provider-response upstream timed out test-access-secret test-refresh-secret test-account-secret', { status: 500 });
			throw new Error(`unexpected URL: ${url}`);
		});
		const messages: string[] = [];
		let failureReported!: () => void;
		const reported = new Promise<void>(resolve => (failureReported = resolve));
		const thread = makeThread(messages, async (message) => {
			if (message === OPENAI_LOGIN_FAILURE)
				failureReported();
		});

		await handleSendblueDirectMessage(thread, makeMessage('login openai'), async () => {});
		await reported;

		expect(messages).toEqual([
			'Open https://auth.openai.com/codex/device and enter code: ABCD-EFGH',
			OPENAI_LOGIN_FAILURE,
		]);
		expect(errors).toEqual(['[openai-codex] Device login status=failed.']);
		expect([...messages, ...errors].join('\n')).not.toMatch(/raw-provider-response|test-access-secret|test-refresh-secret|test-account-secret/);
		expect(await Bun.file(join(tempDir, 'data', 'openai-codex-auth.json')).exists()).toBe(false);
	});

	test('does not report auth failure when only the success notification fails', async () => {
		runTimersImmediately();
		mockSuccessfulDeviceFlow();
		let notificationLogged!: () => void;
		const logged = new Promise<void>(resolve => (notificationLogged = resolve));
		console.error = (...args: unknown[]) => {
			const message = args.map(String).join(' ');
			errors.push(message);
			if (message.includes('notification_failed'))
				notificationLogged();
		};
		const messages: string[] = [];
		const thread = makeThread(messages, async (message) => {
			if (message === OPENAI_LOGIN_SUCCESS)
				throw new Error('raw Sendblue failure');
		});

		await handleSendblueDirectMessage(thread, makeMessage('login openai'), async () => {});
		await logged;

		expect(messages).not.toContain(OPENAI_LOGIN_FAILURE);
		expect(errors.at(-1)).toBe('[openai-codex] Device login status=complete detail=notification_failed.');
	});
});
