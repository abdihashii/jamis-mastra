import type { StorageThreadType } from '@mastra/core/memory';
import type { MemoryStorage } from '@mastra/core/storage';
import type { Message, Thread } from 'chat';
import type { SendblueMessagePayload } from 'chat-adapter-sendblue';
import type { FantasyConfig } from '../../../fantasy/config';

import { randomUUID } from 'node:crypto';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';

import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createSendblueAdapter } from 'chat-adapter-sendblue';

import { clearOperatorTimeZoneConversation, readPendingOperatorTimeZoneProposal, resolveOperatorTimeZone, saveOperatorTimeZoneProposal, setOperatorTimeZoneOverride } from '../../../lib/operator-time-zone';
import { getDeploymentSnapshot, stageDeploymentSnapshot } from '../../tools/deployment-monitoring';

process.env.JAMIS_ALLOWED_NUMBER = '+15555550101';
process.env.SENDBLUE_API_KEY = 'test-api-key';
process.env.SENDBLUE_API_SECRET = 'test-api-secret';
process.env.SENDBLUE_FROM_NUMBER = '+15555550100';
process.env.SENDBLUE_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.OPEN_WEATHER_API_KEY = 'test-weather-key';
process.env.FIRECRAWL_API_KEY = 'test-firecrawl-key';
process.env.PERPLEXITY_API_KEY = 'test-perplexity-key';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.OPERATOR_TIMEZONE = 'America/Chicago';

const { handleSendblueDirectMessage, NEW_SESSION_SUCCESS, sendblueAdapter, startJamisDmSession } = await import('../sendblue');
const { createFantasyGroupHandler } = await import('../../../fantasy/ingest');
const { createJamisAgent } = await import('../../agents/jamis');
const jamis = createJamisAgent();
const memoryOptions = (await jamis.getMemory())!.getMergedThreadConfig();

test('Jamis explicitly isolates conversational memory by thread', () => {
	expect(memoryOptions.semanticRecall).toBe(false);
	expect(memoryOptions.workingMemory?.enabled).toBe(false);
	expect(memoryOptions.observationalMemory).toMatchObject({ scope: 'thread', retrieval: false });
});

function assertDisposableDatabaseUrl(value: string): void {
	const url = new URL(value);
	if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.searchParams.has('host')
		|| !['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/jamis_sessions_test') {
		throw new Error('JAMIS_TEST_DATABASE_URL must use loopback and the disposable jamis_sessions_test database without a host query override.');
	}
}

test('database fixture rejects remote hosts, host overrides, and non-disposable targets', () => {
	for (const url of [
		'postgresql://remote.example/jamis_sessions_test',
		'postgresql://localhost/jamis_sessions_test?host=remote.example',
		'postgresql://localhost/mastra',
		'socket://localhost/jamis_sessions_test?db=mastra',
	]) {
		expect(() => assertDisposableDatabaseUrl(url)).toThrow('JAMIS_TEST_DATABASE_URL');
	}
	expect(() => assertDisposableDatabaseUrl('postgres://localhost/jamis_sessions_test')).not.toThrow();
	expect(() => assertDisposableDatabaseUrl('postgresql://127.0.0.1:15458/jamis_sessions_test')).not.toThrow();
});

// Opt in with a disposable local database, never the application's DATABASE_URL.
const databaseUrl = process.env.JAMIS_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('Jamis DM sessions with PostgreSQL and native channels', () => {
	let store: PostgresStore;
	let memory: MemoryStorage;
	let sql: SQL;
	const schema = `jamis_sessions_${randomUUID().replaceAll('-', '')}`;

	beforeAll(async () => {
		assertDisposableDatabaseUrl(databaseUrl!);
		store = new PostgresStore({ id: schema, connectionString: databaseUrl!, schemaName: schema });
		await store.init();
		memory = (await store.getStore('memory'))!;
		sql = new SQL(databaseUrl!, { connection: { search_path: schema } });
	}, 30000);

	afterAll(async () => {
		if (store) {
			try {
				await sql?.close();
				await store.db.none(`DROP SCHEMA "${schema}" CASCADE`);
			}
			finally {
				await store.close();
			}
		}
	});

	function dm(handle: string = randomUUID(), line = '+15555550100') {
		const payload = {
			message_handle: handle,
			content: '/new',
			from_number: process.env.JAMIS_ALLOWED_NUMBER!,
			to_number: line,
			group_id: '',
			is_outbound: false,
			status: 'RECEIVED',
			service: 'iMessage',
			date_sent: '2026-09-28T12:00:00.000Z',
		} as SendblueMessagePayload;
		const message = sendblueAdapter.parseMessage(payload);
		const thread = {
			id: message.threadId,
			channelId: sendblueAdapter.channelIdFromThreadId(message.threadId),
			adapter: sendblueAdapter,
			isDM: true,
		} as unknown as Thread;
		return { message, thread };
	}

	function coordinates(thread: Thread) {
		return {
			channel_platform: 'sendblue',
			channel_externalThreadId: thread.id,
			channel_externalChannelId: thread.channelId,
		};
	}

	async function seed(thread: Thread, owner: string | null = 'jamis', createdAt = new Date('2026-09-28T12:00:00.000Z')) {
		return await memory.saveThread({
			thread: {
				id: randomUUID(),
				resourceId: owner && owner !== 'jamis' ? 'another-agent-resource' : 'exact-existing-operator-resource',
				title: 'OLD TITLE SENTINEL',
				createdAt,
				updatedAt: createdAt,
				metadata: {
					...coordinates(thread),
					...(owner === null ? {} : { channel_ownerId: owner }),
					workingMemory: 'OLD WORKING MEMORY SENTINEL',
					summary: 'OLD SUMMARY SENTINEL',
				},
			},
		});
	}

	async function nativeChannels(options: {
		commandFlow?: boolean;
		onPrompt?: () => Promise<void>;
		onIntake?: (message: Message) => void;
		fantasyConfig?: FantasyConfig;
	} = {}) {
		const prompts: unknown[] = [];
		const model = new MastraLanguageModelV2Mock({
			doStream: async (streamOptions) => {
				prompts.push(streamOptions.prompt);
				await options.onPrompt?.();
				return {
					stream: new ReadableStream({
						start(controller) {
							controller.enqueue({ type: 'stream-start', warnings: [] });
							if (options.commandFlow) {
								controller.enqueue({ type: 'text-start', id: 'reply' });
								controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'Fixture reply.' });
								controller.enqueue({ type: 'text-end', id: 'reply' });
							}
							controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } });
							controller.close();
						},
					}),
				};
			},
		});
		const adapter = createSendblueAdapter({ webhookSecret: process.env.SENDBLUE_WEBHOOK_SECRET });
		Object.assign(adapter, { isDM: (id: string) => !adapter.decodeThreadId(id).groupId });
		// Exercise native mapping and prompts; command flows use stubbed outbound HTTP.
		if (!options.commandFlow) {
			adapter.startTyping = async () => {};
			adapter.postMessage = async () => {
				throw new Error('Unexpected channel send');
			};
		}
		adapter.fetchMessages = async () => {
			throw new Error('DMs must not import platform history');
		};
		const observationalMemory = memoryOptions.observationalMemory;
		if (!observationalMemory || typeof observationalMemory !== 'object')
			throw new Error('Expected Jamis Observational Memory configuration');
		const agent = new Agent({
			id: 'jamis',
			name: 'Jamis fixture',
			instructions: 'Read the current message.',
			model,
			memory: new Memory({
				options: {
					...memoryOptions,
					observationalMemory: { ...observationalMemory, model },
				},
			}),
			channels: {
				adapters: { sendblue: { adapter, gateway: false, toolDisplay: 'hidden' } },
				handlers: {
					onDirectMessage: options.commandFlow
						? (thread, message, defaultHandler, context) => {
								options.onIntake?.(message);
								return handleSendblueDirectMessage(thread, message, defaultHandler, context, sql);
							}
						: undefined,
					onMention: options.fantasyConfig ? createFantasyGroupHandler(options.fantasyConfig) : false,
					onSubscribedMessage: false,
				},
			},
		});
		const mastra = new Mastra({ storage: store, agents: { jamis: agent }, logger: false });
		const channels = agent.getChannels()!;
		await channels.initialize(mastra);
		return { adapter, channels, prompts, sdk: channels.sdk! };
	}

	function stubSendblueHttp() {
		const replies: string[] = [];
		const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (input, init) => {
			const url = new URL(String(input));
			if (url.hostname !== 'api.sendblue.co' || !['/api/send-message', '/api/mark-read', '/api/send-typing-indicator'].includes(url.pathname))
				throw new Error(`Unexpected fixture HTTP: ${url.origin}${url.pathname}`);
			if (url.pathname === '/api/send-message')
				replies.push(JSON.parse(String(init?.body)).content);
			return Response.json({ message_handle: randomUUID(), status: 'SENT' });
		}) as typeof globalThis.fetch);
		return { fetch, replies };
	}

	async function webhook(fixture: Awaited<ReturnType<typeof nativeChannels>>, payload: SendblueMessagePayload) {
		const tasks: Promise<unknown>[] = [];
		const response = await fixture.sdk.webhooks.sendblue(new Request('http://localhost/api/agents/jamis/channels/sendblue/webhook', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'sb-signing-secret': process.env.SENDBLUE_WEBHOOK_SECRET! },
			body: JSON.stringify(payload),
		}), { waitUntil: task => tasks.push(task), propagateHandlerErrors: true });
		expect(response.status).toBe(200);
		expect(tasks).toHaveLength(1);
		return { completion: Promise.all(tasks) };
	}

	async function dispatch(fixture: Awaited<ReturnType<typeof nativeChannels>>, original: Message) {
		const message = fixture.adapter.parseMessage({
			...(original.raw as SendblueMessagePayload),
			message_handle: randomUUID(),
			content: 'CURRENT DM SENTINEL',
		});
		await fixture.sdk.processMessage(fixture.adapter, message.threadId, message);
		expect(fixture.prompts).toHaveLength(1);
	}

	test('local webhook demo confirms without an agent turn, then restart routes the immediate DM to the durable session', async () => {
		await clearOperatorTimeZoneConversation(sql);
		const { message, thread } = dm(randomUUID(), '+15555550120');
		const old = await seed(thread);
		const oldRecord = await memory.getThreadById({ threadId: old.id });
		const http = stubSendblueHttp();
		let fixture = await nativeChannels({ commandFlow: true });
		try {
			await (await webhook(fixture, message.raw as SendblueMessagePayload)).completion;
			expect(http.replies).toEqual([NEW_SESSION_SUCCESS]);
			expect(fixture.prompts).toHaveLength(0);
			const fresh = (await memory.listThreads({ filter: { metadata: { ...coordinates(thread), channel_ownerId: 'jamis' } }, perPage: 1 })).threads[0];
			expect(fresh.id).not.toBe(old.id);
			expect(fresh.resourceId).toBe(old.resourceId);
			expect((await memory.listMessages({ threadId: fresh.id })).total).toBe(0);
			expect(await memory.getThreadById({ threadId: old.id })).toEqual(oldRecord);
			await fixture.sdk.shutdown();
			fixture = await nativeChannels({ commandFlow: true });
			await (await webhook(fixture, {
				...(message.raw as SendblueMessagePayload),
				message_handle: randomUUID(),
				content: 'IMMEDIATE DM SENTINEL',
			})).completion;
			expect(fixture.prompts).toHaveLength(1);
			expect(JSON.stringify(fixture.prompts)).toContain('IMMEDIATE DM SENTINEL');
			expect(JSON.stringify(fixture.prompts)).not.toMatch(/OLD |\/new|New session started/);
			const messages = (await memory.listMessages({ threadId: fresh.id })).messages;
			expect(messages.map(item => item.role)).toContain('signal');
			expect(messages.every(item => item.resourceId === old.resourceId)).toBe(true);
			expect(JSON.stringify(messages)).not.toMatch(/\/new|New session started/);
			expect((await memory.listMessages({ threadId: old.id })).total).toBe(0);
			expect(http.replies).toEqual([NEW_SESSION_SUCCESS, 'Fixture reply.']);
		}
		finally {
			await fixture.sdk.shutdown();
			http.fetch.mockRestore();
		}
	}, 30000);

	test('native busy-DM dispatch queues reply, rollover, and equal-timestamp DM while groups persist concurrently', async () => {
		await clearOperatorTimeZoneConversation(sql);
		await setOperatorTimeZoneOverride('America/Chicago', sql);
		const { message, thread } = dm(randomUUID(), '+15555550121');
		const old = await seed(thread);
		const active = { ...(message.raw as SendblueMessagePayload), message_handle: randomUUID(), content: 'ACTIVE DM SENTINEL' };
		const following = { ...active, message_handle: randomUUID(), content: 'FOLLOWING DM SENTINEL' };
		const paused = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const commandEntered = Promise.withResolvers<void>();
		const queued = Promise.withResolvers<void>();
		const intake: string[] = [];
		const fantasyConfig: FantasyConfig = { sendblueGroupId: randomUUID(), sleeperLeagueId: 'fixture-league', managerMap: {}, recapTimezone: 'UTC' };
		const http = stubSendblueHttp();
		const fixture = await nativeChannels({
			commandFlow: true,
			fantasyConfig,
			onIntake: (incoming) => {
				intake.push(incoming.id);
				if (incoming.id === message.id)
					commandEntered.resolve();
				if (intake.length === 3)
					queued.resolve();
			},
			onPrompt: async () => {
				if (intake.length !== 1)
					return;
				expect(await saveOperatorTimeZoneProposal('Asia/Tokyo', thread.id, active.message_handle, message.metadata.dateSent, sql)).toBe(true);
				stageDeploymentSnapshot(thread.id, active.message_handle, {} as never, []);
				paused.resolve();
				await release.promise;
			},
		});
		const completions: Promise<unknown>[] = [];
		try {
			completions.push((await webhook(fixture, active)).completion);
			await paused.promise;
			completions.push((await webhook(fixture, message.raw as SendblueMessagePayload)).completion);
			await commandEntered.promise;
			completions.push((await webhook(fixture, following)).completion);
			await queued.promise;
			expect(intake).toEqual([active.message_handle, message.id, following.message_handle]);
			expect(http.replies).toEqual([]);
			expect(fixture.prompts).toHaveLength(1);
			const group = { ...active, group_id: fantasyConfig.sendblueGroupId, content: '/new', message_handle: randomUUID() };
			const groupNext = { ...group, content: 'PASSIVE GROUP SENTINEL', message_handle: randomUUID() };
			const groups = await Promise.all([webhook(fixture, group), webhook(fixture, groupNext), webhook(fixture, group)]);
			await Promise.all(groups.map(item => item.completion));
			const groupMessages = await memory.listMessages({ threadId: `fantasy-group-${fantasyConfig.sendblueGroupId}` });
			expect(groupMessages.total).toBe(2);
			expect(groupMessages.messages.map(item => item.id).sort()).toEqual([group.message_handle, groupNext.message_handle].sort());
			expect(fixture.prompts).toHaveLength(1);
			expect((await memory.listThreads({ filter: { metadata: { ...coordinates(thread), channel_ownerId: 'jamis' } } })).total).toBe(1);
			release.resolve();
			await Promise.all(completions);
			expect(http.replies).toEqual(['Fixture reply.', NEW_SESSION_SUCCESS, 'Fixture reply.']);
			expect(fixture.prompts).toHaveLength(2);
			expect(JSON.stringify(fixture.prompts[1])).toContain('FOLLOWING DM SENTINEL');
			expect(JSON.stringify(fixture.prompts[1])).not.toMatch(/ACTIVE DM SENTINEL|\/new|New session started|PASSIVE GROUP SENTINEL/);
			const fresh = (await memory.listThreads({ filter: { metadata: { ...coordinates(thread), channel_ownerId: 'jamis' } }, perPage: 1 })).threads[0];
			expect(fresh.id).not.toBe(old.id);
			expect(fresh.resourceId).toBe(old.resourceId);
			expect(JSON.stringify(await memory.listMessages({ threadId: fresh.id }))).toContain('FOLLOWING DM SENTINEL');
			expect(JSON.stringify(await memory.listMessages({ threadId: old.id }))).not.toContain('FOLLOWING DM SENTINEL');
			expect(await readPendingOperatorTimeZoneProposal(sql)).toBeNull();
			expect(await resolveOperatorTimeZone('UTC', sql)).toEqual({ timeZone: 'America/Chicago', source: 'override' });
			expect(getDeploymentSnapshot(thread.id, active.message_handle)).toBeUndefined();
		}
		finally {
			release.resolve();
			await Promise.allSettled(completions);
			await fixture.sdk.shutdown();
			http.fetch.mockRestore();
		}
	}, 30000);

	test('restart selects the clean owned session and leaves old history and observations intact', async () => {
		const { message, thread } = dm(randomUUID(), '+15555550110');
		const old = await seed(thread);
		await seed(thread, 'another-agent', new Date('2040-01-01T00:00:00.000Z'));
		await memory.saveMessages({ messages: ['user', 'assistant'].map((role, index) => ({
			id: randomUUID(),
			threadId: old.id,
			resourceId: old.resourceId,
			role: role as 'user' | 'assistant',
			type: 'text',
			createdAt: new Date(old.createdAt.getTime() + index),
			content: { format: 2, parts: [{ type: 'text', text: `OLD ${role.toUpperCase()} MESSAGE SENTINEL` }] },
		})) });
		const observation = await memory.initializeObservationalMemory({ threadId: old.id, resourceId: old.resourceId, scope: 'thread', config: {} });
		await memory.updateActiveObservations({ id: observation.id, observations: 'OLD OBSERVATION SENTINEL', tokenCount: 5, lastObservedAt: old.createdAt });
		await memory.createReflectionGeneration({
			currentRecord: (await memory.getObservationalMemory(old.id, old.resourceId))!,
			reflection: 'OLD REFLECTION SENTINEL',
			tokenCount: 5,
		});
		await memory.updateResource({ resourceId: old.resourceId, workingMemory: 'OLD RESOURCE WORKING MEMORY SENTINEL' });
		const oldRecord = await memory.getThreadById({ threadId: old.id });
		const oldMessages = await memory.listMessages({ threadId: old.id });
		const oldObservations = await memory.getObservationalMemoryHistory(old.id, old.resourceId);
		const first = await nativeChannels();
		const result = await startJamisDmSession(memory, first.sdk.thread(thread.id), message);
		expect(result.status).toBe('created');
		expect(result.thread.id).not.toBe(old.id);
		expect(result.thread.resourceId).toBe(old.resourceId);
		expect(result.thread.metadata).toEqual({ ...coordinates(thread), channel_ownerId: 'jamis' });
		expect((await memory.listMessages({ threadId: result.thread.id })).total).toBe(0);
		expect(await memory.getObservationalMemory(result.thread.id, old.resourceId)).toBeNull();
		await first.sdk.shutdown();

		const restarted = await nativeChannels();
		try {
			await dispatch(restarted, message);
			const newMessages = await memory.listMessages({ threadId: result.thread.id });
			expect(newMessages.messages.map(item => item.role)).toContain('signal');
			expect(JSON.stringify(newMessages.messages)).toContain('CURRENT DM SENTINEL');
			expect(newMessages.messages.every(item => item.resourceId === old.resourceId)).toBe(true);
			const prompt = JSON.stringify(restarted.prompts);
			expect(prompt).toContain('CURRENT DM SENTINEL');
			expect(prompt).not.toContain('OLD ');
			expect(prompt).not.toContain('/new');
			expect((await memory.getObservationalMemory(result.thread.id, old.resourceId))?.activeObservations ?? '').toBe('');
			expect(await memory.getThreadById({ threadId: old.id })).toEqual(oldRecord);
			expect(await memory.listMessages({ threadId: old.id })).toEqual(oldMessages);
			expect(await memory.getObservationalMemoryHistory(old.id, old.resourceId)).toEqual(oldObservations);
		}
		finally {
			await restarted.sdk.shutdown();
		}
	}, 30000);

	test('legacy selection preserves its resource and leaves the unclaimed thread unchanged', async () => {
		const { thread, message } = dm(randomUUID(), '+15555550111');
		await seed(thread, 'another-agent', new Date('2025-01-01T00:00:00.000Z'));
		const legacy = await seed(thread, null);
		const before = await memory.getThreadById({ threadId: legacy.id });
		expect(before?.metadata).not.toHaveProperty('channel_ownerId');
		const result = await startJamisDmSession(memory, thread, message);
		expect(result.thread.resourceId).toBe(legacy.resourceId);
		expect(await memory.getThreadById({ threadId: legacy.id })).toEqual(before);
		expect(result.thread.metadata).toEqual({ ...coordinates(thread), channel_ownerId: 'jamis' });
	});

	test('first-ever DM uses native resource identity and command IDs are scoped to the conversation', async () => {
		const first = dm('same-provider-handle', '+15555550112');
		const second = dm('same-provider-handle', '+15555550113');
		const a = await startJamisDmSession(memory, first.thread, first.message);
		const b = await startJamisDmSession(memory, second.thread, second.message);
		expect(a.thread.resourceId).toBe(`sendblue:${first.message.author.userId}`);
		expect(b.thread.id).not.toBe(a.thread.id);
	});

	test('frozen and backward clocks keep native selection deterministic; replays never overwrite or reactivate', async () => {
		const first = dm('first-command', '+15555550114');
		const old = await seed(first.thread);
		const clock = spyOn(Date, 'now').mockReturnValue(old.createdAt.getTime());
		let latest: StorageThreadType;
		try {
			const a = await startJamisDmSession(memory, first.thread, first.message);
			expect(a.thread.createdAt.getTime()).toBe(old.createdAt.getTime() + 1);
			await memory.patchThread({ id: a.thread.id, metadata: { laterConversation: 'preserve-me' } });
			const saved = (await memory.getThreadById({ threadId: a.thread.id }))!;
			const replay = await startJamisDmSession(memory, first.thread, first.message);
			expect(replay).toEqual({ status: 'replayed', thread: saved });
			const second = dm('second-command', '+15555550114');
			const b = await startJamisDmSession(memory, second.thread, second.message);
			expect(b.thread.createdAt.getTime()).toBe(a.thread.createdAt.getTime() + 1);
			clock.mockReturnValue(new Date('2020-01-01T00:00:00.000Z').getTime());
			const third = dm('third-command', '+15555550114');
			const c = await startJamisDmSession(memory, third.thread, third.message);
			expect(c.thread.createdAt.getTime()).toBe(b.thread.createdAt.getTime() + 1);
			latest = c.thread;
			expect((await startJamisDmSession(memory, first.thread, first.message)).status).toBe('superseded');
			expect(await memory.getThreadById({ threadId: a.thread.id })).toEqual(saved);
			expect((await memory.listThreads({ filter: { metadata: { ...coordinates(first.thread), channel_ownerId: 'jamis' } } })).total).toBe(4);
		}
		finally {
			clock.mockRestore();
		}
		const restarted = await nativeChannels();
		try {
			await dispatch(restarted, first.message);
			expect((await memory.listMessages({ threadId: latest!.id })).total).toBeGreaterThan(0);
		}
		finally {
			await restarted.sdk.shutdown();
		}
	}, 30000);

	test('failed writes keep the old session; a lost write acknowledgement safely replays the stored session', async () => {
		const { message, thread } = dm(randomUUID(), '+15555550115');
		const old = await seed(thread);
		const save = memory.saveThread.bind(memory);
		let write = spyOn(memory, 'saveThread').mockRejectedValue(new Error('write failed'));
		try {
			await expect(startJamisDmSession(memory, thread, message)).rejects.toThrow('write failed');
			expect((await memory.listThreads({ filter: { metadata: { ...coordinates(thread), channel_ownerId: 'jamis' } } })).threads[0].id).toBe(old.id);
		}
		finally {
			write.mockRestore();
		}
		write = spyOn(memory, 'saveThread').mockImplementation(async (args) => {
			await save(args);
			throw new Error('acknowledgement lost');
		});
		try {
			await expect(startJamisDmSession(memory, thread, message)).rejects.toThrow('acknowledgement lost');
		}
		finally {
			write.mockRestore();
		}
		const replay = await startJamisDmSession(memory, thread, message);
		expect(replay.status).toBe('replayed');
		expect(replay.thread.id).not.toBe(old.id);
		expect((await memory.listThreads({ filter: { metadata: { ...coordinates(thread), channel_ownerId: 'jamis' } } })).total).toBe(2);
	});

	test('rejects invalid channel coordinates, sender, and DM scope before any write', async () => {
		const { message, thread } = dm(randomUUID(), '+15555550116');
		for (const [invalidThread, invalidMessage] of [
			[{ ...thread, isDM: false }, message],
			[{ ...thread, adapter: { name: 'slack' } }, message],
			[thread, { ...message, author: { userId: '+15555550999' } }],
			[thread, { ...message, id: '' }],
			[thread, { ...message, threadId: 'different-conversation' }],
		] as [Thread, Message][]) {
			await expect(startJamisDmSession(memory, invalidThread, invalidMessage)).rejects.toThrow('validated operator Sendblue DM');
		}
		expect((await memory.listThreads({ filter: { metadata: coordinates(thread) } })).total).toBe(0);
	});
});
