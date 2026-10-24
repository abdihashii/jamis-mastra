import type { GatewayLanguageModel } from '@mastra/core/llm';
import type { ToolExecutionContext } from '@mastra/core/tools';

import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { MastraModelGateway } from '@mastra/core/llm';
import { RequestContext } from '@mastra/core/request-context';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { noopObserve } from '@mastra/core/tools';
import { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { Groups } from 'sendblue/resources/groups';
import { Messages } from 'sendblue/resources/messages';

import type { SendOutcome } from './deliver';
import type { SqlLike } from './recaps';
import type { SavedReportReference } from './runs';
import type { SavedReport } from './saved-report';

import { createSpecialistContext, requireBroadcasterDeliveryAuthority } from '../../mastra/tools/invoke-specialist';
import { createFantasyPublicationProcedure } from '../../mastra/workflows/publish-fantasy-recap';
import { buildEditorialCandidate } from './editorial';
import { editorialFixtureQuote, frozenEditorialFixture, validEditorialDraft } from './editorial.fixture';
import { ensureFantasyRecapsTable, recordApprovedReport } from './recaps';
import { claimRun, claimSavedReportRetry, confirmSavedReportPart, ensureFantasyRunsTable, getSavedReportState, savedPartStatus } from './runs';
import { buildSavedReport } from './saved-report';

type Action
	= | { tools: Array<Record<string, unknown> | string>; streaming?: boolean }
		| { handback: unknown }
		| { text: string }
		| { error: string };
interface DeliveryTool { execute: (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown> }
const toolCall = (): Action => ({ tools: [{}] });
const completed = (report: SavedReport, status = 'sent'): Action => ({ handback: { case: 'completed', result: { reportId: report.id, status } } });
const refused: Action = { handback: { case: 'blocked', reason: 'Cannot perform this task.', progress: null } };
const malformed: Action = { handback: { case: 'completed', result: { status: 'sent' } } };
const privateError = 'PRIVATE_SOURCE_ERROR: secret SQL, provider and channel details';
const accepted = (handle = 'fixture-handle'): SendOutcome => ({ kind: 'sent', handle });
const reference = (report: SavedReport): SavedReportReference => ({ ...report.scope, reportId: report.id });
const expires = () => new Date(Date.now() + 60_000);

function fixtureRuntime(respond: (options: any, index: number) => Action | Promise<Action>) {
	const calls: any[] = [];
	const resolved: string[] = [];
	async function reply(options: any) {
		const index = calls.length;
		calls.push(options);
		const action = await respond(options, index);
		if ('error' in action)
			throw new Error(action.error);
		return action;
	}
	const model = new MastraLanguageModelV2Mock({
		doGenerate: async (options) => {
			const action = await reply(options);
			return {
				content: 'tools' in action
					? action.tools.map((input, index) => ({ type: 'tool-call' as const, toolCallId: `call-${calls.length}-${index}`, toolName: 'deliver_saved_report', input: typeof input === 'string' ? input : JSON.stringify(input) }))
					: [{ type: 'text' as const, text: 'handback' in action ? JSON.stringify({ handback: action.handback }) : action.text }],
				finishReason: 'tools' in action ? 'tool-calls' : 'stop',
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				warnings: [],
			};
		},
		doStream: async (options) => {
			const action = await reply(options);
			return { stream: new ReadableStream({ start(controller) {
				controller.enqueue({ type: 'stream-start', warnings: [] });
				if ('tools' in action) {
					for (const [index, input] of action.tools.entries()) {
						const id = `call-${calls.length}-${index}`;
						const text = typeof input === 'string' ? input : JSON.stringify(input);
						if (action.streaming) {
							controller.enqueue({ type: 'tool-input-start', id, toolName: 'deliver_saved_report' });
							controller.enqueue({ type: 'tool-input-delta', id, delta: text });
							controller.enqueue({ type: 'tool-input-end', id });
						}
						controller.enqueue({ type: 'tool-call', toolCallId: id, toolName: 'deliver_saved_report', input: text });
					}
				} else {
					controller.enqueue({ type: 'text-start', id: 'reply' });
					controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'handback' in action ? JSON.stringify({ handback: action.handback }) : action.text });
					controller.enqueue({ type: 'text-end', id: 'reply' });
				}
				controller.enqueue({ type: 'finish', finishReason: 'tools' in action ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
				controller.close();
			} }) };
		},
	});
	class FixtureGateway extends MastraModelGateway {
		readonly id = 'openai-codex';
		readonly name = 'Broadcaster fixture';
		fetchProviders() {
			return Promise.resolve({ 'openai-codex': { name: this.name, gateway: this.id, apiKeyEnvVar: '', models: ['gpt-6-luna'], npm: '@ai-sdk/openai' } });
		}

		buildUrl() { return undefined; }
		getApiKey() { return Promise.resolve('fixture'); }
		resolveLanguageModel({ modelId }: { modelId: string }): Promise<GatewayLanguageModel> {
			resolved.push(modelId);
			expect(modelId).toBe('gpt-6-luna');
			return Promise.resolve(model);
		}
	}
	return { runtime: new Mastra({ logger: false, gateways: { fixture: new FixtureGateway() } }), calls, resolved };
}

async function reportFixture(multipart: boolean) {
	const packet = await frozenEditorialFixture();
	const draft = validEditorialDraft(packet);
	if (multipart) {
		draft.stories = ['First', 'Second', 'Third'].map(angle => ({
			headline: `${angle} perspective`,
			body: `${angle} story. `.repeat(900),
			supportIds: ['score:1:1'],
		}));
	}
	const built = buildEditorialCandidate(packet, draft);
	if (built.status !== 'candidate')
		throw new Error('Synthetic editorial candidate was rejected');
	const report = buildSavedReport(packet, {
		status: 'approved',
		evidenceId: packet.id,
		candidate: built.candidate,
		counts: { drafts: 1, reviews: 1 },
		review: { evidenceId: packet.id, candidateId: built.candidate.id, verdict: 'pass', issues: [] },
	});
	expect(report.parts).toHaveLength(multipart ? 3 : 1);
	return report;
}

type TransactionalSql = SqlLike & { begin: <T>(action: (sql: SqlLike) => Promise<T>) => Promise<T> };
function observeSql(base: SqlLike, before: (query: string) => void): SqlLike {
	const wrap = (client: SqlLike): SqlLike => {
		const tagged: SqlLike = async (strings, ...values) => {
			before(strings.join(' ').replace(/\s+/g, ' '));
			return client(strings, ...values);
		};
		if ('begin' in client && typeof client.begin === 'function') {
			Object.assign(tagged, {
				begin: <T>(action: (sql: SqlLike) => Promise<T>) =>
					(client as TransactionalSql).begin(tx => action(wrap(tx))),
			});
		}
		return tagged;
	};
	return wrap(base);
}

// Never fall back to application storage. An explicitly configured disposable fixture must be reachable.
const databaseUrl = process.env.JAMIS_TEST_DATABASE_URL;
if (databaseUrl) {
	const url = new URL(databaseUrl);
	if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)
		|| url.pathname !== '/jamis_sessions_test' || url.search) {
		throw new Error('Disposable loopback jamis_sessions_test URL required');
	}
	const probe = new SQL(databaseUrl, { connectionTimeout: 1 });
	try {
		await probe`SELECT 1`;
	} finally {
		await probe.close();
	}
}

describe.skipIf(!databaseUrl)('private Broadcaster native model and PG publication (mock transport)', () => {
	const schema = `broadcaster_${randomUUID().replaceAll('-', '')}`;
	const token = 'PRIVATE_BOUND_CLAIM';
	let root: SQL;
	let sql: SQL;
	let one: SavedReport;
	let three: SavedReport;
	let guards: Array<ReturnType<typeof spyOn>>;
	let errors: ReturnType<typeof spyOn>;

	beforeAll(async () => {
		root = new SQL(databaseUrl!);
		await root.unsafe(`CREATE SCHEMA "${schema}"`);
		sql = new SQL(databaseUrl!, { connection: { search_path: schema } });
		await ensureFantasyRunsTable(sql);
		await ensureFantasyRecapsTable(sql);
		[one, three] = await Promise.all([reportFixture(false), reportFixture(true)]);
	}, 30_000);
	beforeEach(async () => {
		errors = spyOn(console, 'error').mockImplementation(() => {});
		guards = [
			spyOn(Groups.prototype, 'sendMessage').mockImplementation(() => { throw new Error('Real group SDK forbidden'); }),
			spyOn(Messages.prototype, 'send').mockImplementation(() => { throw new Error('Real DM SDK forbidden'); }),
			spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => {
				throw new Error('HTTP forbidden');
			}, { preconnect() { throw new Error('HTTP preconnect forbidden'); } })),
		];
		await sql`TRUNCATE fantasy_recap_runs, fantasy_recap_generations`;
	});
	afterEach(() => {
		try {
			for (const guard of guards) expect(guard).not.toHaveBeenCalled();
			const logged = errors.mock.calls.flat().map((value: unknown) => value instanceof Error ? value.message : String(value)).join(' ');
			expect(logged).not.toContain(privateError);
		} finally {
			for (const guard of guards) guard.mockRestore();
			errors.mockRestore();
		}
	});
	afterAll(async () => {
		await sql?.close();
		if (root) {
			try {
				await root.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
			} finally {
				await root.close();
			}
		}
	});

	async function save(report = one) {
		const claim = await claimRun(report.scope.leagueId, report.scope.week, token, expires(), null, sql);
		expect(claim.claimed).toBe(true);
		expect(await recordApprovedReport(report, token, sql)).toBe(true);
		return reference(report);
	}
	async function state(report = one) {
		const saved = await getSavedReportState(reference(report), sql);
		expect(saved).not.toBeNull();
		return saved!;
	}
	function sender(report = one, outcomes: SendOutcome[] = []) {
		const calls: Array<{ groupId: string; text: string }> = [];
		return { calls, send: async (groupId: string, text: string): Promise<SendOutcome> => {
			const saved = await state(report);
			const index = saved.progress.parts.findIndex(attempts => savedPartStatus(attempts) === 'sending');
			expect(index).toBeGreaterThanOrEqual(0);
			expect(saved.report).toEqual(report);
			expect(groupId).toBe(report.scope.groupId);
			expect(Buffer.from(text)).toEqual(Buffer.from(report.parts[index]!));
			expect(saved.progress.parts[index]!.at(-1)).toMatchObject({ state: 'sending', claimToken: saved.claimToken, operationId: saved.progress.operationId });
			expect(saved.sendAttemptAt).not.toBeNull();
			const history = await sql`SELECT generator_version, facts FROM fantasy_recap_generations`;
			expect([...history]).toEqual([{
				generator_version: report.version,
				facts: { version: report.version, report },
			}]);
			calls.push({ groupId, text });
			return outcomes[calls.length - 1] ?? accepted(`fixture-${calls.length}`);
		} };
	}
	function publication(
		fixture: ReturnType<typeof fixtureRuntime>,
		sendExact: (groupId: string, text: string) => Promise<SendOutcome>,
		database: SqlLike = sql,
	) {
		return createFantasyPublicationProcedure(fixture.runtime, {
			leagueId: one.scope.leagueId,
			groupId: one.scope.groupId,
			sql: database,
			sendExact,
		});
	}
	async function expectHeld(report = one) {
		const { status, progress: { recoveryRequired } } = await state(report);
		expect({ status, recoveryRequired }).toEqual({ status: 'failed', recoveryRequired: true });
		expect(await claimSavedReportRetry(reference(report), 'automatic', expires(), { source: 'automatic' }, sql)).toBe(false);
	}

	test.each([false, true])('native dispatch and typed handback preserve exact bytes and durable evidence (multipart=%s)', async (multipart) => {
		const report = multipart ? three : one;
		const ref = await save(report);
		const transport = sender(report);
		const fixture = fixtureRuntime((_, index) => index === 0 ? toolCall() : completed(report));
		const result = await publication(fixture, transport.send)(ref, token);
		expect(result.contribution).toEqual({ case: 'completed', result: { reportId: report.id, status: 'sent' } });
		expect(result.receipt).toEqual({ status: 'sent', reportId: report.id, acceptedParts: report.parts.length, totalParts: report.parts.length });
		expect(transport.calls.map(call => call.text)).toEqual(report.parts);
		expect(report.parts.join('')).toContain(editorialFixtureQuote);
		expect(report.parts.join('')).not.toBe(report.parts.join('').normalize('NFC'));
		expect((await state(report)).progress.parts.map(savedPartStatus)).toEqual(report.parts.map(() => 'accepted'));
		expect(fixture.calls).toHaveLength(2);
		expect(fixture.resolved.length).toBeGreaterThan(0);
		expect(fixture.resolved.every(id => id === 'gpt-6-luna')).toBe(true);
		for (const options of fixture.calls) {
			expect(options.providerOptions.openai).toMatchObject({ reasoningEffort: 'max', parallelToolCalls: false });
			const visible = JSON.stringify(options);
			for (const hidden of [
				report.scope.groupId,
				report.scope.leagueId,
				token,
				'PRIVATE_FOOTBALL_CHAT',
				report.evidenceId,
				report.candidateId,
			]) expect(visible).not.toContain(hidden);
		}
		expect(JSON.stringify(fixture.calls[0].prompt)).not.toContain(report.id);
		expect(fixture.calls[0].tools).toHaveLength(1);
		expect(fixture.calls[0].tools[0]).toMatchObject({ name: 'deliver_saved_report', inputSchema: { type: 'object', properties: {}, additionalProperties: false } });
		expect(fixture.calls[0].toolChoice).toEqual({ type: 'required' });
		expect(fixture.calls[1].tools ?? []).toEqual([]);
		expect(fixture.calls[1].toolChoice).toEqual({ type: 'none' });
		expect(JSON.stringify(fixture.calls[1].prompt)).toContain(report.id);
		expect(Object.keys(fixture.runtime.listAgents())).toEqual([]);
		expect(Object.keys(fixture.runtime.listWorkflows())).toEqual([]);
		expect(() => fixture.runtime.getAgent('broadcaster')).toThrow();
		expect(() => fixture.runtime.getWorkflow('publish_fantasy_recap')).toThrow();
		await publication(fixture, transport.send)(ref, token);
		expect(fixture.calls).toHaveLength(2);
		expect(transport.calls).toHaveLength(report.parts.length);
	});

	test('native child has bounded options, empty context, hidden storage and a non-reusable delivery grant', async () => {
		const ref = await save();
		const transport = sender();
		const fixture = fixtureRuntime((_, index) => index === 0 ? toolCall() : completed(one));
		const storage = spyOn(fixture.runtime, 'getStorage').mockImplementation(() => {
			throw new Error('Parent checkpoint/storage access forbidden');
		});
		const originalGenerate = Agent.prototype.generate;
		const observations: Array<{ agent: Agent; options: any; entries: unknown[]; tool: DeliveryTool }> = [];
		let nativeContext: ToolExecutionContext | undefined;
		let executeSpy: ReturnType<typeof spyOn> | undefined;
		const generate = spyOn(Agent.prototype, 'generate').mockImplementation(async function (this: Agent, messages: any, options: any) {
			const tools = await this.listTools();
			const tool = tools.deliver_saved_report as DeliveryTool;
			observations.push({ agent: this, options, entries: [...options.requestContext.entries()], tool });
			const execute = tool.execute!;
			executeSpy = spyOn(tool, 'execute').mockImplementation(async (input: any, context: ToolExecutionContext) => {
				nativeContext = context;
				expect(() => requireBroadcasterDeliveryAuthority(context)).not.toThrow();
				expect(context.agent?.agentId).toBe('broadcaster');
				expect(() => requireBroadcasterDeliveryAuthority({ ...context, agent: { ...context.agent!, agentId: 'jamis' } })).toThrow('not authorized');
				const copied = new RequestContext<unknown>([...context.requestContext!.entries()]);
				expect(() => requireBroadcasterDeliveryAuthority({ ...context, requestContext: copied })).toThrow('not authorized');
				return execute(input, context);
			});
			return Reflect.apply(originalGenerate, this, [messages, options]);
		} as typeof Agent.prototype.generate);
		try {
			expect((await publication(fixture, transport.send)(ref, token)).receipt.status).toBe('sent');
			expect(observations).toHaveLength(1);
			const observed = observations[0]!;
			expect(observed.agent.id).toBe('broadcaster');
			expect(observed.entries).toEqual([]);
			expect(observed.options).toMatchObject({
				maxSteps: 2,
				toolCallConcurrency: 1,
				modelSettings: { maxRetries: 0, timeout: { totalMs: 120_000, stepMs: 120_000 } },
				providerOptions: { openai: { reasoningEffort: 'max', parallelToolCalls: false } },
				tracingOptions: { hideInput: true, hideOutput: true },
				structuredOutput: { errorStrategy: 'strict' },
			});
			for (const field of ['context', 'memory', 'threadId', 'resourceId']) expect(observed.options).not.toHaveProperty(field);
			expect(observed.agent.getMastraInstance()?.getStorage()).toBeUndefined();
			expect(await observed.agent.listAgents()).toEqual({});
			expect(await observed.agent.listWorkflows()).toEqual({});
			expect(storage).not.toHaveBeenCalled();
			expect(nativeContext).toBeDefined();
			expect(() => requireBroadcasterDeliveryAuthority(nativeContext)).toThrow('not authorized');
			executeSpy!.mockRestore();
			for (const context of [
				nativeContext!,
				{ observe: noopObserve, requestContext: new RequestContext(), agent: nativeContext!.agent },
				{ ...nativeContext!, requestContext: createSpecialistContext({ kind: 'workflow', id: 'publish_fantasy_recap' }) },
			]) await expect(observed.tool.execute({}, context)).rejects.toThrow('not authorized');
			expect(transport.calls).toHaveLength(1);
		} finally {
			executeSpy?.mockRestore();
			generate.mockRestore();
			storage.mockRestore();
		}
	});

	test('duplicate native delivery calls reuse one operation without extra SQL or SDK work', async () => {
		const ref = await save(three);
		const transport = sender(three);
		const fixture = fixtureRuntime((_, index) => index === 0 ? { tools: [{}, {}, {}] } : completed(three));
		let queries = 0;
		const database = observeSql(sql, () => {
			queries++;
		});
		const original = Agent.prototype.generate;
		const queryDeltas: number[] = [];
		let toolSpy: ReturnType<typeof spyOn> | undefined;
		const generate = spyOn(Agent.prototype, 'generate').mockImplementation(async function (this: Agent, messages: any, options: any) {
			const tool = (await this.listTools()).deliver_saved_report as DeliveryTool;
			const execute = tool.execute!;
			toolSpy = spyOn(tool, 'execute').mockImplementation(async (input: any, context: ToolExecutionContext) => {
				const before = queries;
				const receipt = await execute(input, context);
				queryDeltas.push(queries - before);
				return receipt;
			});
			return Reflect.apply(original, this, [messages, options]);
		} as typeof Agent.prototype.generate);
		try {
			expect((await publication(fixture, transport.send, database)(ref, token)).receipt.status).toBe('sent');
			expect(queryDeltas).toHaveLength(3);
			expect(queryDeltas[0]).toBeGreaterThan(0);
			expect(queryDeltas.slice(1)).toEqual([0, 0]);
			expect(transport.calls.map(call => call.text)).toEqual(three.parts);
			expect((await state(three)).progress.parts.map(attempts => attempts.length)).toEqual([1, 1, 1]);
			expect(fixture.calls).toHaveLength(2);
		} finally {
			toolSpy?.mockRestore();
			generate.mockRestore();
		}
	});

	test.each([false, true])('same-claim parallel publication sends once (separate factories=%s)', async (separateFactories) => {
		const ref = await save(three);
		const transport = sender(three);
		let entered = 0;
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fixture = fixtureRuntime(async (options) => {
			if (options.prompt.some((row: any) => row.role === 'tool'))
				return completed(three);
			if (++entered === 2)
				release();
			await barrier;
			return toolCall();
		});
		const first = publication(fixture, transport.send);
		const second = separateFactories ? publication(fixture, transport.send) : first;
		const results = await Promise.all([first(ref, token), second(ref, token)]);
		expect(results.some(result => result.receipt.status === 'sent')).toBe(true);
		expect(transport.calls.map(call => call.text)).toEqual(three.parts);
		const current = await state(three);
		expect(current.progress.parts.map(attempts => attempts.length)).toEqual([1, 1, 1]);
		expect(new Set(current.progress.parts.flat().map(attempt => attempt.operationId)).size).toBe(1);
		expect(fixture.calls).toHaveLength(4);
	});

	test.each(['refusal', 'no-tool', 'malformed', 'throw', 'malformed-tool', 'malformed-streamed-tool', 'extra-tool-arguments'])('%s before delivery sends nothing and holds the owned claim for Operator', async (fault) => {
		const ref = await save();
		const transport = sender();
		const fixture = fixtureRuntime((_, index) => {
			if (index > 0)
				return completed(one);
			if (fault === 'refusal')
				return refused;
			if (fault === 'no-tool')
				return { text: 'No delivery performed.' };
			if (fault === 'malformed')
				return malformed;
			if (fault === 'throw')
				return { error: privateError };
			return { tools: [fault.startsWith('malformed-') ? '{bad json' : { groupId: 'attacker-group', text: 'replacement' }], streaming: fault === 'malformed-streamed-tool' };
		});
		const result = await publication(fixture, transport.send)(ref, token);
		expect(result.receipt).toMatchObject({ status: 'failed', acceptedParts: 0, totalParts: 1 });
		expect(result.contribution.case).toBe(fault === 'refusal' ? 'blocked' : 'failed');
		expect(transport.calls).toEqual([]);
		expect((await state()).progress.parts.flat()).toEqual([]);
		await expectHeld();
		expect(fixture.calls).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain(privateError);
	});

	test('spoofed completion without a delivery receipt cannot mark SQL sent or authorize a fresh run', async () => {
		const ref = await save();
		const transport = sender();
		const fixture = fixtureRuntime(() => completed(one));
		const publish = publication(fixture, transport.send);
		const result = await publish(ref, token);
		expect(result.contribution.case).toBe('failed');
		expect(result.receipt).toMatchObject({ status: 'failed', acceptedParts: 0 });
		await expectHeld();
		await publish(ref, token);
		expect(fixture.calls).toHaveLength(1);
		expect(transport.calls).toEqual([]);
	});

	test.each(['refusal', 'malformed', 'throw', 'wrong-report', 'wrong-status', 'caller-abort'])('%s after native delivery cannot erase the authoritative receipt or replay accepted bytes', async (fault) => {
		const ref = await save();
		const controller = new AbortController();
		const transport = sender();
		const fixture = fixtureRuntime(async (_, index) => {
			if (index === 0)
				return toolCall();
			expect((await state()).status).toBe('sent');
			if (fault === 'refusal')
				return refused;
			if (fault === 'malformed')
				return malformed;
			if (fault === 'throw')
				return { error: privateError };
			if (fault === 'wrong-report')
				return completed(three);
			if (fault === 'wrong-status')
				return completed(one, 'delivery_unknown');
			controller.abort(new Error(privateError));
			return completed(one);
		});
		const publish = publication(fixture, transport.send);
		const result = await publish(ref, token, controller.signal);
		expect(result.receipt).toMatchObject({ status: 'sent', reportId: one.id, acceptedParts: 1, totalParts: 1 });
		expect(result.contribution.case).toBe(fault === 'refusal' ? 'blocked' : 'failed');
		expect(JSON.stringify(result)).not.toContain(privateError);
		expect((await state()).status).toBe('sent');
		await publish(ref, token);
		expect(transport.calls.map(call => call.text)).toEqual(one.parts);
		expect(fixture.calls).toHaveLength(2);
	});

	test('native invocation construction failure stops the owned claim without escaping private errors', async () => {
		const ref = await save();
		const transport = sender();
		const fixture = fixtureRuntime(() => {
			throw new Error('Construction failed before a model could start');
		});
		const publish = publication(fixture, transport.send);
		const construction = spyOn(Agent.prototype, 'getDescription').mockImplementation(() => {
			throw new Error(privateError);
		});
		let escaped: unknown;
		let result: Awaited<ReturnType<typeof publish>> | undefined;
		try {
			result = await publish(ref, token);
		} catch (error) {
			escaped = error;
		} finally {
			construction.mockRestore();
		}
		expect(fixture.calls).toEqual([]);
		expect(transport.calls).toEqual([]);
		await expectHeld();
		expect(escaped).toBeUndefined();
		expect(result).toMatchObject({ contribution: { case: 'failed' }, receipt: { status: 'failed', acceptedParts: 0 } });
		expect(JSON.stringify(result)).not.toContain(privateError);
	});

	test('already-aborted caller stops the owned live claim with an Operator-only recovery hold', async () => {
		const ref = await save();
		const controller = new AbortController();
		controller.abort();
		const transport = sender();
		const fixture = fixtureRuntime(() => {
			throw new Error('Canceled publication must not start a model');
		});
		const result = await publication(fixture, transport.send)(ref, token, controller.signal);
		expect(fixture.calls).toEqual([]);
		expect(transport.calls).toEqual([]);
		expect((await state()).progress.parts.flat()).toEqual([]);
		await expectHeld();
		expect(result.receipt).toMatchObject({ status: 'failed', acceptedParts: 0, totalParts: 1 });
		expect(await claimSavedReportRetry(ref, 'operator-after-cancel', expires(), { source: 'operator' }, sql)).toBe(true);
		expect(await state()).toMatchObject({ status: 'started', claimToken: 'operator-after-cancel', progress: { recoveryRequired: false } });
	});

	test('cancellation during the initial delivery read atomically holds a still-unreserved claim', async () => {
		const ref = await save();
		const controller = new AbortController();
		const transport = sender();
		const fixture = fixtureRuntime((_, index) => index === 0 ? toolCall() : completed(one));
		let reads = 0;
		const database = observeSql(sql, (query) => {
			if (query.includes('lease_current') && ++reads === 2)
				controller.abort();
		});
		await publication(fixture, transport.send, database)(ref, token, controller.signal);
		expect(reads).toBeGreaterThanOrEqual(2);
		expect(transport.calls).toEqual([]);
		expect((await state()).progress.operationId).toBeNull();
		await expectHeld();
	});

	test('caller cancellation during acceptance preserves that prefix and holds the unsent tail', async () => {
		const ref = await save(three);
		const controller = new AbortController();
		const transport = sender(three);
		const fixture = fixtureRuntime((_, index) => index === 0 ? toolCall() : completed(three));
		const publish = publication(fixture, async (group, text) => {
			const result = await transport.send(group, text);
			controller.abort();
			return result;
		});
		const result = await publish(ref, token, controller.signal);
		expect(result.receipt).toMatchObject({ status: 'failed', acceptedParts: 1, totalParts: 3 });
		expect((await state(three)).progress.parts.map(savedPartStatus)).toEqual(['accepted', 'pending', 'pending']);
		await expectHeld(three);
		await publish(ref, token);
		expect(transport.calls.map(call => call.text)).toEqual(three.parts.slice(0, 1));
	});

	test('unknown part two stops three; record-only confirmation and explicit retry preserve exact tail bytes', async () => {
		const ref = await save(three);
		const first = sender(three, [accepted('first'), { kind: 'unknown', error: privateError }]);
		const fixture = fixtureRuntime((_, index) => index === 0 ? toolCall() : completed(three, 'delivery_unknown'));
		const result = await publication(fixture, first.send)(ref, token);
		expect(result.receipt).toMatchObject({ status: 'delivery_unknown', acceptedParts: 1, totalParts: 3 });
		expect(JSON.stringify([result, fixture.calls])).not.toContain(privateError);
		expect(first.calls.map(call => call.text)).toEqual(three.parts.slice(0, 2));
		const unknown = await state(three);
		expect(unknown.progress.parts.map(savedPartStatus)).toEqual(['accepted', 'unknown', 'pending']);
		const attempt = unknown.progress.parts[1]!.at(-1)!;
		expect(await confirmSavedReportPart(ref, 2, attempt.id, sql)).toBe(true);
		expect(first.calls).toHaveLength(2);
		expect(await claimSavedReportRetry(ref, 'auto', expires(), { source: 'automatic' }, sql)).toBe(false);
		await publication(fixture, first.send)(ref, token);
		expect(fixture.calls).toHaveLength(2);
		expect(await claimSavedReportRetry(ref, 'manual', expires(), { source: 'operator' }, sql)).toBe(true);
		const tail = sender(three);
		const retry = fixtureRuntime((_, index) => index === 0 ? toolCall() : completed(three));
		expect((await publication(retry, tail.send)(ref, 'manual')).receipt).toMatchObject({ status: 'sent', acceptedParts: 3 });
		expect(tail.calls.map(call => call.text)).toEqual([three.parts[2]!]);
		expect((await state(three)).report).toEqual(three);
		expect(retry.calls).toHaveLength(2);
	});

	test.each(['scope', 'digest', 'claim', 'stale-week', 'expired'])('%s mismatch cannot reach the SDK or invoke fresh editorial models', async (fault) => {
		let ref = await save();
		if (fault === 'scope')
			ref = { ...ref, groupId: 'wrong-group' };
		if (fault === 'digest')
			await sql`UPDATE fantasy_recap_runs SET saved_report = ${{ ...one, id: `report-${'0'.repeat(64)}` }}`;
		if (fault === 'expired')
			await sql`UPDATE fantasy_recap_runs SET lease_expires_at = ${new Date(Date.now() - 1_000).toISOString()}`;
		if (fault === 'stale-week')
			expect((await claimRun(ref.leagueId, ref.week + 1, 'newer', expires(), null, sql)).claimed).toBe(true);
		const transport = sender();
		const fixture = fixtureRuntime((_, index) => index === 0 ? toolCall() : completed(one, 'blocked'));
		const result = await publication(fixture, transport.send)(ref, fault === 'claim' ? 'wrong-claim' : token);
		expect(result.receipt.status).not.toBe('sent');
		expect(transport.calls).toEqual([]);
		expect(fixture.calls).toHaveLength(fault === 'stale-week' ? 2 : 0);
	});

	test('later SQL unavailability cannot retract an already verified sent receipt', async () => {
		const ref = await save();
		const transport = sender();
		let unavailable = false;
		let failures = 0;
		const database = observeSql(sql, () => {
			if (unavailable) {
				failures++;
				throw new Error(privateError);
			}
		});
		const fixture = fixtureRuntime((_, index) => {
			if (index === 0)
				return toolCall();
			unavailable = true;
			return completed(one);
		});
		const result = await publication(fixture, transport.send, database)(ref, token);
		expect(failures).toBeGreaterThan(0);
		expect(result.receipt).toEqual({ status: 'sent', reportId: one.id, acceptedParts: 1, totalParts: 1 });
		expect(result.contribution.case).toBe('completed');
		expect(JSON.stringify(result)).not.toContain(privateError);
		expect(transport.calls).toHaveLength(1);
		expect((await state()).status).toBe('sent');
	});

	test('initial SQL failure is bounded and private with zero native model or transport calls', async () => {
		const ref = await save();
		const transport = sender();
		const fixture = fixtureRuntime(() => {
			throw new Error('Model must not start');
		});
		const database = observeSql(sql, () => {
			throw new Error(privateError);
		});
		const result = await publication(fixture, transport.send, database)(ref, token);
		expect(result.receipt).toMatchObject({ status: 'blocked', reason: 'saved_report_unavailable' });
		expect(JSON.stringify(result)).not.toContain(privateError);
		expect(fixture.calls).toEqual([]);
		expect(transport.calls).toEqual([]);
	});
});
