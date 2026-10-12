import type { ChannelConfig } from '@mastra/core/channels';
import type { Message, Thread } from 'chat';
import type { SendblueMessagePayload } from 'chat-adapter-sendblue';
import type { LinearCreateOperation } from '../../../lib/linear';
import type { SqlLike } from '../../../lib/operator-time-zone';

import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { TracingEventType } from '@mastra/core/observability';
import { RequestContext } from '@mastra/core/request-context';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createTool, noopObserve } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { Observability } from '@mastra/observability';
import { PostgresStore } from '@mastra/pg';
import { SQL } from 'bun';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createSendblueAdapter } from 'chat-adapter-sendblue';
import { z } from 'zod';
import { claimLinearCreate, finishLinearCreate, isImmediatelyFollowingLinearMessage, notifyLinearOutcome, postLinearCreateProposal, readLinearContinuation, readLinearProposal, receiveLinearMessage } from '../../../lib/linear-proposals';
import { clearOperatorTimeZoneConversation, saveOperatorTimeZoneProposal } from '../../../lib/operator-time-zone';
import { redactChannelRenderContext } from '../../observability';
import { specialistClarificationKey } from '../../specialist-clarification';

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

	test('clarification receipt lookup requires the exact immediately preceding DM source', async () => {
		const dm = randomUUID();
		await receiveLinearMessage(dm, 'source', sql);
		expect(await isImmediatelyFollowingLinearMessage(dm, 'next', 'source', sql)).toBe(false);
		await receiveLinearMessage(dm, 'next', sql);
		expect(await isImmediatelyFollowingLinearMessage(dm, 'next', 'source', sql)).toBe(true);
		expect(await isImmediatelyFollowingLinearMessage(dm, 'source', 'next', sql)).toBe(false);
		expect(await isImmediatelyFollowingLinearMessage(randomUUID(), 'next', 'source', sql)).toBe(false);
		await receiveLinearMessage(dm, 'source', sql);
		expect(await isImmediatelyFollowingLinearMessage(dm, 'next', 'source', sql)).toBe(true);
		await receiveLinearMessage(dm, 'other', sql);
		expect(await isImmediatelyFollowingLinearMessage(dm, 'other', 'source', sql)).toBe(false);
		expect(await isImmediatelyFollowingLinearMessage(dm, 'next', 'source', sql)).toBe(false);
		expect(await isImmediatelyFollowingLinearMessage(dm, 'other', 'other', sql)).toBe(false);
	});

	test('only acknowledged publication enables confirmation, including lost readiness acknowledgements', async () => {
		for (const mode of ['publication-ack', 'readiness-write', 'readiness-ack']) {
			const dm = randomUUID();
			const op = operation();
			await receiveLinearMessage(dm, 'source', sql);
			const wrapped: SqlLike = async (strings, ...values) => {
				if (strings.join('').includes('SET publication_ready = TRUE')) {
					if (mode === 'readiness-write')
						throw new Error('Synthetic readiness write failure.');
					const result = await sql(strings, ...values);
					throw new Error(`Synthetic ${result.length} readiness acknowledgement lost.`);
				}
				return sql(strings, ...values);
			};
			wrapped.begin = async (work) => {
				const result = await sql.begin(work);
				if (mode === 'publication-ack')
					throw new Error('Synthetic publication acknowledgement lost.');
				return result;
			};
			if (mode === 'publication-ack')
				await expect(postLinearCreateProposal(op, dm, 'session', 'source', async () => {}, wrapped)).rejects.toThrow();
			else
				expect(await postLinearCreateProposal(op, dm, 'session', 'source', async () => {}, wrapped)).toBe(true);
			const proposal = (await readLinearProposal(dm, sql))!;
			expect(proposal.publication_ready).toBe(mode === 'readiness-ack');
			await receiveLinearMessage(dm, 'confirm', sql);
			expect(await claimLinearCreate({ ...proposal, publication_ready: true }, 'session', 'confirm', true, sql)).toBe(mode === 'readiness-ack');
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

	const { CODEX_AUTH_CHANNEL_ERROR, EMPTY_REPLY_CHANNEL_ERROR, formatSendblueError, handleSendblueDirectMessage, OPENAI_LOGIN_FAILURE, proposeLinearCreate, registerLinearReplyProcedure, requireSendbluePostAcceptance, startJamisDmSession } = await import('../sendblue');
	const { recordAccountsGmailRead } = await import('../../tools/invoke-specialist');
	const { linearCreateProposalTool, linearReadTool } = await import('../../tools/linear');
	const { createJamisAgent } = await import('../../agents/jamis');
	const { boundaryModel } = await import('../../agents/__tests__/specialist-boundary.fixture');
	const originalFetch = globalThis.fetch;
	type Action = { tool: string; input: Record<string, unknown> } | { text: string } | { error: string };
	function model(actions: Action[], prompts: unknown[]) {
		let step = 0;
		return new MastraLanguageModelV2Mock({ doStream: async (options) => {
			prompts.push(options.prompt);
			const action = actions[step++] ?? { text: '' };
			if ('error' in action)
				throw new Error(action.error);
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

	async function fixture(options: { description?: string; reply?: string; unavailable?: boolean; denied?: boolean; modelError?: boolean; read?: boolean; typed?: boolean; linked?: boolean; clarify?: boolean; badDraft?: boolean; inspectionMissing?: boolean; accountsHandbackFailure?: boolean; sourceMode?: 'missing' | 'missing_body' | 'ambiguous' | 'truncated' | 'forged' } = {}) {
		await clearOperatorTimeZoneConversation(sql);
		let channelSql: SqlLike = sql;
		const posts: string[] = [];
		const mutations: unknown[] = [];
		const prompts: unknown[] = [];
		const typedToolResults: unknown[] = [];
		const spans: unknown[] = [];
		const history: Message<SendblueMessagePayload>[] = [];
		const email = { subject: 'Fixture email', from: 'fixture@example.com', date: '2026-10-01T00:00:00.000Z', body: 'PRIVATE_STAGE3_SENTINEL. Please track this request.' };
		const proposalInput = { action: 'create', title: 'Exact fixture title', description: 'Exact fixture description', ...(options.linked ? { replySourceRef: randomUUID() as string } : {}) };
		let gmailReads = 0;
		let inspectionReads = 0;
		const draftPrompts: unknown[] = [];
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
				if (query.includes('JamisList'))
					return Response.json({ data: { results: { nodes: [{ id: stateId, identifier: 'JAM-998', title: 'Fixture backlog issue', url: 'https://linear.app/fixture/issue/JAM-998', state: { name: 'Backlog', type: 'backlog' }, updatedAt: '2026-10-01T00:00:00.000Z', team: { id: teamId } }], pageInfo: { hasNextPage: false, endCursor: null } } } });
				if (options.unavailable)
					return new Response('linear-create-fixture-secret', { status: 503 });
				if (query.includes('JamisDefaultCreateState'))
					return Response.json({ data: { team: { ...team, defaultIssueState: state } } });
				if (query.includes('JamisValidateCreateState'))
					return Response.json({ data: { workflowState: state } });
				if (query.includes('JamisInspectCreate')) {
					inspectionReads++;
					const created = mutations.at(-1) as LinearCreateOperation | undefined;
					return Response.json({ data: { issue: options.inspectionMissing || !created ? null : { id: created.id, identifier: 'JAM-999', title: created.title, description: created.description, url: 'https://linear.app/fixture/issue/JAM-999', team: { id: teamId }, state: { id: created.stateId, name: 'Backlog' } } } });
				}
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
		const child = new Agent({ id: options.denied ? 'wrong-account-agent' : 'personal-accounts-agent', name: 'Account fixture', instructions: 'Propose only the requested create.', tools: { linearCreateProposalTool, linearReadTool }, model: model([...(options.read ? [{ tool: 'linearReadTool', input: { action: 'list', stateType: 'backlog' } }] : []), { tool: 'linearCreateProposalTool', input: { action: 'create', title: 'Exact fixture title', description: options.description ?? 'Exact fixture description' } }, { text: options.read ? 'Proposal posted. Backlog: JAM-998, Fixture backlog issue.' : 'Proposal posted. Do not send another response.' }], prompts) });
		let mastra = new Mastra({ storage: store, observability, logger: false });
		const gmailFixture = createTool({
			id: 'gmail-search',
			description: 'Read one synthetic email.',
			inputSchema: z.object({}).strict(),
			execute: async (_, context) => {
				gmailReads++;
				const receipt = { estimatedTotal: options.sourceMode === 'ambiguous' ? 2 : 1, messages: [
					{ ...email, snippet: 'Fixture', ...(options.sourceMode === 'missing_body' ? { body: undefined } : options.sourceMode === 'truncated' ? { body: `${email.body}\n... (truncated)` } : {}) },
					...(options.sourceMode === 'ambiguous' ? [{ ...email, subject: 'Another fixture email', snippet: 'Fixture' }] : []),
				] };
				const result = recordAccountsGmailRead(context.requestContext, receipt);
				if (options.sourceMode !== 'forged')
					proposalInput.replySourceRef = result.messageRefs![0]!;
				return result;
			},
		});
		const draftModel = boundaryModel([{ handback: { case: 'completed', result: { replyText: options.badDraft ? 'Missing the verified issue link.' : 'I have tracked your request at https://linear.app/fixture/issue/JAM-999.' } } }], value => draftPrompts.push(value));
		if (options.linked)
			registerLinearReplyProcedure(mastra, sql, draftModel);
		const typedNeed = { case: 'needs_help', need: { kind: 'approval', operationId: '00000000-0000-4000-8000-000000000000' }, progress: null };
		const channelsConfig: ChannelConfig = { adapters: { sendblue: { adapter, formatError: formatSendblueError, gateway: false, toolDisplay: 'hidden' } }, handlers: { onDirectMessage: (thread, message, handler, context) => handleSendblueDirectMessage(thread, message, handler, context, channelSql), onMention: false, onSubscribedMessage: false } };
		const agent = options.typed
			? createJamisAgent({
					mastra,
					tools: {},
					model: boundaryModel([{ tool: 'invoke_personal_accounts', input: { question: 'Propose one exact fixture issue.' } }, { text: options.reply ?? (options.clarify ? 'Which email?' : JSON.stringify({ otherAnswers: [] })) }, ...(options.clarify ? [{ tool: 'invoke_personal_accounts', input: { question: 'Use the selected email for the original issue and linked reply task.', continueClarification: true } }, { text: JSON.stringify({ otherAnswers: [] }) }] : [])], (value) => {
						prompts.push(value);
						typedToolResults.push(...(value as { prompt: Array<{ role: string; content: unknown }> }).prompt.filter(message => message.role === 'tool').map(message => message.content));
					}),
					memory: new Memory({ options: { semanticRecall: false, workingMemory: { enabled: false } } }),
					channels: channelsConfig,
					specialists: { personalAccounts: { tools: { linearCreateProposalTool, ...(options.linked ? { gmailSearchTool: gmailFixture } : {}) }, model: boundaryModel([
						...(options.clarify ? [{ handback: { case: 'needs_help', need: { kind: 'input', question: 'Which email?', missing: ['selected email'] }, progress: null } }] : []),
						...(options.linked && options.sourceMode !== 'missing' ? [{ tool: 'gmailSearchTool', input: {} }] : []),
						...(options.accountsHandbackFailure ? [] : [{ tool: 'linearCreateProposalTool', input: proposalInput }]),
						{ handback: typedNeed },
					], (value) => {
						prompts.push(value);
						const operationId = /Pending operation: ([a-f0-9-]{36})/.exec(JSON.stringify(value))?.[1];
						if (operationId)
							typedNeed.need.operationId = operationId;
					}) } },
				})
			: new Agent({
					id: 'jamis',
					name: 'Jamis fixture',
					instructions: 'Delegate creation; do not respond after the proposal.',
					model: model([{ tool: 'agent-personalAccountsAgent', input: { prompt: 'Create one fixture issue.' } }, options.modelError ? { error: 'Model authentication failed. The error was logged.' } : { text: options.reply ?? '' }], prompts),
					agents: { personalAccountsAgent: child },
					defaultOptions: { maxSteps: 3, delegation: { messageFilter: () => [] } },
					memory: new Memory({ options: { semanticRecall: false, workingMemory: { enabled: false } } }),
					channels: { adapters: { sendblue: { adapter, formatError: formatSendblueError, gateway: false, toolDisplay: 'hidden' } }, handlers: { onDirectMessage: (thread, message, handler, context) => handleSendblueDirectMessage(thread, message, handler, context, channelSql), onMention: false, onSubscribedMessage: false } },
				});
		mastra.addAgent(agent, 'jamis');
		let channels = agent.getChannels()!;
		await channels.initialize(mastra);
		const line = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
		async function send(text: string, id: string = randomUUID(), addHistory = true, dateSent = '2026-10-01T00:00:00.000Z') {
			const payload = { message_handle: id, content: text, from_number: process.env.JAMIS_ALLOWED_NUMBER!, to_number: line, group_id: '', is_outbound: false, status: 'RECEIVED', service: 'iMessage', date_sent: dateSent };
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
			email,
			mutations,
			prompts,
			typedToolResults,
			spans,
			send,
			adapter,
			history,
			get mastra() { return mastra; },
			get channels() { return channels; },
			draftPrompts,
			counts: () => ({ gmailReads, inspectionReads }),
			async restart() {
				await channels.sdk!.shutdown();
				mastra = new Mastra({ storage: store, observability, logger: false });
				registerLinearReplyProcedure(mastra, sql, draftModel);
				const replacement = createJamisAgent({ mastra, model: boundaryModel([{ text: 'No pending action.' }]), tools: {}, memory: new Memory({ options: { semanticRecall: false, workingMemory: { enabled: false } } }), channels: channelsConfig });
				mastra.addAgent(replacement, 'jamis');
				channels = replacement.getChannels()!;
				await channels.initialize(mastra);
			},
			setSql: (value: SqlLike) => { channelSql = value; },
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

	test('linked reply survives restart, retains the selected source, and completes once on exact confirmation', async () => {
		const f = await fixture({ typed: true, linked: true });
		try {
			const source = await f.send('Turn my latest email into one issue, then draft reply text linking it.');
			const proposal = (await readLinearProposal(source.threadId, sql))!;
			expect(proposal.continuation?.workflowId).toBe('prepare_linear_reply');
			const saved = await f.mastra.getWorkflow('prepare_linear_reply').getWorkflowRunById(proposal.continuation!.runId);
			expect(saved?.status).toBe('suspended');
			expect(saved?.payload?.assignment).toBe(source.text);
			expect(saved?.payload?.source).toEqual(f.email);
			expect(f.posts).toHaveLength(1);
			await f.restart();
			const confirm = await f.send('confirm');
			expect(f.posts).toHaveLength(2);
			expect(f.posts[1]).toContain('Created JAM-999: https://linear.app/fixture/issue/JAM-999\n\nReply draft:');
			expect(f.draftPrompts).toHaveLength(1);
			expect(JSON.stringify(f.draftPrompts)).toContain('PRIVATE_STAGE3_SENTINEL');
			expect(f.counts()).toEqual({ gmailReads: 1, inspectionReads: 0 });
			await f.restart();
			await f.send('confirm', confirm.id, false);
			expect(f.posts).toHaveLength(2);
			expect(f.mutations).toHaveLength(1);
			expect(f.draftPrompts).toHaveLength(1);
			expect((await f.mastra.getWorkflow('prepare_linear_reply').getWorkflowRunById(proposal.continuation!.runId))?.status).toBe('success');
		}
		finally { await f.close(); }
	}, 30_000);

	test('missing, missing-body, ambiguous, truncated, or fabricated email evidence cannot publish the linked proposal', async () => {
		for (const sourceMode of ['missing', 'missing_body', 'ambiguous', 'truncated', 'forged'] as const) {
			const f = await fixture({ typed: true, linked: true, sourceMode });
			try {
				const source = await f.send('Create an issue from my email, then draft a linked reply.');
				expect(f.counts().gmailReads).toBe(sourceMode === 'missing' ? 0 : 1);
				expect(await readLinearProposal(source.threadId, sql)).toBeNull();
				expect(f.posts.some(text => text.startsWith('Create Linear issue'))).toBe(false);
				await f.send('confirm');
				expect(f.mutations).toHaveLength(0);
				expect(f.draftPrompts).toHaveLength(0);
			}
			finally { await f.close(); }
		}
	}, 30_000);

	test('Accounts clarification retains original reply constraints and actual Operator answer privately', async () => {
		const f = await fixture({ typed: true, linked: true, clarify: true });
		try {
			const original = 'Create an issue from the selected email, then draft a concise reply linking it without promising a deadline.';
			const first = await f.send(original);
			expect(f.posts).toEqual(['Which email?']);
			const memory = (await store.getStore('memory'))!;
			const sessions = await memory.listThreads({ filter: { metadata: { channel_externalThreadId: first.threadId } }, perPage: 1 });
			expect(sessions.threads[0]?.metadata?.[specialistClarificationKey]).toMatchObject({ clarification: { originalAccountsRequest: original } });
			const selection = await f.send('The selected email, and keep the reply formal.', randomUUID(), true, '2026-10-01T00:00:01.000Z');
			const proposal = (await readLinearProposal(selection.threadId, sql))!;
			expect(proposal).not.toBeNull();
			const saved = await f.mastra.getWorkflow('prepare_linear_reply').getWorkflowRunById(proposal.continuation!.runId);
			expect(saved?.payload?.assignment).toBe(`${original}\n\nOperator clarification:\n${selection.text}`);
			await f.restart();
			await f.send('confirm', randomUUID(), true, '2026-10-01T00:00:02.000Z');
			expect(JSON.stringify(f.draftPrompts)).toContain('without promising a deadline');
			expect(JSON.stringify(f.draftPrompts)).toContain('keep the reply formal');
			expect(f.mutations).toHaveLength(1);
			expect(f.counts().gmailReads).toBe(1);
		}
		finally { await f.close(); }
	}, 30_000);

	test('legacy Accounts clarification without original scope requires restatement before a linked proposal', async () => {
		const f = await fixture({ typed: true, linked: true, clarify: true });
		try {
			const first = await f.send('Create an email issue and draft a linked reply.');
			const memory = (await store.getStore('memory'))!;
			const { threads } = await memory.listThreads({ filter: { metadata: { channel_externalThreadId: first.threadId } }, perPage: 1 });
			await memory.updateThreadMetadata({ id: threads[0].id, update: (thread) => {
				const stored = thread.metadata![specialistClarificationKey] as { sourceMessageId: string; clarification: Record<string, unknown> };
				const { originalAccountsRequest: _request, ...clarification } = stored.clarification;
				return { ...thread.metadata, [specialistClarificationKey]: { ...stored, clarification } };
			} });
			const selected = await f.send('That email.', randomUUID(), true, '2026-10-01T00:00:01.000Z');
			expect(await readLinearProposal(selected.threadId, sql)).toBeNull();
			expect(f.posts.some(text => text.startsWith('Create Linear issue'))).toBe(false);
			expect(f.mutations).toHaveLength(0);
		}
		finally { await f.close(); }
	}, 30_000);

	test('lost proposal commit acknowledgement leaves a displayed linked proposal unable to create', async () => {
		const f = await fixture({ typed: true, linked: true });
		try {
			const wrapped: SqlLike = (strings, ...values) => sql(strings, ...values);
			wrapped.begin = async (work) => {
				let publication = false;
				const result = await sql.begin(tx => work((strings, ...values) => {
					publication ||= strings.join('').includes('INSERT INTO linear_create_proposals');
					return tx(strings, ...values);
				}));
				if (publication)
					throw new Error('Synthetic proposal commit acknowledgement lost.');
				return result;
			};
			f.setSql(wrapped);
			const source = await f.send('Create an email issue and draft a linked reply.');
			const proposal = (await readLinearProposal(source.threadId, sql))!;
			expect(proposal.publication_ready).toBe(false);
			expect(f.posts[0]).toContain('Create Linear issue');
			expect(f.posts[1]).toContain('Nothing is authorized');
			f.setSql(sql);
			await f.restart();
			await f.send('confirm');
			expect(f.mutations).toHaveLength(0);
			expect(f.draftPrompts).toHaveLength(0);
			expect((await readLinearContinuation(proposal.id, sql))?.state).toBe('canceled');
		}
		finally { await f.close(); }
	}, 30_000);

	test('lost create response uses one exact-ID inspection, preserves uncertainty, and drafts only verified matches', async () => {
		for (const inspectionMissing of [false, true]) {
			const f = await fixture({ typed: true, linked: true, inspectionMissing });
			try {
				const source = await f.send('Create an email issue, then draft a reply linking it.');
				const proposal = (await readLinearProposal(source.threadId, sql))!;
				f.setLost();
				const confirm = await f.send('confirm');
				const saved = (await readLinearContinuation(proposal.id, sql))!;
				expect(saved.state).toBe('uncertain');
				expect(saved.outcome).toEqual({ status: 'uncertain' });
				expect(saved.inspection?.status).toBe(inspectionMissing ? 'unresolved' : 'verified');
				expect(f.draftPrompts).toHaveLength(inspectionMissing ? 0 : 1);
				expect(f.posts[1]).toContain(inspectionMissing ? 'outcome is uncertain' : 'Reply draft:');
				await f.restart();
				await f.send('confirm', confirm.id, false);
				expect(f.counts().inspectionReads).toBe(1);
				expect(f.mutations).toHaveLength(1);
			}
			finally { await f.close(); }
		}
	}, 30_000);

	test('failed final reply posting survives an older message replay after restart without another read or mutation', async () => {
		const f = await fixture({ typed: true, linked: true });
		try {
			const session = await f.send('/new');
			const olderId = randomUUID();
			await receiveLinearMessage(session.threadId, olderId, sql);
			const source = await f.send('Create an email issue, then draft a linked reply.');
			const proposal = (await readLinearProposal(source.threadId, sql))!;
			const confirmId = randomUUID();
			f.setFailResult(true);
			await expect(f.send('confirm', confirmId)).rejects.toThrow();
			expect((await readLinearContinuation(proposal.id, sql))?.notified).toBe(false);
			expect(f.draftPrompts).toHaveLength(1);
			f.setFailResult(false);
			await f.restart();
			await f.send('An earlier unrelated request.', olderId, false);
			expect((await f.mastra.getWorkflow('prepare_linear_reply').getWorkflowRunById(proposal.continuation!.runId))?.status).toBe('suspended');
			await f.send('confirm', confirmId, false);
			expect(f.posts.at(-1)).toContain('Reply draft:');
			expect(f.draftPrompts).toHaveLength(1);
			expect(f.mutations).toHaveLength(1);
			expect(f.counts().gmailReads).toBe(1);
		}
		finally { await f.close(); }
	}, 30_000);

	test('draft validation failure and missing snapshots report the verified issue with the missing reply', async () => {
		for (const missing of [false, true]) {
			const f = await fixture({ typed: true, linked: true, badDraft: true });
			try {
				const source = await f.send('Create an email issue and draft a linked reply.');
				const proposal = (await readLinearProposal(source.threadId, sql))!;
				if (missing)
					await (await store.getStore('workflows'))!.deleteWorkflowRunById({ workflowName: 'prepare_linear_reply', runId: proposal.continuation!.runId });
				const confirm = await f.send('confirm');
				expect(f.posts[1]).toContain('Created JAM-999: https://linear.app/fixture/issue/JAM-999');
				expect(f.posts[1]).toContain(missing ? 'reply draft is unavailable' : 'reply draft could not be prepared');
				await f.send('confirm', confirm.id, false);
				expect(f.mutations).toHaveLength(1);
				expect(f.draftPrompts).toHaveLength(missing ? 0 : 1);
			}
			finally { await f.close(); }
		}
	}, 30_000);

	test('accepted outcome notification cannot hide a draft whose final acceptance snapshot failed', async () => {
		const f = await fixture({ typed: true, linked: true });
		const storage = (await store.getStore('workflows'))!;
		const update = storage.updateWorkflowState.bind(storage);
		let failAck = true;
		const spy = spyOn(storage, 'updateWorkflowState').mockImplementation(async (args) => {
			if (failAck && f.draftPrompts.length && args.opts.expectedStatus === 'suspended') {
				failAck = false;
				throw new Error('Synthetic reply acceptance persistence failure.');
			}
			return update(args);
		});
		try {
			const source = await f.send('Create an email issue, then draft a linked reply.');
			const proposal = (await readLinearProposal(source.threadId, sql))!;
			const confirmId = randomUUID();
			await expect(f.send('confirm', confirmId)).rejects.toThrow();
			expect((await readLinearContinuation(proposal.id, sql))?.notified).toBe(true);
			spy.mockRestore();
			await f.restart();
			await f.send('confirm', confirmId, false);
			expect(f.draftPrompts).toHaveLength(1);
			expect(f.mutations).toHaveLength(1);
			expect((await f.mastra.getWorkflow('prepare_linear_reply').getWorkflowRunById(proposal.continuation!.runId))?.status).toBe('success');
		}
		finally {
			spy.mockRestore();
			await f.close();
		}
	}, 30_000);

	test('inspection persistence failure retains uncertain evidence, reports it, and never retries the read', async () => {
		const f = await fixture({ typed: true, linked: true });
		try {
			const source = await f.send('Create an email issue, then draft a linked reply.');
			const proposal = (await readLinearProposal(source.threadId, sql))!;
			f.setLost();
			const failing: SqlLike = (strings, ...values) => {
				if (strings.join('').includes('inspection->>\'status\' = \'unresolved\''))
					throw new Error('Synthetic inspection persistence failure.');
				return sql(strings, ...values);
			};
			failing.begin = work => sql.begin(work);
			f.setSql(failing);
			const confirm = await f.send('confirm');
			expect(f.posts[1]).toContain('outcome is uncertain');
			expect((await readLinearContinuation(proposal.id, sql))?.inspection?.status).toBe('unresolved');
			f.setSql(sql);
			await f.send('confirm', confirm.id, false);
			expect(f.counts().inspectionReads).toBe(1);
			expect(f.draftPrompts).toHaveLength(0);
			expect(f.mutations).toHaveLength(1);
		}
		finally { await f.close(); }
	}, 30_000);

	test('decline, supersession, and session rollover stop linked work without concealing saved effects', async () => {
		for (const command of ['decline', 'unrelated', '/new']) {
			const f = await fixture({ typed: true, linked: true });
			try {
				const source = await f.send('Create an email issue and draft a linked reply.');
				const proposal = (await readLinearProposal(source.threadId, sql))!;
				await f.send(command);
				expect((await f.mastra.getWorkflow('prepare_linear_reply').getWorkflowRunById(proposal.continuation!.runId))?.status).toBe(command === 'decline' ? 'success' : 'canceled');
				await f.send('confirm');
				expect(f.mutations).toHaveLength(0);
				expect(f.draftPrompts).toHaveLength(0);
				expect((await f.mastra.getWorkflow('prepare_linear_reply').getWorkflowRunById(proposal.continuation!.runId))?.status).toBe(command === 'decline' ? 'success' : 'canceled');
			}
			finally { await f.close(); }
		}
		const f = await fixture({ typed: true, linked: true });
		try {
			const source = await f.send('Create an email issue and draft a linked reply.');
			const proposal = (await readLinearProposal(source.threadId, sql))!;
			const confirmId = randomUUID();
			f.setFailResult(true);
			await expect(f.send('confirm', confirmId)).rejects.toThrow();
			f.setFailResult(false);
			await f.send('A different task.');
			await f.send('confirm', confirmId, false);
			expect(f.posts.some(text => text.includes('Reply draft:'))).toBe(false);
			expect(f.posts.some(text => text.startsWith('Created JAM-999'))).toBe(true);
			expect(f.mutations).toHaveLength(1);
			expect(f.draftPrompts).toHaveLength(1);
			expect((await f.mastra.getWorkflow('prepare_linear_reply').getWorkflowRunById(proposal.continuation!.runId))?.status).toBe('canceled');
		}
		finally { await f.close(); }
	}, 30_000);

	test('failed Accounts before a proposal never exposes the internal reply envelope', async () => {
		const honest = 'I could not verify enough to propose the issue.';
		for (const reply of [JSON.stringify({ otherAnswers: [] }), JSON.stringify({ otherAnswers: [honest], proposalStatus: 'The proposal was posted.' }), honest]) {
			const f = await fixture({ typed: true, linked: true, accountsHandbackFailure: true, reply });
			try {
				const source = await f.send('Create an issue from the selected email, then draft a linked reply.');
				expect(f.counts().gmailReads).toBe(1);
				expect(f.spans.some(span => (span as { entityId?: string }).entityId === 'linearCreateProposalTool')).toBe(false);
				expect(await readLinearProposal(source.threadId, sql)).toBeNull();
				expect(await sql`SELECT id FROM linear_create_proposals WHERE dm_id = ${source.threadId} AND continuation IS NOT NULL`).toHaveLength(0);
				expect(f.mutations).toHaveLength(0);
				expect(f.draftPrompts).toHaveLength(0);
				expect(f.posts).toEqual([reply === JSON.stringify({ otherAnswers: [] }) ? EMPTY_REPLY_CHANNEL_ERROR : honest]);
				if (reply === JSON.stringify({ otherAnswers: [] })) {
					expect(f.spans).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'sendblue.channel', metadata: expect.objectContaining({ stage: 'reply_generation', classification: 'failed' }) })]));
				}
			}
			finally { await f.close(); }
		}
	}, 30_000);

	test('production typed Accounts proposal returns the runtime operation and exact native confirmation creates once', async () => {
		const f = await fixture({ typed: true });
		try {
			const source = await f.send('Create one fixture issue.');
			const proposal = (await readLinearProposal(source.threadId, sql))!;
			expect(proposal.state).toBe('pending');
			expect(f.posts).toHaveLength(1);
			expect(f.posts[0]).toContain('Next reply: confirm | decline');
			expect(JSON.stringify(f.prompts)).toContain(proposal.id);
			expect(f.typedToolResults).toEqual(expect.arrayContaining([expect.arrayContaining([expect.objectContaining({
				type: 'tool-result',
				toolName: 'invoke_personal_accounts',
				output: { type: 'json', value: { case: 'needs_help', need: { kind: 'approval', operationId: proposal.id }, progress: null } },
			})])]));
			expect(f.mutations).toHaveLength(0);
			const confirmation = await f.send('confirm');
			await f.send('confirm', confirmation.id, false);
			expect(f.mutations).toHaveLength(1);
			expect(f.posts.filter(text => text.startsWith('Created'))).toEqual(['Created JAM-999: https://linear.app/fixture/issue/JAM-999']);
			expect(await readLinearProposal(source.threadId, sql)).toBeNull();
		}
		finally { await f.close(); }
	}, 30_000);

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
	}, 30000);

	test('native validation/denial/unavailability cannot become posted success or silence', async () => {
		for (const mode of ['validation', 'denied', 'unavailable', 'rejected-proposal']) {
			for (const reply of ['', 'The proposal was posted.']) {
				const f = await fixture({ description: mode === 'validation' ? 'x'.repeat(8000) : undefined, denied: mode === 'denied', unavailable: mode === 'unavailable', reply });
				try {
					if (mode === 'rejected-proposal')
						f.setRejectedProposal();
					const source = await f.send('Create one fixture issue.');
					expect(f.posts).toEqual(['Linear create proposal could not be posted. Nothing is authorized. Please request a fresh proposal with a title, description of at most 2,000 characters, and optional exact status.']);
					expect(await readLinearProposal(source.threadId, sql)).toBeNull();
					expect(JSON.stringify(f.prompts)).not.toContain('Linear create proposal undefined');
					if (mode === 'validation')
						expect(JSON.stringify(f.spans)).toContain('Tool input validation failed');
					await f.send('confirm');
					expect(f.mutations).toHaveLength(0);
				}
				finally { await f.close(); }
			}
		}
	}, 30000);

	test('native mixed requests preserve verified issue reads and ignore model proposal status', async () => {
		for (const denied of [false, true]) {
			const answer = 'Backlog: JAM-998, Fixture backlog issue.';
			const f = await fixture({ denied, read: true, reply: JSON.stringify({ otherAnswers: [answer], proposalStatus: 'The proposal was posted.' }) });
			try {
				const source = await f.send('Create one fixture issue and read the backlog.');
				expect(JSON.stringify(f.prompts)).toContain('JAM-998');
				expect(f.posts).toContain(answer);
				expect(f.posts).toHaveLength(2);
				expect(f.posts.join(' ')).not.toContain('The proposal was posted.');
				expect(!!await readLinearProposal(source.threadId, sql)).toBe(!denied);
				expect(f.mutations).toHaveLength(0);
			}
			finally { await f.close(); }
		}
	}, 15000);

	test('native reauthentication errors remain visible after accepted or failed proposals', async () => {
		for (const denied of [false, true]) {
			const f = await fixture({ denied, modelError: true });
			try {
				const source = await f.send('Create one fixture issue.');
				expect(f.posts).toContain(CODEX_AUTH_CHANNEL_ERROR);
				expect(f.posts.filter(text => text === CODEX_AUTH_CHANNEL_ERROR)).toHaveLength(1);
				expect(!!await readLinearProposal(source.threadId, sql)).toBe(!denied);
				expect(f.mutations).toHaveLength(0);
			}
			finally { await f.close(); }
		}
	}, 15000);

	test('native accepted proposal suppresses redundant model success text', async () => {
		const f = await fixture({ reply: 'The proposal was posted.' });
		try {
			const source = await f.send('Create one fixture issue.');
			expect(f.posts).toHaveLength(1);
			expect(f.posts[0]).toContain('Title: Exact fixture title');
			expect(f.posts[0]).toContain('Description: Exact fixture description');
			expect((await readLinearProposal(source.threadId, sql))!.state).toBe('pending');
			expect(f.mutations).toHaveLength(0);
		}
		finally { await f.close(); }
	});

	test('native confirmation accepts capitalization, preserves trimming, and stays single-use', async () => {
		for (const text of ['Confirm', 'CONFIRM', 'cOnFiRm', ' Confirm ']) {
			const f = await fixture();
			try {
				const source = await f.send('Create one fixture issue.');
				await f.send(text);
				await f.send(text);
				expect(f.mutations).toHaveLength(1);
				expect(f.posts.filter(post => post.startsWith('Created'))).toHaveLength(1);
				expect(await readLinearProposal(source.threadId, sql)).toBeNull();
			}
			finally { await f.close(); }
		}
	}, 30000);

	test('cancel, other message, nonexact confirm, provider-history gap, and /new prevent create', async () => {
		for (const text of ['decline', 'cancel', 'unrelated', 'yes', '"confirm"', 'confirm!', '/new', 'login openai', 'confirm']) {
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
	}, 30000);

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
	}, 30000);

	test('recovered success or claim does not consume a fresh unrelated request', async () => {
		for (const state of ['succeeded', 'claimed']) {
			const f = await fixture();
			try {
				const source = await f.send('Create one fixture issue.');
				if (state === 'succeeded') {
					f.setFailResult(true);
					await expect(f.send('confirm')).rejects.toThrow();
					f.setFailResult(false);
				}
				else {
					const proposal = (await readLinearProposal(source.threadId, sql))!;
					const confirmId = randomUUID();
					await receiveLinearMessage(source.threadId, confirmId, sql);
					expect(await claimLinearCreate(proposal, proposal.session_id, confirmId, true, sql)).toBe(true);
				}
				await f.send('What is on my calendar tomorrow?', randomUUID(), true, '2026-10-01T00:00:01.000Z');
				expect(JSON.stringify(f.prompts)).toContain('What is on my calendar tomorrow?');
				expect(f.posts.join(' ')).toContain(state === 'succeeded' ? 'Created JAM-999' : 'outcome is uncertain');
				expect(f.mutations).toHaveLength(state === 'succeeded' ? 1 : 0);
				expect(await readLinearProposal(source.threadId, sql)).toBeNull();
			}
			finally { await f.close(); }
		}
	}, 15000);

	test('login survives Linear receipt or cancellation failure and later confirm cannot revive the proposal', async () => {
		for (const failure of ['receipt', 'cancellation']) {
			const f = await fixture();
			try {
				const source = await f.send('Create one fixture issue.');
				const intercept = (target: SqlLike): SqlLike => (strings, ...values) => {
					const query = strings.join('');
					if ((failure === 'receipt' && query.includes('INSERT INTO linear_dm_receipts'))
						|| (failure === 'cancellation' && query.includes('SET state = \'canceled\''))) {
						throw new Error('private fixture storage failure');
					}
					return target(strings, ...values);
				};
				const failingSql = intercept(sql);
				failingSql.begin = work => sql.begin(tx => work(intercept(tx)));
				f.setSql(failingSql);
				await f.send('login openai');
				expect(f.posts).toContain(OPENAI_LOGIN_FAILURE);
				f.setSql(sql);
				await f.send('confirm');
				expect(f.mutations).toHaveLength(0);
				expect(await readLinearProposal(source.threadId, sql)).toBeNull();
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
