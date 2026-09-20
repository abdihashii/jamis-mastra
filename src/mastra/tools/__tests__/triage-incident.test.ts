import type { ChannelHandlerContext } from '@mastra/core/channels';
import type { Message, Thread } from 'chat';
import type { RecapRun } from '../../../fantasy/runs';
import type { SqlLike } from '../../../lib/operator-time-zone';

import { describe, expect, test } from 'bun:test';
import { SpanType } from '@mastra/core/observability';
import { RequestContext as MastraRequestContext } from '@mastra/core/request-context';
import { TraceStatus } from '@mastra/core/storage';
import { z } from 'zod';

process.env.JAMIS_ALLOWED_NUMBER = '+15555550101';
process.env.SENDBLUE_API_KEY = 'test-api-key';
process.env.SENDBLUE_API_SECRET = 'test-api-secret';
process.env.SENDBLUE_FROM_NUMBER = '+15555550100';
process.env.SENDBLUE_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.OPERATOR_TIMEZONE = 'UTC';
process.env.FANTASY_SENDBLUE_GROUP_ID = 'fantasy-group';
process.env.FANTASY_SLEEPER_LEAGUE_ID = '111';
process.env.FANTASY_MANAGER_MAP = '{}';
process.env.FANTASY_RECAP_TIMEZONE = 'America/Chicago';

const {
	handleSendblueDirectMessage,
	hashSendblueMessageHandle,
	SENDBLUE_CHANNEL_SPAN_NAME,
	SENDBLUE_CORRELATION_KEY,
} = await import('../../channels/sendblue.js');
const { readIncident, triageIncidentTool } = await import('../triage-incident.js');

type IncidentStore = import('../triage-incident.js').IncidentStore;
type IncidentResult = import('../triage-incident.js').IncidentResult;

const operatorNumber = process.env.JAMIS_ALLOWED_NUMBER!;
const threadId = 'sendblue:test-line:test-operator';
const rawDiagnostic = 'private prompt phone:+15555550101 secret-token raw-error-body';
const start = new Date('2030-01-01T00:00:00.000Z');
const end = new Date('2030-01-02T00:00:00.000Z');

function traceRow(overrides: Record<string, unknown> = {}) {
	return {
		createdAt: start,
		updatedAt: null,
		name: 'run',
		spanType: SpanType.AGENT_RUN,
		isEvent: false,
		startedAt: start,
		endedAt: end,
		parentSpanId: null,
		status: TraceStatus.ERROR,
		entityId: 'jamis',
		entityName: rawDiagnostic,
		metadata: { planted: rawDiagnostic },
		inputPreview: rawDiagnostic,
		input: rawDiagnostic,
		output: rawDiagnostic,
		error: rawDiagnostic,
		traceId: 'trace-1',
		spanId: 'span-1',
		...overrides,
	};
}

function structure(...spans: ReturnType<typeof traceRow>[]) {
	return { traceId: spans[0]?.traceId ?? 'trace-1', spans };
}

function fantasyRun(overrides: Partial<RecapRun> = {}): RecapRun {
	return {
		leagueId: '111',
		fantasyWeek: 1,
		status: 'failed',
		latestAttemptTraceId: 'trace-fantasy',
		failureStage: 'scheduled_job',
		failureClassification: 'execution_failed',
		finalText: null,
		claimToken: null,
		leaseExpiresAt: null,
		sendAttemptAt: null,
		messageHandle: null,
		deliverySource: null,
		sentAt: null,
		lastError: rawDiagnostic,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:01:00.000Z'),
		...overrides,
	};
}

function storeFixture(options: {
	branches?: ReturnType<typeof traceRow>[];
	rootTotal?: number;
	roots?: ReturnType<typeof traceRow>[];
	structures?: Map<string, ReturnType<typeof structure> | null>;
	onBranches?: (args: unknown) => void;
	onRoots?: (args: unknown) => void;
} = {}): IncidentStore {
	const roots = options.roots ?? [];
	const branches = options.branches ?? [];
	return {
		listTracesLight: async (args) => {
			options.onRoots?.(args);
			return {
				spans: roots,
				pagination: {
					total: options.rootTotal ?? roots.length,
					page: 0,
					perPage: 6,
					hasMore: (options.rootTotal ?? roots.length) > roots.length,
				},
			} as never;
		},
		listBranches: async (args) => {
			options.onBranches?.(args);
			return {
				branches,
				pagination: { total: branches.length, page: 0, perPage: 6, hasMore: false },
			} as never;
		},
		getStructure: async ({ traceId }) => options.structures?.get(traceId) as never ?? null,
	} as IncidentStore;
}

function message(id: string, at: string): Message {
	return {
		id,
		threadId,
		text: rawDiagnostic,
		author: { userId: operatorNumber },
		metadata: { dateSent: new Date(at) },
	} as Message;
}

const sql = (async (strings: TemplateStringsArray) => strings.join(' ').includes('WITH previous')
	? [{ applied: false, consumed_proposal: false, proposal_time_zone: null }]
	: []) as SqlLike;

async function withLiveCapability<T>(
	run: (requestContext: MastraRequestContext) => Promise<T>,
	historyError = false,
): Promise<T> {
	const previous = message('provider-previous', '2030-01-01T00:00:00.000Z');
	const current = message('provider-current', '2030-01-01T00:01:00.000Z');
	const thread = {
		id: threadId,
		isDM: true,
		adapter: {
			name: 'sendblue',
			fetchMessages: async () => {
				if (historyError)
					throw new Error(rawDiagnostic);
				return { messages: [previous, current] };
			},
		},
		post: async () => ({}),
	} as unknown as Thread;
	const requestContext = new MastraRequestContext();
	const context = { requestContext, signalMetadata: {} } as ChannelHandlerContext;
	let result: T | undefined;
	await handleSendblueDirectMessage(thread, current, async () => {
		result = await run(requestContext);
	}, context, sql);
	return result!;
}

async function withPrecedingCapability(
	store: IncidentStore,
	options: { historyError?: boolean; calls?: string[] } = {},
): Promise<IncidentResult> {
	return await withLiveCapability(async requestContext => await readIncident(
		{ kind: 'preceding_request' },
		{
			requestContext,
			flush: async () => { options.calls?.push('flush'); },
			getStore: async () => {
				options.calls?.push('getStore');
				return store;
			},
		},
	), options.historyError);
}

describe('bounded incident reader', () => {
	test('exposes only bounded safe target clues', async () => {
		const schema = triageIncidentTool.inputSchema as z.ZodTypeAny;
		const jsonSchema = z.toJSONSchema(schema);
		expect(jsonSchema.type).toBe('object');
		expect(jsonSchema.properties?.humanDomainReference).toMatchObject({
			type: 'string',
			pattern: '^week\\s+([1-9]|1[0-8])$',
		});
		expect(schema.parse({ kind: 'preceding_request' })).toEqual({ kind: 'preceding_request' });
		expect(schema.parse({ kind: 'application', component: 'fantasy-weekly-recap', humanDomainReference: 'Week 1' })).toEqual({
			kind: 'application',
			component: 'fantasy-weekly-recap',
			humanDomainReference: 'Week 1',
		});
		for (const input of [
			{ kind: 'preceding_request', traceId: 'trace-1' },
			{ kind: 'preceding_request', component: 'jamis' },
			{ kind: 'application', component: 'unknown-component' },
			{ kind: 'application', messageId: 'provider-message' },
			{ kind: 'application', humanDomainReference: 'thread 123' },
			{ kind: 'application', window: { start: 'trace-123Z', end: end.toISOString() } },
		])
			expect(schema.safeParse(input).success).toBe(false);

		let flushed = 0;
		const tooWide = await triageIncidentTool.execute!(
			{
				kind: 'application',
				window: { start: '2030-01-01T00:00:00.000Z', end: '2030-01-09T00:00:00.001Z' },
			},
			{
				mastra: { observability: { flush: async () => { flushed++; } } },
				requestContext: new MastraRequestContext(),
			} as never,
		);
		expect(tooWide).toEqual({
			status: 'unavailable',
			targetKind: 'application',
			evidenceGaps: ['invalid_window'],
		});
		expect(flushed).toBe(0);
	});

	test('wires flushing and storage at the public tool boundary', async () => {
		const calls: string[] = [];
		const root = traceRow({ entityId: 'weather-agent', traceId: 'trace-weather', spanId: 'agent-weather' });
		const result = await triageIncidentTool.execute!(
			{
				kind: 'application',
				component: 'weather-agent',
				window: { start: start.toISOString(), end: end.toISOString() },
			},
			{
				requestContext: new MastraRequestContext(),
				mastra: {
					observability: { flush: async () => { calls.push('flush'); } },
					getStorage: () => ({
						getStore: async () => {
							calls.push('store');
							return storeFixture({
								branches: [root],
								structures: new Map([[root.traceId, structure(root)]]),
							});
						},
					}),
				},
			} as never,
		);
		expect(calls).toEqual(['flush', 'store']);
		expect(result).toMatchObject({
			status: 'found',
			incident: { component: 'weather-agent', stage: 'agent' },
		});
		expect(JSON.stringify(result)).not.toContain(rawDiagnostic);
	});

	test('denies preceding-request capability to Studio and subagent tool calls', async () => {
		let flushed = 0;
		const execute = async (requestContext: MastraRequestContext, agentId?: string) => await triageIncidentTool.execute!(
			{ kind: 'preceding_request' },
			{
				...(agentId ? { agent: { agentId } } : {}),
				requestContext,
				mastra: { observability: { flush: async () => { flushed++; } } },
			} as never,
		);

		const studio = await execute(new MastraRequestContext());
		const subagent = await withLiveCapability(requestContext => execute(requestContext, 'research-agent'));
		for (const result of [studio, subagent]) {
			expect(result).toEqual({
				status: 'unavailable',
				targetKind: 'preceding_request',
				evidenceGaps: ['missing_channel_capability'],
			});
		}
		expect(flushed).toBe(0);
	});

	test('resolves only the preceding authenticated request by exact digest and sanitizes the result', async () => {
		const calls: string[] = [];
		const root = traceRow();
		const model = traceRow({
			name: rawDiagnostic,
			spanType: SpanType.MODEL_INFERENCE,
			parentSpanId: root.spanId,
			status: undefined,
			traceId: root.traceId,
			spanId: 'model-1',
		});
		const store = storeFixture({
			roots: [root],
			structures: new Map([[root.traceId, structure(root, model)]]),
			onRoots: (args) => {
				calls.push('list');
				expect(args).toMatchObject({
					filters: { metadata: { [SENDBLUE_CORRELATION_KEY]: hashSendblueMessageHandle('provider-previous') } },
					pagination: { page: 0, perPage: 6 },
				});
			},
		});

		const result = await withPrecedingCapability(store, { calls });

		expect(calls).toEqual(['flush', 'getStore', 'list']);
		expect(result).toEqual({
			status: 'found',
			targetKind: 'preceding_request',
			incident: {
				component: 'jamis',
				occurrenceTimeUtc: start.toISOString(),
				stage: 'model',
				classification: 'execution_failed',
				scope: 'single_request',
				impact: 'request_failed',
				traceReference: { traceId: root.traceId, spanId: root.spanId },
			},
			evidenceGaps: ['cause_unproven'],
		});
		expect(JSON.stringify(result)).not.toContain(rawDiagnostic);
	});

	test('reports a failed child under a successful request as degraded', async () => {
		const root = traceRow({ status: TraceStatus.SUCCESS, error: undefined });
		const tool = traceRow({
			spanType: SpanType.TOOL_CALL,
			parentSpanId: root.spanId,
			status: undefined,
			traceId: root.traceId,
			spanId: 'tool-1',
		});
		const result = await withPrecedingCapability(storeFixture({
			roots: [root],
			structures: new Map([[root.traceId, structure(root, tool)]]),
		}));

		expect(result.status).toBe('found');
		if (result.status === 'found') {
			expect(result.incident.stage).toBe('tool');
			expect(result.incident.impact).toBe('execution_degraded');
		}
	});

	test('reports a fixed proven cause only for an exact reply-delivery signal', async () => {
		const agent = traceRow({ status: TraceStatus.SUCCESS, error: undefined });
		const channel = traceRow({
			name: SENDBLUE_CHANNEL_SPAN_NAME,
			spanType: SpanType.GENERIC,
			entityId: rawDiagnostic,
			traceId: 'trace-channel',
			spanId: 'span-channel',
			status: TraceStatus.SUCCESS,
			metadata: { stage: 'reply_delivery', classification: 'failed', planted: rawDiagnostic },
		});
		const result = await withPrecedingCapability(storeFixture({
			roots: [agent, channel],
			structures: new Map([[agent.traceId, structure(agent)]]),
		}));

		expect(result.status).toBe('found');
		if (result.status !== 'found')
			throw new Error('Expected a found incident');
		expect(result.incident).toMatchObject({
			component: 'sendblue-channel',
			stage: 'reply_delivery',
			classification: 'delivery_failed',
			impact: 'reply_not_delivered',
			cause: 'reply_delivery_failed',
			traceReference: { traceId: 'trace-channel', spanId: 'span-channel' },
		});
		expect(result.evidenceGaps).toEqual([]);
		expect(JSON.stringify(result)).not.toContain(rawDiagnostic);
	});

	test('fails closed without the trusted capability or message history', async () => {
		let flushed = 0;
		const forged = new MastraRequestContext();
		forged.setRaw(SENDBLUE_CORRELATION_KEY, hashSendblueMessageHandle('forged'));
		const unavailable = await readIncident(
			{ kind: 'preceding_request' },
			{ requestContext: forged, flush: async () => { flushed++; }, getStore: async () => storeFixture() },
		);
		expect(unavailable).toEqual({
			status: 'unavailable',
			targetKind: 'preceding_request',
			evidenceGaps: ['missing_channel_capability'],
		});
		expect(flushed).toBe(0);

		const historyFailure = await withPrecedingCapability(storeFixture(), { historyError: true });
		expect(historyFailure).toEqual({
			status: 'unavailable',
			targetKind: 'preceding_request',
			evidenceGaps: ['message_history_unavailable'],
		});
	});

	test('isolates a named component with a bounded branch query and never promotes time to exact identity', async () => {
		const agent = traceRow({ entityId: 'weather-agent', traceId: 'trace-weather', spanId: 'agent-weather' });
		const tool = traceRow({
			entityId: 'weather-tool',
			spanType: SpanType.TOOL_CALL,
			parentSpanId: agent.spanId,
			status: undefined,
			traceId: agent.traceId,
			spanId: 'tool-weather',
		});
		let branchArgs: unknown;
		const result = await readIncident(
			{ kind: 'application', component: 'weather-agent', window: { start, end } },
			{
				flush: async () => {},
				getStore: async () => storeFixture({
					branches: [agent],
					structures: new Map([[agent.traceId, structure(agent, tool)]]),
					onBranches: args => (branchArgs = args),
				}),
			},
		);

		expect(branchArgs).toMatchObject({
			filters: {
				entityId: 'weather-agent',
				status: TraceStatus.ERROR,
				startedAt: { start, end },
			},
			pagination: { page: 0, perPage: 6 },
		});
		expect(result).toEqual({
			status: 'found',
			targetKind: 'application',
			incident: {
				component: 'weather-agent',
				occurrenceTimeUtc: start.toISOString(),
				stage: 'tool',
				classification: 'execution_failed',
				scope: 'single_execution',
				impact: 'execution_failed',
			},
			evidenceGaps: ['trace_identity_not_exact', 'cause_unproven'],
		});
		expect(JSON.stringify(result)).not.toContain(rawDiagnostic);
	});

	test('resolves an exact configured Fantasy week outside the trace window and validates its stored trace', async () => {
		const workflow = traceRow({
			name: 'fantasy-weekly-recap',
			spanType: SpanType.WORKFLOW_RUN,
			entityId: 'fantasy-weekly-recap',
			traceId: 'trace-fantasy',
			spanId: 'span-fantasy',
		});
		const seen: unknown[] = [];
		const result = await readIncident(
			{
				kind: 'application',
				component: 'fantasy-weekly-recap',
				humanDomainReference: 'week 1',
				window: { start, end },
			},
			{
				fantasyLeagueId: '111',
				flush: async () => { seen.push('flush'); },
				getStore: async () => storeFixture({ structures: new Map([[workflow.traceId, structure(workflow)]]) }),
				readFantasyRun: async (leagueId, week) => {
					seen.push({ leagueId, week });
					return fantasyRun();
				},
			},
		);

		expect(seen).toEqual([{ leagueId: '111', week: 1 }, 'flush']);
		expect(result).toEqual({
			status: 'found',
			targetKind: 'application',
			incident: {
				component: 'fantasy-weekly-recap',
				occurrenceTimeUtc: '2026-01-01T00:01:00.000Z',
				stage: 'scheduled_job',
				humanDomainReference: 'week 1',
				classification: 'execution_failed',
				scope: 'single_execution',
				impact: 'execution_failed',
				traceReference: { traceId: 'trace-fantasy', spanId: 'span-fantasy' },
			},
			evidenceGaps: ['cause_unproven'],
		});
		expect(JSON.stringify(result)).not.toContain(rawDiagnostic);
	});

	test('surfaces the latest actionable Fantasy run with missing or stale trace evidence', async () => {
		const updatedAt = new Date(start.getTime() + 60_000);
		const missing = await readIncident(
			{ kind: 'application', component: 'fantasy-weekly-recap', window: { start, end } },
			{
				fantasyLeagueId: '111',
				flush: async () => {},
				getStore: async () => storeFixture(),
				readFantasyRun: async (_leagueId, week) => {
					expect(week).toBeUndefined();
					return fantasyRun({
						fantasyWeek: 7,
						status: 'delivery_unknown',
						latestAttemptTraceId: null,
						failureStage: 'reply_delivery',
						failureClassification: 'execution_interrupted',
						updatedAt,
					});
				},
			},
		);
		expect(missing).toMatchObject({
			status: 'found',
			incident: {
				humanDomainReference: 'week 7',
				stage: 'reply_delivery',
				classification: 'execution_interrupted',
				impact: 'delivery_unconfirmed',
			},
			evidenceGaps: ['trace_reference_missing', 'cause_unproven'],
		});

		const stale = await readIncident(
			{ kind: 'application', component: 'fantasy-weekly-recap', humanDomainReference: 'week 1', window: { start, end } },
			{
				fantasyLeagueId: '111',
				flush: async () => {},
				getStore: async () => storeFixture({
					structures: new Map([['trace-fantasy', structure(traceRow({ traceId: 'trace-fantasy', entityId: 'jamis' }))]]),
				}),
				readFantasyRun: async () => fantasyRun(),
			},
		);
		expect(stale).toMatchObject({
			status: 'found',
			evidenceGaps: ['trace_reference_stale', 'cause_unproven'],
		});

		const corrupted = await readIncident(
			{ kind: 'application', component: 'fantasy-weekly-recap', humanDomainReference: 'week 1', window: { start, end } },
			{
				fantasyLeagueId: '111',
				flush: async () => {},
				getStore: async () => storeFixture(),
				readFantasyRun: async () => fantasyRun({
					latestAttemptTraceId: null,
					failureStage: rawDiagnostic as never,
					failureClassification: rawDiagnostic as never,
				}),
			},
		);
		expect(corrupted).toMatchObject({
			status: 'found',
			incident: { stage: 'unknown', classification: 'unknown' },
			evidenceGaps: ['failure_stage_unknown', 'trace_reference_missing', 'cause_unproven'],
		});
		expect(JSON.stringify([missing, stale, corrupted])).not.toContain(rawDiagnostic);
	});

	test('includes fixed channel failures in broad bounded history', async () => {
		const channel = traceRow({
			name: SENDBLUE_CHANNEL_SPAN_NAME,
			spanType: SpanType.GENERIC,
			entityId: rawDiagnostic,
			traceId: 'trace-channel-history',
			spanId: 'span-channel-history',
			status: TraceStatus.SUCCESS,
			error: undefined,
			metadata: { stage: 'channel_intake', classification: 'failed', planted: rawDiagnostic },
		});
		const calls: unknown[] = [];
		const base = storeFixture();
		const result = await readIncident(
			{ kind: 'application', window: { start, end } },
			{
				flush: async () => {},
				getStore: async () => ({
					...base,
					listTracesLight: async (args) => {
						calls.push(args);
						const spans = args.filters?.metadata ? [channel] : [];
						return {
							spans,
							pagination: { total: spans.length, page: 0, perPage: 6, hasMore: false },
						} as never;
					},
				}),
			},
		);

		expect(calls).toHaveLength(2);
		expect(calls[1]).toMatchObject({
			filters: { metadata: { classification: 'failed' } },
			pagination: { page: 0, perPage: 6 },
		});
		expect(result).toEqual({
			status: 'found',
			targetKind: 'application',
			incident: {
				component: 'sendblue-channel',
				occurrenceTimeUtc: start.toISOString(),
				stage: 'channel_intake',
				classification: 'intake_failed',
				scope: 'single_execution',
				impact: 'execution_failed',
			},
			evidenceGaps: ['trace_identity_not_exact', 'cause_unproven'],
		});
		expect(JSON.stringify(result)).not.toContain(rawDiagnostic);
	});

	test('returns deterministic zero, one, two, and over-five broad results', async () => {
		for (const [count, status, candidates] of [
			[0, 'not_found', undefined],
			[1, 'found', undefined],
			[2, 'ambiguous', 2],
			[6, 'ambiguous', 5],
		] as const) {
			const roots = Array.from({ length: count }, (_, index) => traceRow({
				traceId: `trace-${index}`,
				spanId: `span-${index}`,
				startedAt: new Date(start.getTime() + index * 1000),
			}));
			const structures = new Map(roots.map(root => [root.traceId, structure(root)]));
			const result = await readIncident(
				{ kind: 'application', window: { start, end } },
				{ flush: async () => {}, getStore: async () => storeFixture({ roots, structures }) },
			);
			expect(result.status).toBe(status);
			if (candidates !== undefined) {
				expect(result.status).toBe('ambiguous');
				if (result.status === 'ambiguous')
					expect(result.candidates).toHaveLength(candidates);
			}
		}
	});

	test('classifies only known failed span types and chooses the deepest failure', async () => {
		for (const [spanType, expected] of [
			[SpanType.AGENT_RUN, 'agent'],
			[SpanType.MODEL_INFERENCE, 'model'],
			[SpanType.TOOL_CALL, 'tool'],
			[SpanType.WORKFLOW_STEP, 'workflow'],
			[SpanType.MEMORY_OPERATION, 'application_storage'],
		] as const) {
			const root = traceRow({ traceId: `trace-${expected}`, spanId: `root-${expected}` });
			const child = traceRow({
				spanType,
				traceId: root.traceId,
				spanId: `child-${expected}`,
				parentSpanId: root.spanId,
				status: undefined,
			});
			const result = await readIncident(
				{ kind: 'application', window: { start, end } },
				{
					flush: async () => {},
					getStore: async () => storeFixture({
						roots: [root],
						structures: new Map([[root.traceId, structure(root, child)]]),
					}),
				},
			);
			expect(result.status).toBe('found');
			if (result.status === 'found')
				expect(result.incident.stage).toBe(expected);
		}
	});

	test('bounds invalid windows and makes flush, storage, and query failures explicit', async () => {
		const target = { kind: 'application', window: { start, end } } as const;
		const invalid = await readIncident(
			{ kind: 'application', window: { start: end, end: start } },
			{ flush: async () => {}, getStore: async () => storeFixture() },
		);
		expect(invalid.evidenceGaps).toEqual(['invalid_window']);

		const flush = await readIncident(target, {
			flush: async () => { throw new Error(rawDiagnostic); },
			getStore: async () => storeFixture(),
		});
		expect(flush.evidenceGaps).toEqual(['observability_flush_failed']);

		const storage = await readIncident(target, { flush: async () => {}, getStore: async () => undefined });
		expect(storage.evidenceGaps).toEqual(['observability_storage_unavailable']);

		const query = await readIncident(target, {
			flush: async () => {},
			getStore: async () => ({
				...storeFixture(),
				listTracesLight: async () => { throw new Error(rawDiagnostic); },
			}),
		});
		expect(query.evidenceGaps).toEqual(['observability_query_failed']);
		for (const result of [invalid, flush, storage, query])
			expect(JSON.stringify(result)).not.toContain(rawDiagnostic);
	});
});
