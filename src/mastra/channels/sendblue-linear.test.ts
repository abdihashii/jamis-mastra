import type { Message, Thread } from 'chat';
import type { SendblueMessagePayload } from 'chat-adapter-sendblue';
import type { LinearCreateOperation } from '../../lib/linear';
import type { SqlLike } from '../../lib/operator-time-zone';

import { SQL } from 'bun';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { TracingEventType } from '@mastra/core/observability';
import { RequestContext } from '@mastra/core/request-context';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { noopObserve } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { Observability } from '@mastra/observability';
import { PostgresStore } from '@mastra/pg';
import { createSendblueAdapter } from 'chat-adapter-sendblue';
import { claimLinearCreate, finishLinearCreate, notifyLinearOutcome, postLinearCreateProposal, readLinearProposal, receiveLinearMessage } from '../../lib/linear-proposals';
import { clearOperatorTimeZoneConversation, saveOperatorTimeZoneProposal } from '../../lib/operator-time-zone';
import { redactChannelRenderContext } from '../observability';

const databaseUrl = process.env.JAMIS_TEST_DATABASE_URL;
if (!process.env.LINEAR_CREATE_CONTRACT_TEST) {
	test.skipIf(!databaseUrl)('durable Linear create/native-channel contract runs with isolated credentials and HTTP', async () => {
		const child = Bun.spawn([process.execPath, '--no-env-file', 'test', import.meta.path], {
			env: {
				...process.env,
				LINEAR_CREATE_CONTRACT_TEST: '1',
				LINEAR_CLIENT_ID: 'linear-create-fixture-client',
				LINEAR_CLIENT_SECRET: 'linear-create-fixture-secret',
				LINEAR_TEAM_ID: '11111111-1111-4111-8111-111111111111',
				SENDBLUE_API_KEY: 'sendblue-create-fixture-key',
				SENDBLUE_API_SECRET: 'sendblue-create-fixture-secret',
				SENDBLUE_FROM_NUMBER: '+15550000000',
				SENDBLUE_WEBHOOK_SECRET: 'sendblue-create-webhook-secret',
				JAMIS_ALLOWED_NUMBER: '+15550000001',
				OPERATOR_TIMEZONE: 'UTC',
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		expect({ exit, output: exit === 0 ? '' : stdout + stderr }).toEqual({ exit: 0, output: '' });
	}, 30000);
}
else {
	const url = new URL(databaseUrl!);
	if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)
		|| url.pathname !== '/jamis_sessions_test' || url.searchParams.has('host')) {
		throw new Error('Disposable loopback jamis_sessions_test PostgreSQL is required.');
	}
	const schema = `linear_create_${randomUUID().replaceAll('-', '')}`;
	const root = new SQL(databaseUrl!);
	const sql = new SQL(databaseUrl!, { connection: { search_path: schema } });
	const store = new PostgresStore({ id: schema, connectionString: databaseUrl!, schemaName: schema });
	const teamId = process.env.LINEAR_TEAM_ID!;
	const stateId = '44444444-4444-4444-8444-444444444444';
	const operation = (): LinearCreateOperation => ({ id: randomUUID(), teamId, stateId, stateName: 'Backlog', title: 'Exact fixture title', description: 'Exact fixture description' });
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

	test('durable proposal requires successful posting and the latest recorded source; no credential fields', async () => {
		const dm = randomUUID();
		const op = operation();
		expect(await postLinearCreateProposal(op, dm, 'session', 'missing', async () => {}, sql)).toBe(false);
		expect(await receiveLinearMessage(dm, 'source', sql)).toBe(true);
		await expect(postLinearCreateProposal(op, dm, 'session', 'source', async () => {
			throw new Error('posting failed');
		}, sql)).rejects.toThrow('posting failed');
		expect(await readLinearProposal(dm, sql)).toBeNull();
		const posts: string[] = [];
		expect(await postLinearCreateProposal(op, dm, 'session', 'source', async text => posts.push(text), sql)).toBe(true);
		expect(posts[0]).toContain(`Title: ${op.title}`);
		expect(posts[0]).toContain(`Description: ${op.description}`);
		expect(posts[0]).toContain(`Status: ${op.stateName}`);
		await receiveLinearMessage(dm, 'next', sql);
		expect(await postLinearCreateProposal(operation(), dm, 'session', 'source', async () => {}, sql)).toBe(false);
		expect(JSON.stringify((await readLinearProposal(dm, sql))!.operation)).not.toMatch(/secret|token|thread|capability/);
	});

	test('duplicate receipt, concurrent confirms, session mismatch, intervening turn, and restart never reclaim', async () => {
		for (const mode of ['valid', 'session', 'intervening']) {
			const dm = randomUUID();
			await receiveLinearMessage(dm, 'source', sql);
			await postLinearCreateProposal(operation(), dm, 'session', 'source', async () => {}, sql);
			const proposal = (await readLinearProposal(dm, sql))!;
			if (mode === 'intervening')
				await receiveLinearMessage(dm, 'other', sql);
			await receiveLinearMessage(dm, 'confirm', sql);
			expect(await receiveLinearMessage(dm, 'confirm', sql)).toBe(false);
			const claims = await Promise.all([1, 2].map(() => claimLinearCreate(proposal, mode === 'session' ? 'other-session' : 'session', 'confirm', true, sql)));
			expect(claims.filter(Boolean)).toHaveLength(mode === 'valid' ? 1 : 0);
			const restart = new SQL(databaseUrl!, { connection: { search_path: schema } });
			try {
				expect(await claimLinearCreate(proposal, 'session', 'confirm', true, restart)).toBe(false);
				if (mode === 'valid') {
					const recovered = (await readLinearProposal(dm, restart))!;
					const posts: string[] = [];
					await notifyLinearOutcome(recovered, async text => posts.push(text), restart);
					expect(posts[0]).toContain('uncertain');
					expect(await readLinearProposal(dm, restart)).toBeNull();
				}
			}
			finally { await restart.close(); }
		}
	});

	test('stored success survives failed result posting; notification retry does not execute again', async () => {
		const dm = randomUUID();
		await receiveLinearMessage(dm, 'source', sql);
		await postLinearCreateProposal(operation(), dm, 'session', 'source', async () => {}, sql);
		const proposal = (await readLinearProposal(dm, sql))!;
		await receiveLinearMessage(dm, 'confirm', sql);
		expect(await claimLinearCreate(proposal, 'session', 'confirm', true, sql)).toBe(true);
		await finishLinearCreate(proposal.id, { status: 'succeeded', identifier: 'JAM-999', url: 'https://linear.app/fixture/issue/JAM-999' }, sql);
		await expect(notifyLinearOutcome((await readLinearProposal(dm, sql))!, async () => {
			throw new Error('reply lost');
		}, sql)).rejects.toThrow('Linear result notification unavailable.');
		const posts: string[] = [];
		await notifyLinearOutcome((await readLinearProposal(dm, sql))!, async text => posts.push(text), sql);
		expect(posts).toEqual(['Created JAM-999: https://linear.app/fixture/issue/JAM-999']);
		expect(await claimLinearCreate(proposal, 'session', 'confirm', true, sql)).toBe(false);
	});

	test('restart before claim preserves the proposal; a lost claim acknowledgement is never replayed', async () => {
		const dm = randomUUID();
		await receiveLinearMessage(dm, 'source', sql);
		await postLinearCreateProposal(operation(), dm, 'session', 'source', async () => {}, sql);
		const restart = new SQL(databaseUrl!, { connection: { search_path: schema } });
		try {
			const pending = (await readLinearProposal(dm, restart))!;
			expect(pending.state).toBe('pending');
			await receiveLinearMessage(dm, 'confirm', restart);
			const lostAck = ((strings: TemplateStringsArray, ...values: unknown[]) => restart(strings, ...values)) as SqlLike;
			lostAck.begin = async (work) => {
				await restart.begin(tx => work(tx));
				throw new Error('claim acknowledgement lost');
			};
			await expect(claimLinearCreate(pending, 'session', 'confirm', true, lostAck)).rejects.toThrow('claim acknowledgement lost');
			expect(await claimLinearCreate(pending, 'session', 'confirm', true, restart)).toBe(false);
			const posts: string[] = [];
			await notifyLinearOutcome((await readLinearProposal(dm, restart))!, async text => posts.push(text), restart);
			expect(posts[0]).toContain('uncertain');
		}
		finally { await restart.close(); }
	});

	const { handleSendblueDirectMessage, proposeLinearCreate, requireSendbluePostAcceptance, startJamisDmSession } = await import('./sendblue');
	const { linearCreateProposalTool } = await import('../tools/linear');
	const originalFetch = globalThis.fetch;
	type Action = { tool: string; input: Record<string, unknown> } | { text: string };
	function model(actions: Action[], prompts: unknown[]) {
		let step = 0;
		return new MastraLanguageModelV2Mock({ doStream: async (options) => {
			prompts.push(options.prompt);
			const action = actions[step++] ?? { text: '' };
			return { stream: new ReadableStream({ start(controller) {
				controller.enqueue({ type: 'stream-start', warnings: [] });
				if ('tool' in action) {
					controller.enqueue({ type: 'tool-call', toolCallId: `call-${step}`, toolName: action.tool, input: JSON.stringify(action.input) });
				}
				else if (action.text) {
					controller.enqueue({ type: 'text-start', id: 'reply' });
					controller.enqueue({ type: 'text-delta', id: 'reply', delta: action.text });
					controller.enqueue({ type: 'text-end', id: 'reply' });
				}
				controller.enqueue({ type: 'finish', finishReason: 'tool' in action ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
				controller.close();
			} }) };
		} });
	}

	async function fixture() {
		await clearOperatorTimeZoneConversation(sql);
		const posts: string[] = [];
		const mutations: unknown[] = [];
		const prompts: unknown[] = [];
		const spans: unknown[] = [];
		const history: Message<SendblueMessagePayload>[] = [];
		let lostResponse = false;
		let failResultPost = false;
		let failProposalPost = false;
		let rejectedProposalPost = false;
		globalThis.fetch = (async (raw, init) => {
			const url = String(raw);
			if (url.startsWith('https://auth.openai.com/'))
				return new Response('Fixture device login rejected', { status: 400 });
			if (url === 'https://api.linear.app/oauth/token') {
				const scope = (init!.body as URLSearchParams).get('scope')!;
				return Response.json({ access_token: 'linear-create-fixture-access', token_type: 'Bearer', expires_in: 2591999, scope: scope.replace(',', ' ') });
			}
			if (url === 'https://api.linear.app/graphql') {
				const { query, variables } = JSON.parse(String(init!.body));
				const team = { id: teamId, name: 'jamis', key: 'JAM' };
				const state = { id: stateId, name: 'Backlog', team: { id: teamId } };
				if (query.includes('JamisIdentityAndTeam'))
					return Response.json({ data: { viewer: { id: stateId, name: 'jamis', app: true }, team } });
				if (query.includes('JamisDefaultCreateState'))
					return Response.json({ data: { team: { ...team, defaultIssueState: state } } });
				if (query.includes('JamisValidateCreateState'))
					return Response.json({ data: { workflowState: state } });
				if (query.includes('mutation JamisCreateIssue')) {
					mutations.push(variables.input);
					if (lostResponse)
						throw new Error('linear-create-fixture-secret linear-create-fixture-access');
					return Response.json({ data: { issueCreate: { success: true, issue: { id: variables.input.id, identifier: 'JAM-999', title: variables.input.title, url: 'https://linear.app/fixture/issue/JAM-999', state: { name: 'Backlog', type: 'backlog' }, updatedAt: '2026-10-01T00:00:00.000Z', team: { id: teamId } } } } });
				}
			}
			if (url.startsWith('https://api.sendblue.co/')) {
				if (url.endsWith('/send-message')) {
					const text = JSON.parse(String(init!.body)).content;
					if ((failResultPost && text.startsWith('Created')) || (failProposalPost && text.startsWith('Create Linear issue')))
						throw new Error('sendblue-create-fixture-secret');
					if (rejectedProposalPost && text.startsWith('Create Linear issue'))
						return Response.json({ message_handle: randomUUID(), status: 'ERROR', error_message: 'sendblue-create-fixture-secret' });
					posts.push(text);
				}
				return Response.json({ message_handle: randomUUID(), status: 'SENT' });
			}
			throw new Error('Unstubbed fixture request refused');
		}) as typeof fetch;
		const adapter = createSendblueAdapter({ webhookSecret: process.env.SENDBLUE_WEBHOOK_SECRET });
		Object.assign(adapter, { isDM: (id: string) => !adapter.decodeThreadId(id).groupId });
		const post = adapter.postMessage.bind(adapter);
		adapter.postMessage = async (...args) => {
			const result = await post(...args);
			requireSendbluePostAcceptance(result);
			return result;
		};
		adapter.fetchMessages = async () => ({ messages: history, hasMore: false });
		const observability = new Observability({ configs: { test: {
			serviceName: 'linear-create-fixture',
			spanOutputProcessors: [redactChannelRenderContext],
			exporters: [{ name: 'capture', onTracingEvent(event) {
				if (event.type === TracingEventType.SPAN_ENDED)
					spans.push(event.exportedSpan);
			}, exportTracingEvent: async () => {}, flush: async () => {}, shutdown: async () => {} }],
		} } });
		const child = new Agent({ id: 'personal-accounts-agent', name: 'Account fixture', instructions: 'Propose only the requested create.', tools: { linearCreateProposalTool }, model: model([{ tool: 'linearCreateProposalTool', input: { action: 'create', title: 'Exact fixture title', description: 'Exact fixture description' } }, { text: 'Proposal posted. Do not send another response.' }], prompts) });
		const agent = new Agent({
			id: 'jamis',
			name: 'Jamis fixture',
			instructions: 'Delegate creation; do not respond after the proposal.',
			model: model([{ tool: 'agent-personalAccountsAgent', input: { prompt: 'Create one fixture issue.' } }, { text: '' }], prompts),
			agents: { personalAccountsAgent: child },
			defaultOptions: { maxSteps: 3, delegation: { messageFilter: () => [] } },
			memory: new Memory({ options: { semanticRecall: false, workingMemory: { enabled: false } } }),
			channels: { adapters: { sendblue: { adapter, gateway: false, toolDisplay: 'hidden' } }, handlers: { onDirectMessage: (thread, message, handler, context) => handleSendblueDirectMessage(thread, message, handler, context, sql), onMention: false, onSubscribedMessage: false } },
		});
		const mastra = new Mastra({ storage: store, agents: { jamis: agent }, observability, logger: false });
		const channels = agent.getChannels()!;
		await channels.initialize(mastra);
		const line = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
		async function send(text: string, id: string = randomUUID(), addHistory = true) {
			const payload = { message_handle: id, content: text, from_number: process.env.JAMIS_ALLOWED_NUMBER!, to_number: line, group_id: '', is_outbound: false, status: 'RECEIVED', service: 'iMessage', date_sent: '2026-10-01T00:00:00.000Z' };
			const message = adapter.parseMessage(payload as never);
			if (addHistory)
				history.push(message);
			const tasks: Promise<unknown>[] = [];
			await channels.sdk!.webhooks.sendblue(new Request('http://localhost/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'sb-signing-secret': process.env.SENDBLUE_WEBHOOK_SECRET! }, body: JSON.stringify(payload) }), { waitUntil: task => tasks.push(task), propagateHandlerErrors: true });
			await Promise.all(tasks);
			return message;
		}
		return {
			posts,
			mutations,
			prompts,
			spans,
			send,
			adapter,
			history,
			mastra,
			channels,
			setLost: () => { lostResponse = true; },
			setFailResult: (value: boolean) => { failResultPost = value; },
			setFailProposal: () => { failProposalPost = true; },
			setRejectedProposal: () => { rejectedProposalPost = true; },
			async close() {
				await channels.sdk!.shutdown();
				await observability.getInstance('test')!.flush();
				globalThis.fetch = originalFetch;
			},
		};
	}

	test('native dispatch delegates authority, confirms equal-timestamp messages once, and keeps credentials out of memory/traces', async () => {
		const f = await fixture();
		try {
			const source = await f.send('Create one fixture issue.');
			expect(f.posts).toHaveLength(1);
			expect(f.posts[0]).toContain('Next reply: confirm | decline');
			expect(f.mutations).toHaveLength(0);
			const proposal = (await readLinearProposal(source.threadId, sql))!;
			expect(proposal.session_id).toBeTruthy();
			const confirmation = await f.send('confirm');
			await f.send('confirm', confirmation.id, false);
			await f.send('confirm');
			expect(f.mutations).toHaveLength(1);
			expect(f.posts.filter(text => text.startsWith('Created'))).toHaveLength(1);
			await f.close();
			const messages = await (await store.getStore('memory'))!.listMessages({ threadId: proposal.session_id });
			const leakedPaths: string[] = [];
			function scan(value: unknown, path: string) {
				if (typeof value === 'string' && /linear-create-fixture-secret|linear-create-fixture-access|sendblue-create-fixture-secret/.test(value))
					leakedPaths.push(path);
				if (value && typeof value === 'object') {
					for (const [key, nested] of Object.entries(value)) scan(nested, `${path}.${key}`);
				}
			}
			scan({ messages, spans: f.spans, prompts: f.prompts, proposal }, 'fixture');
			expect(leakedPaths).toEqual([]);
			expect(f.spans.length).toBeGreaterThan(0);
		}
		finally { await f.close(); }
	}, 15000);

	test('cancel, other message, nonexact confirm, provider-history gap, and /new prevent create', async () => {
		for (const text of ['decline', 'cancel', 'unrelated', 'yes', 'Confirm', 'confirm!', '/new', 'login openai', 'confirm']) {
			const f = await fixture();
			try {
				const source = await f.send('Create one fixture issue.');
				if (text === 'confirm')
					f.history.push({ id: randomUUID(), threadId: source.threadId, author: { userId: process.env.JAMIS_ALLOWED_NUMBER }, text: 'Unreceived intervening message' } as Message<SendblueMessagePayload>);
				await f.send(text);
				if (text === 'decline')
					expect(f.posts).toContain('Linear create proposal canceled.');
				expect(f.mutations).toHaveLength(0);
				expect(await readLinearProposal(source.threadId, sql)).toBeNull();
			}
			finally { await f.close(); }
		}
	}, 15000);

	test('native lost mutation response and failed result posting do not resend; failed proposal posting never authorizes', async () => {
		for (const mode of ['lost', 'result', 'proposal', 'rejected-proposal']) {
			const f = await fixture();
			try {
				if (mode === 'proposal')
					f.setFailProposal();
				if (mode === 'rejected-proposal')
					f.setRejectedProposal();
				const source = await f.send('Create one fixture issue.');
				if (mode === 'lost')
					f.setLost();
				if (mode === 'result')
					f.setFailResult(true);
				if (mode === 'result')
					await expect(f.send('confirm')).rejects.toThrow();
				else await f.send('confirm');
				f.setFailResult(false);
				await f.send('confirm');
				expect(f.mutations).toHaveLength(mode.endsWith('proposal') ? 0 : 1);
				if (mode === 'lost')
					expect(f.posts.join(' ')).toContain('uncertain');
				if (mode === 'result')
					expect(f.posts.join(' ')).toContain('Created JAM-999');
				expect(await readLinearProposal(source.threadId, sql)).toBeNull();
				await f.close();
				for (const value of [f.posts, f.spans, f.prompts])
					expect(JSON.stringify(value)).not.toMatch(/linear-create-fixture-secret|linear-create-fixture-access|sendblue-create-fixture-secret/);
			}
			finally { await f.close(); }
		}
	}, 15000);

	test('direct/forged tool contexts lack authority; a simultaneous time-zone proposal cannot share confirm', async () => {
		expect(await proposeLinearCreate({ action: 'create', title: 'Denied' })).toEqual({ status: 'denied' });
		expect(await linearCreateProposalTool.execute!({ action: 'create', title: 'Denied', description: '' }, { observe: noopObserve, requestContext: new RequestContext([['channel', { platform: 'sendblue', isDM: true }]]) })).toEqual({ status: 'denied' });
		const f = await fixture();
		try {
			const source = await f.send('Create one fixture issue.');
			// Seed the legacy setting collision directly. Neither proposal may execute.
			expect(await saveOperatorTimeZoneProposal('Asia/Tokyo', source.threadId, source.id, source.metadata.dateSent, sql)).toBe(true);
			await f.send('confirm');
			expect(f.mutations).toHaveLength(0);
			expect(await readLinearProposal(source.threadId, sql)).toBeNull();
		}
		finally { await f.close(); }
	});

	test('native /new replay preserves a newer proposal; a fresh rollover cancels it', async () => {
		const f = await fixture();
		try {
			const command = await f.send('/new');
			const source = await f.send('Create one fixture issue.');
			const pending = (await readLinearProposal(source.threadId, sql))!;
			await f.send('/new', command.id, false);
			expect((await readLinearProposal(source.threadId, sql))!.id).toBe(pending.id);
			await f.send('/new');
			expect(await readLinearProposal(source.threadId, sql)).toBeNull();
			expect(f.mutations).toHaveLength(0);
		}
		finally { await f.close(); }
	});

	test('nonoperator/group/other-channel messages cannot consume a proposal; a changed active session cancels confirmation', async () => {
		const f = await fixture();
		try {
			const source = await f.send('Create one fixture issue.');
			const proposal = (await readLinearProposal(source.threadId, sql))!;
			const thread = f.channels.sdk!.thread(source.threadId);
			for (const [badThread, badMessage] of [
				[thread, { ...source, id: randomUUID(), text: 'confirm', author: { ...source.author, userId: '+15559999999' } }],
				[{ ...thread, isDM: false, adapter: f.adapter }, source],
				[{ ...thread, adapter: { name: 'other' } }, source],
			] as [Thread, Message][]) {
				await handleSendblueDirectMessage(badThread, badMessage, async () => {
					throw new Error('Unexpected agent');
				}, undefined, sql);
				expect((await readLinearProposal(source.threadId, sql))!.id).toBe(proposal.id);
			}
			const memory = (await store.getStore('memory'))!;
			await startJamisDmSession(memory, thread, { ...source, id: randomUUID(), text: '/new' } as Message);
			await f.send('confirm');
			expect(f.mutations).toHaveLength(0);
			expect(await readLinearProposal(source.threadId, sql)).toBeNull();
		}
		finally { await f.close(); }
	});
}
