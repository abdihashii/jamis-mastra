import type { ChannelConfig } from '@mastra/core/channels';
import type { Message } from 'chat';
import type { SendblueMessagePayload } from 'chat-adapter-sendblue';
import type { SqlLike } from '../../lib/operator-time-zone';

import { SQL } from 'bun';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { Mastra } from '@mastra/core/mastra';
import { TracingEventType } from '@mastra/core/observability';
import { RequestContext } from '@mastra/core/request-context';
import { createTool, noopObserve } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { Observability } from '@mastra/observability';
import { PostgresStore } from '@mastra/pg';
import { createSendblueAdapter } from 'chat-adapter-sendblue';

const databaseUrl = process.env.JAMIS_TEST_DATABASE_URL;
if (!process.env.FANTASY_BROADCAST_CONTRACT_TEST) {
	test.skipIf(!databaseUrl)('exact Fantasy broadcast/native-channel contract runs with isolated credentials and HTTP', async () => {
		const child = Bun.spawn([process.execPath, '--no-env-file', 'test', import.meta.path], {
			env: {
				...process.env,
				FANTASY_BROADCAST_CONTRACT_TEST: '1',
				LINEAR_CLIENT_ID: 'linear-create-fixture-client',
				LINEAR_CLIENT_SECRET: 'linear-create-fixture-secret',
				LINEAR_TEAM_ID: '11111111-1111-4111-8111-111111111111',
				SENDBLUE_API_KEY: 'sendblue-create-fixture-key',
				SENDBLUE_API_SECRET: 'sendblue-create-fixture-secret',
				SENDBLUE_FROM_NUMBER: '+15550000000',
				SENDBLUE_WEBHOOK_SECRET: 'sendblue-create-webhook-secret',
				JAMIS_ALLOWED_NUMBER: '+15550000001',
				OPERATOR_TIMEZONE: 'UTC',
				FANTASY_SENDBLUE_GROUP_ID: 'stage4-controlled-group',
				FANTASY_SLEEPER_LEAGUE_ID: 'stage4-controlled-league',
				FANTASY_MANAGER_MAP: '{}',
				FANTASY_RECAP_TIMEZONE: 'UTC',
				OPEN_WEATHER_API_KEY: 'weather-fixture',
				FIRECRAWL_API_KEY: 'firecrawl-fixture',
				PERPLEXITY_API_KEY: 'perplexity-fixture',
				GOOGLE_CLIENT_ID: 'google-fixture',
				GOOGLE_CLIENT_SECRET: 'google-fixture',
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		expect({ exit, output: exit === 0 ? '' : stdout + stderr }).toEqual({ exit: 0, output: '' });
	}, 120000);
}
else {
	const url = new URL(databaseUrl!);
	if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/jamis_sessions_test')
		throw new Error('Disposable loopback jamis_sessions_test PostgreSQL is required.');
	const schema = `fantasy_confirm_${randomUUID().replaceAll('-', '')}`;
	const root = new SQL(databaseUrl!);
	const sql = new SQL(databaseUrl!, { connection: { search_path: schema } });
	const store = new PostgresStore({ id: schema, connectionString: databaseUrl!, schemaName: schema });
	beforeAll(async () => {
		await root.unsafe(`CREATE SCHEMA "${schema}"`);
		await store.init();
	}, 30000);
	afterAll(async () => {
		await store.close();
		await sql.close();
		await root.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
		await root.close();
	});
	const { broadcastTools, readPendingBroadcast } = await import('../../fantasy/broadcast');
	const { saveOperatorTimeZoneProposal, clearOperatorTimeZoneConversation } = await import('../../lib/operator-time-zone');
	const { postLinearCreateProposal, readLinearProposal } = await import('../../lib/linear-proposals');
	const { handleSendblueDirectMessage, sendblueAdapter, formatSendblueError, requireSendbluePostAcceptance, postExactSendblueMessage, startJamisDmSession, proposeOperatorTimeZoneChange, proposeLinearCreate } = await import('./sendblue');
	const { createJamisAgent } = await import('../agents/jamis');
	const { boundaryModel } = await import('../agents/__tests__/specialist-boundary.fixture');
	const { spanOutputProcessors, filterProjectTrace, protectProjectSignals } = await import('../observability');
	const draftText = '  **Exact** PRIVATE_STAGE4_DRAFT_SENTINEL draft\nsecond line\nhttps://example.com/?x=1&y=2  ';
	const originalFetch = globalThis.fetch;

	async function fixture(options: { failReview?: boolean; failNotification?: boolean; lostSend?: boolean; competitor?: 'linear' | 'time-zone'; malformedHandback?: boolean; readinessAckLost?: boolean; rejectedSend?: boolean } = {}) {
		await clearOperatorTimeZoneConversation(sql);
		const posts: string[] = [];
		const sends: Array<{ group_id: string; content: string }> = [];
		const history: Message<SendblueMessagePayload>[] = [];
		const spans: unknown[] = [];
		let channelSql: SqlLike = sql;
		if (options.readinessAckLost) {
			channelSql = async (strings, ...values) => {
				const rows = await sql(strings, ...values);
				if (strings.join('').includes('SET status = \'pending\', publication_ready'))
					throw new Error('Synthetic review readiness acknowledgement lost.');
				return rows;
			};
			channelSql.begin = work => sql.begin(tx => work(tx));
		}
		let failNotification = options.failNotification;
		const groups = sendblueAdapter.getSdk().groups;
		const sendSpy = spyOn(groups, 'sendMessage').mockImplementation(((input, options_) => {
			expect(options_?.maxRetries).toBe(0);
			sends.push({ group_id: input.group_id!, content: input.content });
			if (options.lostSend)
				throw new Error('Synthetic accepted-send response lost.');
			return Promise.resolve({ message_handle: randomUUID(), status: options.rejectedSend ? 'ERROR' : 'SENT' });
		}) as typeof groups.sendMessage);
		globalThis.fetch = (async (raw, init) => {
			const url = String(raw);
			if (!url.startsWith('https://api.sendblue.co/'))
				throw new Error('Unstubbed network request refused.');
			const input = JSON.parse(String(init?.body));
			if (input.group_id)
				throw new Error('Group sends must use the controlled SDK boundary.');
			if (url.endsWith('/send-message')) {
				if ((options.failReview && input.content.startsWith('Fantasy draft:')) || (failNotification && input.content.startsWith('Fantasy broadcast')))
					throw new Error('Synthetic notification failure.');
				posts.push(input.content);
			}
			else {
				throw new Error('Unstubbed Sendblue route refused.');
			}
			return Response.json({ message_handle: randomUUID(), status: 'SENT' });
		}) as typeof fetch;
		const adapter = createSendblueAdapter({ webhookSecret: process.env.SENDBLUE_WEBHOOK_SECRET });
		Object.assign(adapter, { isDM: (id: string) => !adapter.decodeThreadId(id).groupId });
		const post = adapter.postMessage.bind(adapter);
		adapter.postMessage = async (...args) => {
			const message = args[1];
			const result = typeof message === 'object' && 'raw' in message && typeof message.raw === 'string'
				? await postExactSendblueMessage(adapter, args[0], message.raw)
				: await post(...args);
			requireSendbluePostAcceptance(result);
			return result as Awaited<ReturnType<typeof post>>;
		};
		adapter.fetchMessages = async () => ({ messages: history, hasMore: false });
		const observability = new Observability({ configs: { test: {
			serviceName: 'fantasy-confirm-fixture',
			spanOutputProcessors,
			spanFilter: filterProjectTrace,
			exporters: [protectProjectSignals({
				name: 'capture',
				onTracingEvent(event) {
					if (event.type === TracingEventType.SPAN_ENDED)
						spans.push(event.exportedSpan);
				},
				onLogEvent: (event) => { spans.push(event.log); },
				onMetricEvent: (event) => { spans.push(event.metric); },
				exportTracingEvent: async () => {},
				flush: async () => {},
				shutdown: async () => {},
			})],
		} } });
		const mastra = new Mastra({ storage: store, observability, logger: false });
		const handback = { case: 'completed', result: { draftId: randomUUID() as string, text: draftText } };
		let source: Message<SendblueMessagePayload>;
		const draft = createTool({
			id: 'draft_group_message',
			description: 'Controlled exact review.',
			inputSchema: broadcastTools.draftGroupMessage.inputSchema!,
			outputSchema: broadcastTools.draftGroupMessage.outputSchema!,
			execute: async (input, context) => {
				const result = await broadcastTools.draftGroupMessage.execute!(input, context);
				if (result && 'draftId' in result && result.draftId && !options.malformedHandback)
					handback.result.draftId = result.draftId;
				if (result && 'draftId' in result && result.draftId)
					expect(await broadcastTools.sendGroupMessage.execute!({ draftId: result.draftId }, context)).toMatchObject({ ok: false, outcome: 'blocked' });
				// A second owner in the same invocation must be denied by the consumed capability.
				expect(await proposeOperatorTimeZoneChange('Asia/Tokyo', context.requestContext, sql)).toEqual({ status: 'denied' });
				expect(await proposeLinearCreate({ action: 'create', title: 'Denied same-turn action' })).toEqual({ status: 'denied' });
				return result;
			},
		});
		const channelsConfig: ChannelConfig = { adapters: { sendblue: { adapter, formatError: formatSendblueError, gateway: false, toolDisplay: 'hidden' } }, handlers: { onDirectMessage: (thread, message, handler, context) => handleSendblueDirectMessage(thread, message, handler, context, channelSql), onMention: false, onSubscribedMessage: false } };
		const agent = createJamisAgent({ mastra, tools: {}, workspace: undefined, model: boundaryModel([{ tool: 'invoke_fantasy_broadcast', input: { question: 'Draft a controlled message and send it.' } }, { text: 'Model claims sent. This must be suppressed.' }, ...Array.from({ length: 20 }, () => ({ text: 'No action authorized.' }))]), memory: new Memory({ options: { semanticRecall: false, workingMemory: { enabled: false } } }), channels: channelsConfig, specialists: { fantasyBroadcast: { tools: { draft_group_message: draft }, model: boundaryModel([{ tool: 'draft_group_message', input: { note: 'Controlled draft', text: draftText } }, { handback }]) } } });
		mastra.addAgent(agent, 'jamis');
		const channels = agent.getChannels()!;
		await channels.initialize(mastra);
		const line = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
		async function send(text: string, id: string = randomUUID(), overrides: Record<string, unknown> = {}, addHistory = true) {
			const payload = { message_handle: id, content: text, from_number: process.env.JAMIS_ALLOWED_NUMBER!, to_number: line, group_id: '', is_outbound: false, status: 'RECEIVED', service: 'iMessage', date_sent: new Date().toISOString(), ...overrides };
			const message = adapter.parseMessage(payload as never);
			if (addHistory)
				history.push(message);
			const tasks: Promise<unknown>[] = [];
			await channels.sdk!.webhooks.sendblue(new Request('http://localhost/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'sb-signing-secret': process.env.SENDBLUE_WEBHOOK_SECRET! }, body: JSON.stringify(payload) }), { waitUntil: task => tasks.push(task), propagateHandlerErrors: true });
			await Promise.all(tasks);
			source ??= message;
			return message;
		}
		return {
			send,
			sends,
			posts,
			history,
			channels,
			adapter,
			mastra,
			spans,
			setSql(value: SqlLike) { channelSql = value; },
			setFailNotification(value: boolean) { failNotification = value; },
			async close() {
				globalThis.fetch = originalFetch;
				sendSpy.mockRestore();
				await channels.sdk!.shutdown();
				await observability.flush();
			},
		};
	}

	test('direct/forged contexts and legacy bare IDs cannot send or prepare a review', async () => {
		const forged = new RequestContext<unknown>([['channel', { platform: 'sendblue', isDM: true }], ['confirmation', 'confirm']]);
		expect(await broadcastTools.sendGroupMessage.execute!({ draftId: randomUUID() }, { requestContext: forged, observe: noopObserve })).toMatchObject({ ok: false, outcome: 'blocked' });
		expect(await broadcastTools.draftGroupMessage.execute!({ note: 'x', text: 'y' }, { requestContext: forged, agent: { agentId: 'fantasy-broadcast-agent', toolCallId: 'forged', messages: [], suspend: async () => {} }, observe: noopObserve })).toMatchObject({ ok: false });
	});

	test('native exact review and trimmed case-insensitive confirm send exact bytes once', async () => {
		const f = await fixture();
		try {
			const source = await f.send('Draft a controlled message and send it.');
			const row = (await readPendingBroadcast(source.threadId, sql))!;
			expect(row.status).toBe('pending');
			expect(f.sends).toHaveLength(0);
			expect(f.posts).toHaveLength(1);
			expect(f.posts[0]).toContain(draftText);
			expect(Object.keys(await f.mastra.getAgent('jamis').listAgents())).toEqual([]);
			expect(Object.values(f.mastra.listAgents()).map(agent => agent.id)).toEqual(['jamis']);
			const confirmationId = randomUUID();
			await Promise.all([f.send(' CoNfIrM ', confirmationId), f.send(' CoNfIrM ', confirmationId, {}, false)]);
			expect(f.sends).toHaveLength(1);
			expect(f.sends[0]).toMatchObject({ group_id: 'stage4-controlled-group', content: draftText });
			expect(await readPendingBroadcast(source.threadId, sql)).toBeNull();
			const rows = await sql`SELECT status, decision, outcome FROM fantasy_broadcasts WHERE id = ${row.id}`;
			expect(rows[0]).toMatchObject({ status: 'sent', decision: { disposition: 'confirmed' }, outcome: { kind: 'sent' } });
			await f.close();
			const protectedSpans = f.spans.filter(value => JSON.stringify(value).includes('fantasy-broadcast'));
			expect(protectedSpans.length).toBeGreaterThan(0);
			expect(JSON.stringify(f.spans)).not.toContain('PRIVATE_STAGE4_DRAFT_SENTINEL');
		}
		finally { await f.close(); }
	}, 30000);

	test('decline, nonexact approval, unrelated input, edits and /new invalidate without sends', async () => {
		for (const text of ['decline', 'yes', 'send it', 'confirm!', '"confirm"', 'unrelated', 'change the second line', '/new']) {
			const f = await fixture();
			try {
				const source = await f.send('Draft.');
				const row = (await readPendingBroadcast(source.threadId, sql))!;
				await f.send(text);
				await f.send('confirm');
				expect(f.sends).toHaveLength(0);
				expect(await readPendingBroadcast(source.threadId, sql)).toBeNull();
				const rows = await sql`SELECT status, decision FROM fantasy_broadcasts WHERE id = ${row.id}`;
				expect(rows[0]).toMatchObject({ status: 'canceled', decision: { disposition: text === 'decline' ? 'declined' : 'canceled' } });
			}
			finally { await f.close(); }
		}
	}, 60000);

	test('wrong session/group, altered saved text, missing readiness and provider-history gaps fail closed', async () => {
		for (const mode of ['session', 'group', 'text', 'readiness', 'history']) {
			const f = await fixture();
			try {
				const source = await f.send('Draft.');
				const row = (await readPendingBroadcast(source.threadId, sql))!;
				if (mode === 'session')
					await sql`UPDATE fantasy_broadcasts SET session_id = 'other' WHERE id = ${row.id}`;
				if (mode === 'group')
					await sql`UPDATE fantasy_broadcasts SET group_id = 'other' WHERE id = ${row.id}`;
				if (mode === 'text')
					await sql`UPDATE fantasy_broadcasts SET draft_text = 'altered' WHERE id = ${row.id}`;
				if (mode === 'readiness')
					await sql`UPDATE fantasy_broadcasts SET publication_ready = FALSE WHERE id = ${row.id}`;
				if (mode === 'history')
					f.history.push({ ...source, id: randomUUID(), text: 'Unreceived next input' } as Message<SendblueMessagePayload>);
				await f.send('confirm');
				await f.send('confirm');
				expect(f.sends).toHaveLength(0);
				expect(await readPendingBroadcast(source.threadId, sql)).toBeNull();
			}
			finally { await f.close(); }
		}
	}, 60000);

	test('group/nonoperator/wrong DM cannot confirm; fresh session rollover cancels; replayed /new preserves newer review', async () => {
		const f = await fixture();
		try {
			const rollover = await f.send('/new');
			const source = await f.send('Draft.');
			const row = (await readPendingBroadcast(source.threadId, sql))!;
			await f.send('/new', rollover.id, {}, false);
			expect((await readPendingBroadcast(source.threadId, sql))!.id).toBe(row.id);
			for (const overrides of [{ group_id: 'stage4-controlled-group' }, { from_number: '+15559999999' }, { to_number: '+15559999999' }]) {
				await f.send('confirm', randomUUID(), overrides, false);
				expect((await readPendingBroadcast(source.threadId, sql))!.id).toBe(row.id);
			}
			const memory = (await store.getStore('memory'))!;
			await startJamisDmSession(memory, f.channels.sdk!.thread(source.threadId), { ...source, id: randomUUID(), text: '/new' } as Message);
			await f.send('confirm');
			expect(f.sends).toHaveLength(0);
		}
		finally { await f.close(); }
	}, 30000);

	test('competing durable Linear/time-zone proposals cancel all authority', async () => {
		for (const mode of ['linear', 'time-zone']) {
			const f = await fixture();
			try {
				const source = await f.send('Draft.');
				const row = (await readPendingBroadcast(source.threadId, sql))!;
				if (mode === 'time-zone')
					expect(await saveOperatorTimeZoneProposal('Asia/Tokyo', source.threadId, source.id, source.metadata.dateSent, sql)).toBe(true);
				else expect(await postLinearCreateProposal({ id: randomUUID(), teamId: '11111111-1111-4111-8111-111111111111', stateId: '44444444-4444-4444-8444-444444444444', stateName: 'Backlog', title: 'Controlled collision', description: '' }, source.threadId, row.session_id, source.id, async () => {}, sql)).toBe(true);
				await f.send('confirm');
				expect(f.sends).toHaveLength(0);
				expect(await readPendingBroadcast(source.threadId, sql)).toBeNull();
				expect(await readLinearProposal(source.threadId, sql)).toBeNull();
			}
			finally { await f.close(); }
		}
	}, 30000);

	test('failed review never authorizes, lost send response and failed notification never resend', async () => {
		for (const mode of ['review', 'readiness', 'lost', 'rejected', 'notification']) {
			const f = await fixture({ failReview: mode === 'review', readinessAckLost: mode === 'readiness', lostSend: mode === 'lost', rejectedSend: mode === 'rejected', failNotification: mode === 'notification' });
			try {
				const source = await f.send('Draft.');
				if (mode === 'notification')
					await expect(f.send('confirm')).rejects.toThrow();
				else await f.send('confirm');
				f.setFailNotification(false);
				await f.send('confirm');
				expect(f.sends).toHaveLength(['review', 'readiness'].includes(mode) ? 0 : 1);
				expect(await readPendingBroadcast(source.threadId, sql)).toBeNull();
				if (mode === 'lost' || mode === 'rejected')
					expect(f.posts.join(' ')).toContain('uncertain');
			}
			finally { await f.close(); }
		}
	}, 60000);

	test('restart and lost claim/outcome acknowledgements recover conservatively without another send', async () => {
		for (const mode of ['before', 'claim', 'outcome', 'missing-outcome']) {
			const f = await fixture();
			const restart = new SQL(databaseUrl!, { connection: { search_path: schema } });
			try {
				const source = await f.send('Draft.');
				const wrapped: SqlLike = async (strings, ...values) => {
					if (mode === 'missing-outcome' && strings.join('').includes('message_handle ='))
						throw new Error('Synthetic outcome persistence unavailable.');
					const rows = await restart(strings, ...values);
					if ((mode === 'claim' && strings.join('').includes('SET status = \'sending\'')) || (mode === 'outcome' && strings.join('').includes('message_handle =')))
						throw new Error('Synthetic acknowledgement lost.');
					return rows;
				};
				wrapped.begin = work => restart.begin(tx => work(tx));
				f.setSql(wrapped);
				if (mode === 'before')
					await f.send('confirm');
				else await expect(f.send('confirm')).rejects.toThrow();
				f.setSql(restart);
				await f.send('confirm');
				expect(f.sends).toHaveLength(mode === 'claim' ? 0 : 1);
				expect(await readPendingBroadcast(source.threadId, restart)).toBeNull();
				if (mode === 'claim' || mode === 'missing-outcome')
					expect(f.posts.join(' ')).toContain('uncertain');
			}
			finally {
				await f.close();
				await restart.close();
			}
		}
	}, 60000);

	test('typed Fantasy handback cannot substitute a fabricated saved draft', async () => {
		const f = await fixture({ malformedHandback: true });
		try {
			await f.send('Draft.');
			expect(f.sends).toHaveLength(0);
			expect(f.posts.join(' ')).not.toContain('Model claims sent');
		}
		finally { await f.close(); }
	});
}
