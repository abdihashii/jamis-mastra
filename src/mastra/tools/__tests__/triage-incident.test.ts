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
const { CODEX_AUTH_FAILURE_EVENT } = await import('../../observability.js');
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

function deploymentEvidenceFixture() {
	const observedAt = '2030-01-01T00:00:00Z';
	return {
		host: { availability: 'available', freshness: 'fresh', observedAt, gaps: ['external_reachability', 'recent_host_events'] as const },
		docker: {
			availability: 'available',
			freshness: 'fresh',
			observedAt,
			gaps: ['service_functionality', 'external_reachability'] as const,
			containers: [
				{ component: 'app', state: 'running' },
				{ component: 'postgres', state: 'running' },
				{ component: 'clickhouse', state: 'running' },
				{ component: 'cloudflared', state: 'running' },
			],
		},
		app: { availability: 'available', freshness: 'fresh', observedAt, gaps: ['external_reachability', 'product_outcomes_unchecked'] as const },
		postgres: { availability: 'available', freshness: 'fresh', observedAt, gaps: ['no_fantasy_runs'] as const },
		clickhouse: { availability: 'available', freshness: 'fresh', observedAt, gaps: ['no_recent_traces'] as const },
		cloudflareTunnel: {
			availability: 'available',
			freshness: 'fresh',
			observedAt,
			gaps: ['external_reachability'] as const,
			containerState: 'running',
			recentDiagnostic: 'none_observed',
		},
		tailscale: {
			availability: 'available',
			freshness: 'fresh',
			observedAt,
			gaps: ['operator_device_reachability'] as const,
			serviceState: 'active',
			backendState: 'Running',
		},
	};
}

type DeploymentComponent = 'host' | 'docker' | 'app' | 'postgres' | 'clickhouse' | 'cloudflare_tunnel' | 'tailscale';

async function triageDeployment(
	component: DeploymentComponent,
	evidence: unknown,
	options: { container?: 'app' | 'postgres' | 'clickhouse' | 'cloudflared'; explicitWindow?: boolean; window?: { start: Date; end: Date } } = {},
) {
	return await readIncident(
		{ kind: 'application', component, ...options, window: options.window ?? { start, end } },
		{
			flush: async () => {},
			getStore: async () => storeFixture(),
			readDeploymentEvidence: async () => evidence as never,
		},
	);
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
			const entityId = (args.filters as { entityId?: string } | undefined)?.entityId;
			const matching = entityId ? branches.filter(branch => branch.entityId === entityId) : branches;
			return {
				branches: matching,
				pagination: { total: matching.length, page: 0, perPage: 6, hasMore: false },
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
sql.begin = operation => operation(sql);

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
			anyOf: [
				{ type: 'string', pattern: '^week\\s+([1-9]|1[0-8])$' },
				{ type: 'null' },
			],
		});
		expect(schema.parse({ kind: 'preceding_request' })).toEqual({ kind: 'preceding_request' });
		expect(schema.parse({ kind: 'preceding_request', component: 'jamis', window: null, humanDomainReference: null })).toEqual({
			kind: 'preceding_request',
			component: 'jamis',
			window: null,
			humanDomainReference: null,
		});
		expect(schema.parse({ kind: 'application', component: 'fantasy-weekly-recap', humanDomainReference: 'Week 1' })).toEqual({
			kind: 'application',
			component: 'fantasy-weekly-recap',
			humanDomainReference: 'Week 1',
		});
		expect(schema.parse({ kind: 'application', component: 'docker' })).toEqual({ kind: 'application', component: 'docker' });
		expect(schema.parse({ kind: 'application', component: 'docker', container: 'postgres' })).toEqual({ kind: 'application', component: 'docker', container: 'postgres' });
		for (const input of [
			{ kind: 'preceding_request', traceId: 'trace-1' },
			{ kind: 'application', component: 'unknown-component' },
			{ kind: 'application', component: 'docker', container: 'secret-container' },
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

	test('directly triages a fixed Deployment component from current evidence', async () => {
		const evidence = deploymentEvidenceFixture();
		const result = await triageDeployment('docker', {
			...evidence,
			docker: {
				...evidence.docker,
				containers: evidence.docker.containers.map(container => container.component === 'postgres'
					? { ...container, state: 'exited', rawDiagnostic }
					: container),
			},
		});
		expect(result).toEqual({
			status: 'found',
			targetKind: 'application',
			incident: {
				component: 'docker',
				observedAtUtc: '2030-01-01T00:00:00Z',
				stage: 'postgres_container',
				classification: 'component_not_running',
				scope: 'current',
				impact: 'component_unavailable',
			},
			evidenceGaps: ['service_functionality', 'external_reachability', 'occurrence_time_unknown', 'cause_unproven'],
		});
		expect((triageIncidentTool.outputSchema as z.ZodTypeAny).safeParse(result).success).toBe(true);
		expect(JSON.stringify(result)).not.toContain(rawDiagnostic);

		for (const component of ['host', 'docker', 'app', 'postgres', 'clickhouse', 'cloudflare_tunnel', 'tailscale'] as const) {
			const source = component === 'cloudflare_tunnel' ? evidence.cloudflareTunnel : evidence[component];
			expect(await triageDeployment(component, evidence)).toEqual({
				status: 'not_found',
				targetKind: 'application',
				component,
				evidenceGaps: ['no_matching_incident', ...source.gaps],
			});
		}
	});

	test('keeps multiple, stale, and unavailable Deployment evidence distinct', async () => {
		const evidence = deploymentEvidenceFixture();
		const ambiguous = await triageDeployment('docker', {
			...evidence,
			docker: {
				...evidence.docker,
				containers: evidence.docker.containers.map(container => container.component === 'app' || container.component === 'postgres'
					? { ...container, state: 'exited' }
					: container),
			},
		});
		expect(ambiguous).toEqual({
			status: 'ambiguous',
			targetKind: 'application',
			candidates: [
				{ component: 'docker', observedAtUtc: '2030-01-01T00:00:00Z', stage: 'app_container' },
				{ component: 'docker', observedAtUtc: '2030-01-01T00:00:00Z', stage: 'postgres_container' },
			],
			evidenceGaps: ['multiple_matching_incidents', 'service_functionality', 'external_reachability'],
		});
		const selectedEvidence = {
			...evidence,
			docker: {
				...evidence.docker,
				containers: evidence.docker.containers.map(container => container.component === 'app' || container.component === 'postgres'
					? { ...container, state: 'exited' }
					: container),
			},
		};
		expect(await triageDeployment('docker', selectedEvidence, { container: 'postgres' })).toMatchObject({
			status: 'found',
			incident: { stage: 'postgres_container' },
		});
		expect(await triageDeployment('docker', selectedEvidence, { container: 'clickhouse' })).toEqual({
			status: 'not_found',
			targetKind: 'application',
			component: 'docker',
			evidenceGaps: ['no_matching_incident', 'service_functionality', 'external_reachability'],
		});
		expect(await triageDeployment('tailscale', selectedEvidence, { container: 'postgres' })).toEqual({
			status: 'unavailable',
			targetKind: 'application',
			component: 'tailscale',
			evidenceGaps: ['unsupported_component'],
		});
		expect(await triageDeployment('docker', selectedEvidence, {
			container: 'postgres',
			explicitWindow: true,
			window: { start: new Date('2020-01-01T00:00:00Z'), end: new Date('2020-01-02T00:00:00Z') },
		})).toEqual({
			status: 'unavailable',
			targetKind: 'application',
			component: 'docker',
			evidenceGaps: ['invalid_window'],
		});

		expect(await triageDeployment('docker', { ...evidence, docker: { ...evidence.docker, freshness: 'stale' } })).toEqual({
			status: 'unavailable',
			targetKind: 'application',
			component: 'docker',
			evidenceGaps: ['stale_evidence'],
		});

		expect(await triageDeployment('docker', { ...evidence, docker: { ...evidence.docker, availability: 'unavailable', freshness: 'unavailable' } })).toEqual({
			status: 'unavailable',
			targetKind: 'application',
			component: 'docker',
			evidenceGaps: ['docker_probe_unavailable'],
		});
	});

	test('classifies the fixed Tunnel and Tailscale failure signals', async () => {
		const evidence = deploymentEvidenceFixture();
		expect(await triageDeployment('cloudflare_tunnel', {
			...evidence,
			cloudflareTunnel: { ...evidence.cloudflareTunnel, recentDiagnostic: 'local_error' },
		})).toEqual({
			status: 'found',
			targetKind: 'application',
			incident: {
				component: 'cloudflare_tunnel',
				observedAtUtc: '2030-01-01T00:00:00Z',
				stage: 'tunnel_diagnostic',
				classification: 'component_error',
				scope: 'current_and_recent_5m',
				impact: 'component_degraded',
			},
			evidenceGaps: ['external_reachability', 'occurrence_time_unknown', 'cause_unproven'],
		});
		expect(await triageDeployment('tailscale', {
			...evidence,
			tailscale: { ...evidence.tailscale, backendState: 'Stopped' },
		})).toMatchObject({
			status: 'found',
			incident: { component: 'tailscale', stage: 'tailscale_backend', classification: 'component_not_running' },
		});
	});

	test('denies preceding-request capability to Studio and subagent tool calls', async () => {
		let flushed = 0;
		const execute = async (requestContext: MastraRequestContext, agentId?: string) => await triageIncidentTool.execute!(
			{ kind: 'preceding_request', component: 'jamis', window: null, humanDomainReference: null },
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

	test('reports an allowlisted Codex authentication reason only from the selected trace', async () => {
		const root = traceRow();
		const model = traceRow({
			name: rawDiagnostic,
			spanType: SpanType.MODEL_INFERENCE,
			parentSpanId: root.spanId,
			status: undefined,
			traceId: root.traceId,
			spanId: 'model-auth',
		});
		const auth = traceRow({
			name: CODEX_AUTH_FAILURE_EVENT,
			spanType: SpanType.GENERIC,
			parentSpanId: model.spanId,
			status: TraceStatus.SUCCESS,
			error: undefined,
			traceId: root.traceId,
			spanId: 'codex-auth',
			metadata: {
				reasonCode: 'credential_missing',
				occurredAtUtc: '2030-01-01T00:00:30.000Z',
				planted: rawDiagnostic,
			},
		});
		const result = await withPrecedingCapability(storeFixture({
			roots: [root],
			structures: new Map([[root.traceId, structure(root, model, auth)]]),
		}));

		expect(result).toEqual({
			status: 'found',
			targetKind: 'preceding_request',
			incident: {
				component: 'jamis',
				occurrenceTimeUtc: '2030-01-01T00:00:30.000Z',
				stage: 'model',
				classification: 'execution_failed',
				scope: 'single_request',
				impact: 'request_failed',
				cause: 'codex_auth_failure',
				codexAuthReason: 'credential_missing',
				traceReference: { traceId: root.traceId, spanId: root.spanId },
			},
			evidenceGaps: [],
		});
		expect(JSON.stringify(result)).not.toContain(rawDiagnostic);
	});

	test('does not replace a nonexact application incident time with a Codex event time', async () => {
		const root = traceRow({ entityId: 'weather-agent', traceId: 'trace-weather-auth' });
		const auth = traceRow({
			name: CODEX_AUTH_FAILURE_EVENT,
			spanType: SpanType.GENERIC,
			parentSpanId: root.spanId,
			status: TraceStatus.SUCCESS,
			error: undefined,
			traceId: root.traceId,
			spanId: 'codex-auth',
			metadata: { reasonCode: 'credential_missing', occurredAtUtc: '2030-01-05T00:00:00.000Z' },
		});
		const result = await readIncident(
			{ kind: 'application', component: 'weather-agent', window: { start, end } },
			{
				flush: async () => {},
				getStore: async () => storeFixture({
					branches: [root],
					structures: new Map([[root.traceId, structure(root, auth)]]),
				}),
			},
		);
		expect(result).toMatchObject({
			status: 'found',
			incident: { component: 'weather-agent', occurrenceTimeUtc: start.toISOString() },
			evidenceGaps: ['trace_identity_not_exact', 'cause_unproven'],
		});
		expect(JSON.stringify(result)).not.toContain('credential_missing');
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

	test('finds an empty-reply failure even when the agent run succeeded', async () => {
		const agent = traceRow({ status: TraceStatus.SUCCESS, error: undefined });
		const channel = traceRow({
			name: SENDBLUE_CHANNEL_SPAN_NAME,
			spanType: SpanType.GENERIC,
			traceId: 'trace-empty-reply',
			spanId: 'span-empty-reply',
			metadata: { stage: 'reply_generation', classification: 'failed', planted: rawDiagnostic },
		});
		const result = await withPrecedingCapability(storeFixture({ roots: [agent, channel], structures: new Map([[agent.traceId, structure(agent)]]) }));
		expect(result).toMatchObject({
			status: 'found',
			incident: { component: 'sendblue-channel', stage: 'reply_generation', classification: 'execution_failed', impact: 'request_failed', cause: 'reply_not_generated', traceReference: { traceId: channel.traceId, spanId: channel.spanId } },
			evidenceGaps: [],
		});
		expect(JSON.stringify(result)).not.toContain(rawDiagnostic);
		expect((triageIncidentTool.outputSchema as z.ZodTypeAny).safeParse(result).success).toBe(true);
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

	test('maps canonical tool components to their Mastra registration keys', async () => {
		for (const [component, entityId] of [
			['check-monitoring', 'checkMonitoring'],
			['current-time', 'currentTime'],
			['propose-operator-time-zone-change', 'proposeOperatorTimeZoneChange'],
			['calendar-events', 'calendarEventsTool'],
			['gmail-search', 'gmailSearchTool'],
			['web-search', 'webSearch'],
			['web-scrape', 'webScrape'],
			['research-source-discover', 'researchSourceDiscover'],
			['research-source-retrieve', 'researchSourceRetrieve'],
			['firecrawl-search', 'firecrawlSearch'],
			['firecrawl-scrape', 'firecrawlScrape'],
			['weather-tool', 'weatherTool'],
			['forecast-tool', 'forecastTool'],
		] as const) {
			const tool = traceRow({ entityId, spanType: SpanType.TOOL_CALL, traceId: `trace-${entityId}`, spanId: `span-${entityId}` });
			let queriedEntityId: unknown;
			const result = await readIncident(
				{ kind: 'application', component, window: { start, end } },
				{
					flush: async () => {},
					getStore: async () => storeFixture({
						branches: [tool],
						structures: new Map([[tool.traceId, structure(tool)]]),
						onBranches: (args) => { queriedEntityId = (args as { filters?: { entityId?: string } }).filters?.entityId; },
					}),
				},
			);
			expect(queriedEntityId).toBe(entityId);
			expect(result).toMatchObject({ status: 'found', incident: { component, stage: 'tool' } });
		}
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
				readFantasyRuns: async (leagueId, week) => {
					seen.push({ leagueId, week });
					return [fantasyRun()];
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

	test('bounds actionable Fantasy runs and validates only exact-week trace evidence', async () => {
		const updatedAt = new Date(start.getTime() + 60_000);
		const single = await readIncident(
			{ kind: 'application', component: 'fantasy-weekly-recap', window: { start, end } },
			{
				fantasyLeagueId: '111',
				flush: async () => {},
				getStore: async () => storeFixture(),
				readFantasyRuns: async (_leagueId, week) => {
					expect(week).toBeUndefined();
					return [fantasyRun({
						fantasyWeek: 7,
						status: 'delivery_unknown',
						latestAttemptTraceId: null,
						failureStage: 'reply_delivery',
						failureClassification: 'execution_interrupted',
						updatedAt,
					})];
				},
			},
		);
		expect(single).toMatchObject({
			status: 'found',
			incident: {
				humanDomainReference: 'week 7',
				stage: 'reply_delivery',
				classification: 'execution_interrupted',
				impact: 'delivery_unconfirmed',
			},
			evidenceGaps: ['trace_identity_not_exact', 'cause_unproven'],
		});

		const multiple = await readIncident(
			{ kind: 'application', component: 'fantasy-weekly-recap', window: { start, end } },
			{
				fantasyLeagueId: '111',
				flush: async () => {},
				getStore: async () => storeFixture(),
				readFantasyRuns: async () => [
					fantasyRun({ fantasyWeek: 6, updatedAt: new Date(start.getTime() + 30_000) }),
					fantasyRun({ fantasyWeek: 7, updatedAt }),
				],
			},
		);
		expect(multiple).toMatchObject({
			status: 'ambiguous',
			candidates: [
				{ component: 'fantasy-weekly-recap', humanDomainReference: 'week 6' },
				{ component: 'fantasy-weekly-recap', humanDomainReference: 'week 7' },
			],
		});

		const stale = await readIncident(
			{ kind: 'application', component: 'fantasy-weekly-recap', humanDomainReference: 'week 1', window: { start, end } },
			{
				fantasyLeagueId: '111',
				flush: async () => {},
				getStore: async () => storeFixture({
					structures: new Map([['trace-fantasy', structure(traceRow({ traceId: 'trace-fantasy', entityId: 'jamis' }))]]),
				}),
				readFantasyRuns: async () => [fantasyRun()],
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
				readFantasyRuns: async () => [fantasyRun({
					latestAttemptTraceId: null,
					failureStage: rawDiagnostic as never,
					failureClassification: rawDiagnostic as never,
				})],
			},
		);
		expect(corrupted).toMatchObject({
			status: 'found',
			incident: { stage: 'unknown', classification: 'unknown' },
			evidenceGaps: ['failure_stage_unknown', 'trace_reference_missing', 'cause_unproven'],
		});
		expect(JSON.stringify([single, multiple, stale, corrupted])).not.toContain(rawDiagnostic);
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

	test('includes bounded durable Fantasy failures in broad history', async () => {
		const run = fantasyRun({
			fantasyWeek: 4,
			latestAttemptTraceId: null,
			updatedAt: new Date(start.getTime() + 60_000),
		});
		const result = await readIncident(
			{ kind: 'application', window: { start, end } },
			{
				fantasyLeagueId: '111',
				flush: async () => {},
				getStore: async () => storeFixture(),
				readFantasyRuns: async (_leagueId, week) => {
					expect(week).toBeUndefined();
					return [run];
				},
			},
		);
		expect(result).toEqual({
			status: 'found',
			targetKind: 'application',
			incident: {
				component: 'fantasy-weekly-recap',
				occurrenceTimeUtc: run.updatedAt.toISOString(),
				stage: 'scheduled_job',
				humanDomainReference: 'week 4',
				classification: 'execution_failed',
				scope: 'single_execution',
				impact: 'execution_failed',
			},
			evidenceGaps: ['trace_identity_not_exact', 'cause_unproven'],
		});

		const root = traceRow({ startedAt: new Date(start.getTime() + 120_000) });
		const secondRun = fantasyRun({
			fantasyWeek: 5,
			latestAttemptTraceId: null,
			updatedAt: new Date(start.getTime() + 90_000),
		});
		const rootCalls: unknown[] = [];
		const mixed = await readIncident(
			{ kind: 'application', window: { start, end } },
			{
				fantasyLeagueId: '111',
				flush: async () => {},
				getStore: async () => storeFixture({
					roots: [root],
					structures: new Map([[root.traceId, structure(root)]]),
					onRoots: args => rootCalls.push(args),
				}),
				readFantasyRuns: async () => [run, secondRun],
			},
		);
		expect(rootCalls[0]).toMatchObject({ pagination: { page: 0, perPage: 4 } });
		expect(mixed).toMatchObject({
			status: 'ambiguous',
			candidates: [
				{ component: 'fantasy-weekly-recap', humanDomainReference: 'week 4' },
				{ component: 'fantasy-weekly-recap', humanDomainReference: 'week 5' },
				{ component: 'jamis' },
			],
		});
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
