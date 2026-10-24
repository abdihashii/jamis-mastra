import type { RequestContext } from '@mastra/core/request-context';
import type { GetStructureResponse, ObservabilityStorage } from '@mastra/core/storage';
import type { RecapRun } from '../../lib/fantasy/runs';

import type { DeploymentSnapshotFinding } from './deployment-monitoring';
import { SpanType } from '@mastra/core/observability';
import { extractBranchSpans, TraceStatus } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getFantasyConfig } from '../../lib/fantasy/config';
import { getFantasySql } from '../../lib/fantasy/recaps';
import { getRun, listActionableRuns } from '../../lib/fantasy/runs';
import { resolveOperatorTimeZone } from '../../lib/operator-time-zone';

import { dateTimeInstant } from '../../lib/time';
import {
	getSendblueChannelCapability,
	hashSendblueMessageHandle,
	isOperator,
	SENDBLUE_CHANNEL_SPAN_NAME,
	SENDBLUE_CORRELATION_KEY,
} from '../channels/sendblue';
import { requireOperatorTimeZone } from '../env';
import { CODEX_AUTH_FAILURE_EVENT } from '../observability';
import { readFullDeploymentEvidence } from './deployment-evidence';
import {
	awaitDeploymentClarification,
	clearDeploymentSnapshot,
	consumeFailedDeploymentSnapshotReply,
	deploymentFindingSelectorSchema,
	deploymentMonitoringGapSchema,
	getDeploymentSnapshot,
} from './deployment-monitoring';

const QUERY_LIMIT = 6;
const RESULT_LIMIT = 5;
const HISTORY_LIMIT = 50;
const MAX_WINDOW_MS = 168 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

const deploymentIncidentComponents = [
	'host',
	'docker',
	'app',
	'postgres',
	'clickhouse',
	'cloudflare_tunnel',
	'tailscale',
] as const;
const dockerContainers = ['app', 'postgres', 'clickhouse', 'cloudflared'] as const;

const incidentComponents = [
	'sendblue-channel',
	'jamis',
	'fantasy-agent',
	'fantasy-football-pundit',
	'fantasy-football-editor',
	'invoke_fantasy_pundit',
	'invoke_fantasy_editor',
	'prepare_fantasy_recap',
	'prepare_fantasy_editorial_candidate',
	'broadcaster',
	'invoke_broadcaster',
	'publish_fantasy_recap',
	'publish_saved_fantasy_report',
	'deliver_saved_report',
	'validate_saved_report_delivery_args',
	'research-agent',
	'weather-agent',
	'personal-accounts-agent',
	'invoke_weather',
	'invoke_research',
	'invoke_personal_accounts',
	'invoke_fantasy_broadcast',
	'fantasy-broadcast-agent',
	'fantasy-weekly-recap',
	'check-monitoring',
	'current-time',
	'propose-operator-time-zone-change',
	'calendar-events',
	'gmail-search',
	'web-search',
	'web-scrape',
	'research-source-discover',
	'research-source-retrieve',
	'firecrawl-search',
	'firecrawl-scrape',
	'weather-tool',
	'forecast-tool',
	'draft_group_message',
	'send_group_message',
	...deploymentIncidentComponents,
] as const;

const incidentComponentSchema = z.enum(incidentComponents);
const incidentDateTimeSchema = z.union([
	z.iso.date(),
	z.iso.datetime({ offset: true, local: true }),
]);
const incidentWindowInputSchema = z.object({
	start: incidentDateTimeSchema,
	end: incidentDateTimeSchema,
}).strict();
const triageIncidentInputSchema = z.object({
	kind: z.enum(['preceding_request', 'application', 'monitoring_finding']),
	component: incidentComponentSchema.nullish(),
	container: z.enum(dockerContainers).nullish(),
	window: incidentWindowInputSchema.nullish(),
	humanDomainReference: z.string().trim().regex(/^week\s+([1-9]|1[0-8])$/i).nullish(),
	finding: deploymentFindingSelectorSchema.nullish(),
}).strict().superRefine((input, context) => {
	if (input.kind === 'monitoring_finding' && (input.component || input.container || input.window || input.humanDomainReference))
		context.addIssue({ code: 'custom', path: ['kind'], message: 'Monitoring findings accept only safe finding clues' });
	if (input.kind !== 'monitoring_finding' && input.finding)
		context.addIssue({ code: 'custom', path: ['finding'], message: 'Finding clues require a Monitoring follow-up' });
});

type TriageIncidentInput = z.infer<typeof triageIncidentInputSchema>;

export type IncidentComponent = typeof incidentComponents[number];
type DeploymentIncidentComponent = typeof deploymentIncidentComponents[number];
const traceEntityIds: Partial<Record<IncidentComponent, string>> = {
	'check-monitoring': 'checkMonitoring',
	'current-time': 'currentTime',
	'propose-operator-time-zone-change': 'proposeOperatorTimeZoneChange',
	'calendar-events': 'calendarEventsTool',
	'gmail-search': 'gmailSearchTool',
	'web-search': 'webSearch',
	'web-scrape': 'webScrape',
	'research-source-discover': 'researchSourceDiscover',
	'research-source-retrieve': 'researchSourceRetrieve',
	'firecrawl-search': 'firecrawlSearch',
	'firecrawl-scrape': 'firecrawlScrape',
	'weather-tool': 'weatherTool',
	'forecast-tool': 'forecastTool',
};
export type IncidentFailureStage
	= | 'channel_intake'
		| 'agent'
		| 'model'
		| 'tool'
		| 'workflow'
		| 'scheduled_job'
		| 'application_storage'
		| 'reply_delivery'
		| 'reply_generation'
		| 'app_container'
		| 'postgres_container'
		| 'clickhouse_container'
		| 'cloudflared_container'
		| 'tunnel_diagnostic'
		| 'tailscale_service'
		| 'tailscale_backend'
		| 'unknown';
export type IncidentClassification = 'intake_failed' | 'execution_failed' | 'execution_interrupted' | 'delivery_failed' | 'component_not_running' | 'component_error' | 'unknown';
export type IncidentEvidenceGap
	= | 'invalid_window'
		| 'unsupported_component'
		| 'operator_time_zone_unavailable'
		| 'missing_channel_capability'
		| 'message_history_unavailable'
		| 'preceding_request_not_found'
		| 'observability_flush_failed'
		| 'observability_storage_unavailable'
		| 'observability_query_failed'
		| 'fantasy_configuration_unavailable'
		| 'fantasy_storage_unavailable'
		| 'unsupported_domain_reference'
		| 'trace_structure_unavailable'
		| 'trace_reference_missing'
		| 'trace_reference_stale'
		| 'failure_stage_unknown'
		| 'trace_identity_not_exact'
		| 'cause_unproven'
		| 'occurrence_time_unknown'
		| 'stale_evidence'
		| 'host_probe_unavailable'
		| 'docker_probe_unavailable'
		| 'postgres_query_unavailable'
		| 'clickhouse_query_unavailable'
		| 'tunnel_probe_unavailable'
		| 'tailscale_probe_unavailable'
		| 'container_state_unavailable'
		| 'tunnel_diagnostic_unavailable'
		| 'deployment_evidence_unavailable'
		| 'external_reachability'
		| 'recent_host_events'
		| 'service_functionality'
		| 'recent_tunnel_diagnostics_unavailable'
		| 'operator_device_reachability'
		| 'tailscale_status_unavailable'
		| 'fantasy_not_configured'
		| 'fantasy_runs_unavailable'
		| 'no_fantasy_runs'
		| 'trace_reference_unavailable'
		| 'product_outcomes_unchecked'
		| 'no_recent_traces'
		| 'no_matching_incident'
		| 'multiple_matching_incidents'
		| 'monitoring_snapshot_unavailable'
		| 'monitoring_finding_not_found'
		| z.infer<typeof deploymentMonitoringGapSchema>;

export type IncidentTarget
	= | { kind: 'preceding_request' }
		| { kind: 'monitoring_finding'; finding?: z.infer<typeof deploymentFindingSelectorSchema> }
		| {
			kind: 'application';
			component?: IncidentComponent;
			container?: typeof dockerContainers[number];
			humanDomainReference?: string;
			explicitWindow?: boolean;
			window: { start: Date; end: Date };
		};
type ApplicationIncidentTarget = Extract<IncidentTarget, { kind: 'application' }>;
type DeploymentIncidentTarget = ApplicationIncidentTarget & { component: DeploymentIncidentComponent };

interface IncidentCandidateBase {
	component: IncidentComponent | 'unknown';
	stage: IncidentFailureStage;
	humanDomainReference?: string;
}
export type IncidentCandidate
	= | (IncidentCandidateBase & { occurrenceTimeUtc: string })
		| (IncidentCandidateBase & { observedAtUtc: string });

export type IncidentResult
	= | {
		status: 'found';
		targetKind: IncidentTarget['kind'];
		incident: IncidentCandidate & {
			classification: IncidentClassification;
			scope: 'single_request' | 'single_execution' | 'current' | 'current_and_recent_5m';
			impact: 'request_failed' | 'execution_failed' | 'execution_degraded' | 'reply_not_delivered' | 'delivery_unconfirmed' | 'component_unavailable' | 'component_degraded';
			cause?: 'reply_delivery_failed' | 'reply_not_generated' | 'codex_auth_failure';
			codexAuthReason?: CodexAuthFailureReason;
			traceReference?: { traceId: string; spanId: string };
		};
		evidenceGaps: IncidentEvidenceGap[];
	}
	| {
		status: 'ambiguous';
		targetKind: IncidentTarget['kind'];
		candidates: IncidentCandidate[];
		evidenceGaps: IncidentEvidenceGap[];
	}
	| {
		status: 'not_found' | 'unavailable';
		targetKind: IncidentTarget['kind'];
		component?: IncidentComponent;
		evidenceGaps: IncidentEvidenceGap[];
	};

const incidentFailureStageSchema = z.enum([
	'channel_intake',
	'agent',
	'model',
	'tool',
	'workflow',
	'scheduled_job',
	'application_storage',
	'reply_delivery',
	'reply_generation',
	'app_container',
	'postgres_container',
	'clickhouse_container',
	'cloudflared_container',
	'tunnel_diagnostic',
	'tailscale_service',
	'tailscale_backend',
	'unknown',
]);
const incidentClassificationSchema = z.enum([
	'intake_failed',
	'execution_failed',
	'execution_interrupted',
	'delivery_failed',
	'component_not_running',
	'component_error',
	'unknown',
]);
const codexAuthFailureReasonSchema = z.enum([
	'credential_missing',
	'refresh_before_safe_window',
	'refresh_rejected',
	'refresh_transport_failed',
	'credential_write_failed',
	'unauthorized_after_retry',
]);
type CodexAuthFailureReason = z.infer<typeof codexAuthFailureReasonSchema>;
const incidentEvidenceGapSchema = z.enum([
	'invalid_window',
	'unsupported_component',
	'operator_time_zone_unavailable',
	'missing_channel_capability',
	'message_history_unavailable',
	'preceding_request_not_found',
	'observability_flush_failed',
	'observability_storage_unavailable',
	'observability_query_failed',
	'fantasy_configuration_unavailable',
	'fantasy_storage_unavailable',
	'unsupported_domain_reference',
	'trace_structure_unavailable',
	'trace_reference_missing',
	'trace_reference_stale',
	'failure_stage_unknown',
	'trace_identity_not_exact',
	'cause_unproven',
	'occurrence_time_unknown',
	'stale_evidence',
	'host_probe_unavailable',
	'docker_probe_unavailable',
	'postgres_query_unavailable',
	'clickhouse_query_unavailable',
	'tunnel_probe_unavailable',
	'tailscale_probe_unavailable',
	'container_state_unavailable',
	'tunnel_diagnostic_unavailable',
	'deployment_evidence_unavailable',
	'external_reachability',
	'recent_host_events',
	'service_functionality',
	'recent_tunnel_diagnostics_unavailable',
	'operator_device_reachability',
	'tailscale_status_unavailable',
	'fantasy_not_configured',
	'fantasy_runs_unavailable',
	'no_fantasy_runs',
	'trace_reference_unavailable',
	'product_outcomes_unchecked',
	'no_recent_traces',
	'no_matching_incident',
	'multiple_matching_incidents',
	'monitoring_snapshot_unavailable',
	'monitoring_finding_not_found',
]).or(deploymentMonitoringGapSchema);
const incidentCandidateBaseSchema = z.object({
	component: z.union([incidentComponentSchema, z.literal('unknown')]),
	stage: incidentFailureStageSchema,
	humanDomainReference: z.string().optional(),
});
const incidentCandidateSchema = z.union([
	incidentCandidateBaseSchema.extend({ occurrenceTimeUtc: z.string() }).strict(),
	incidentCandidateBaseSchema.extend({ observedAtUtc: z.string() }).strict(),
]);
const foundIncidentBaseSchema = incidentCandidateBaseSchema.extend({
	classification: incidentClassificationSchema,
	scope: z.enum(['single_request', 'single_execution', 'current', 'current_and_recent_5m']),
	impact: z.enum(['request_failed', 'execution_failed', 'execution_degraded', 'reply_not_delivered', 'delivery_unconfirmed', 'component_unavailable', 'component_degraded']),
	cause: z.enum(['reply_delivery_failed', 'reply_not_generated', 'codex_auth_failure']).optional(),
	codexAuthReason: codexAuthFailureReasonSchema.optional(),
	traceReference: z.object({ traceId: z.string(), spanId: z.string() }).strict().optional(),
});
const foundIncidentSchema = z.union([
	foundIncidentBaseSchema.extend({ occurrenceTimeUtc: z.string() }).strict(),
	foundIncidentBaseSchema.extend({ observedAtUtc: z.string() }).strict(),
]);
const incidentResultSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('found'),
		targetKind: z.enum(['preceding_request', 'application', 'monitoring_finding']),
		incident: foundIncidentSchema,
		evidenceGaps: z.array(incidentEvidenceGapSchema),
	}).strict(),
	z.object({
		status: z.literal('ambiguous'),
		targetKind: z.enum(['preceding_request', 'application', 'monitoring_finding']),
		candidates: z.array(incidentCandidateSchema).max(RESULT_LIMIT),
		evidenceGaps: z.array(incidentEvidenceGapSchema),
	}).strict(),
	z.object({
		status: z.literal('not_found'),
		targetKind: z.enum(['preceding_request', 'application', 'monitoring_finding']),
		component: incidentComponentSchema.optional(),
		evidenceGaps: z.array(incidentEvidenceGapSchema),
	}).strict(),
	z.object({
		status: z.literal('unavailable'),
		targetKind: z.enum(['preceding_request', 'application', 'monitoring_finding']),
		component: incidentComponentSchema.optional(),
		evidenceGaps: z.array(incidentEvidenceGapSchema),
	}).strict(),
]);

export type IncidentStore = Pick<ObservabilityStorage, 'listTracesLight' | 'listBranches' | 'getStructure'>;

interface TraceRow {
	traceId: string;
	spanId: string;
	name: string;
	spanType: SpanType;
	startedAt: Date;
	parentSpanId?: string | null;
	status?: TraceStatus | null;
	error?: unknown;
	entityId?: string | null;
	metadata?: Record<string, unknown> | null;
}

interface IncidentReaderContext {
	flush: () => Promise<void>;
	getStore: () => Promise<IncidentStore | undefined>;
	requestContext?: RequestContext;
	fantasyLeagueId?: string;
	readFantasyRuns?: (leagueId: string, week: number | undefined, start: Date, end: Date) => Promise<RecapRun[]>;
	readDeploymentEvidence?: () => Promise<Awaited<ReturnType<typeof readFullDeploymentEvidence>>>;
}

function isIncidentComponent(value: unknown): value is IncidentComponent {
	return typeof value === 'string' && (incidentComponents as readonly string[]).includes(value);
}

function isDeploymentIncidentComponent(value: IncidentComponent | undefined): value is DeploymentIncidentComponent {
	return !!value && (deploymentIncidentComponents as readonly string[]).includes(value);
}

function traceEntityId(component: IncidentComponent): string {
	return traceEntityIds[component] ?? component;
}

function componentOf(row: TraceRow, expected?: IncidentComponent): IncidentComponent | 'unknown' {
	if (expected)
		return expected;
	if (row.name === SENDBLUE_CHANNEL_SPAN_NAME)
		return 'sendblue-channel';
	return isIncidentComponent(row.entityId) ? row.entityId : 'unknown';
}

function stageOf(spanType: SpanType): IncidentFailureStage {
	switch (spanType) {
		case SpanType.AGENT_RUN:
			return 'agent';
		case SpanType.MODEL_GENERATION:
		case SpanType.MODEL_STEP:
		case SpanType.MODEL_INFERENCE:
		case SpanType.MODEL_CHUNK:
			return 'model';
		case SpanType.TOOL_CALL:
		case SpanType.MCP_TOOL_CALL:
		case SpanType.CLIENT_TOOL_CALL:
		case SpanType.PROVIDER_TOOL_CALL:
			return 'tool';
		case SpanType.WORKFLOW_RUN:
		case SpanType.WORKFLOW_STEP:
		case SpanType.WORKFLOW_CONDITIONAL:
		case SpanType.WORKFLOW_CONDITIONAL_EVAL:
		case SpanType.WORKFLOW_PARALLEL:
		case SpanType.WORKFLOW_LOOP:
		case SpanType.WORKFLOW_SLEEP:
		case SpanType.WORKFLOW_WAIT_EVENT:
			return 'workflow';
		case SpanType.MEMORY_OPERATION:
		case SpanType.RAG_VECTOR_OPERATION:
			return 'application_storage';
		default:
			return 'unknown';
	}
}

function channelFailure(row: TraceRow): 'channel_intake' | 'reply_delivery' | 'reply_generation' | undefined {
	if (row.name !== SENDBLUE_CHANNEL_SPAN_NAME || row.metadata?.classification !== 'failed')
		return;
	if (row.metadata.stage === 'channel_intake')
		return 'channel_intake';
	if (row.metadata.stage === 'reply_delivery')
		return 'reply_delivery';
	if (row.metadata.stage === 'reply_generation')
		return 'reply_generation';
}

function deepestFailedSpan(structure: GetStructureResponse, anchorSpanId: string): TraceRow | undefined {
	const spans = extractBranchSpans(structure.spans, anchorSpanId);
	const failed = spans.filter(span => span.status === TraceStatus.ERROR || span.error != null);
	const byId = new Map(spans.map(span => [span.spanId, span]));
	const depth = (span: TraceRow): number => {
		let current = span;
		let result = 0;
		const seen = new Set<string>();
		while (current.parentSpanId && !seen.has(current.parentSpanId)) {
			seen.add(current.parentSpanId);
			const parent = byId.get(current.parentSpanId);
			if (!parent)
				break;
			result++;
			current = parent;
		}
		return result;
	};
	return failed.reduce<TraceRow | undefined>((deepest, span) => !deepest || depth(span) > depth(deepest) ? span : deepest, undefined);
}

function codexAuthFailure(structure: GetStructureResponse, anchorSpanId: string): { reason: CodexAuthFailureReason; occurredAtUtc: string } | undefined {
	for (const span of extractBranchSpans(structure.spans, anchorSpanId) as TraceRow[]) {
		if (span.name !== CODEX_AUTH_FAILURE_EVENT)
			continue;
		const reason = codexAuthFailureReasonSchema.safeParse(span.metadata?.reasonCode);
		const occurredAtUtc = z.iso.datetime({ offset: true }).safeParse(span.metadata?.occurredAtUtc);
		if (reason.success && occurredAtUtc.success)
			return { reason: reason.data, occurredAtUtc: new Date(occurredAtUtc.data).toISOString() };
	}
}

async function inspectCandidate(
	store: IncidentStore,
	row: TraceRow,
	expectedComponent?: IncidentComponent,
): Promise<{ anchorFailed: boolean; candidate: IncidentCandidate; codexAuthReason?: CodexAuthFailureReason; codexAuthOccurredAtUtc?: string; failed: boolean; gaps: IncidentEvidenceGap[] }> {
	const channel = channelFailure(row);
	if (channel) {
		return {
			anchorFailed: true,
			candidate: { component: 'sendblue-channel', occurrenceTimeUtc: row.startedAt.toISOString(), stage: channel },
			failed: true,
			gaps: [],
		};
	}

	const structure = await store.getStructure({ traceId: row.traceId });
	const failure = structure ? deepestFailedSpan(structure, row.spanId) : undefined;
	const authFailure = structure ? codexAuthFailure(structure, row.spanId) : undefined;
	const stage = stageOf(failure?.spanType ?? row.spanType);
	const anchorFailed = row.status === TraceStatus.ERROR || row.error != null;
	const gaps: IncidentEvidenceGap[] = [];
	if (!structure)
		gaps.push('trace_structure_unavailable');
	if (stage === 'unknown')
		gaps.push('failure_stage_unknown');
	return {
		anchorFailed,
		candidate: {
			component: componentOf(row, expectedComponent),
			occurrenceTimeUtc: row.startedAt.toISOString(),
			stage,
		},
		...(authFailure ? { codexAuthReason: authFailure.reason, codexAuthOccurredAtUtc: authFailure.occurredAtUtc } : {}),
		failed: !!failure || anchorFailed,
		gaps,
	};
}

function unavailable(target: IncidentTarget, gap: IncidentEvidenceGap, gaps: IncidentEvidenceGap[] = []): IncidentResult {
	return {
		status: 'unavailable',
		targetKind: target.kind,
		...(target.kind === 'application' && isIncidentComponent(target.component) ? { component: target.component } : {}),
		evidenceGaps: [gap, ...gaps.filter(other => other !== gap)],
	};
}

function notFound(target: IncidentTarget, gaps: IncidentEvidenceGap[] = []): IncidentResult {
	return {
		status: 'not_found',
		targetKind: target.kind,
		...(target.kind === 'application' && target.component ? { component: target.component } : {}),
		evidenceGaps: ['no_matching_incident', ...gaps],
	};
}

function ambiguous(target: IncidentTarget, candidates: IncidentCandidate[], gaps: IncidentEvidenceGap[] = []): IncidentResult {
	return {
		status: 'ambiguous',
		targetKind: target.kind,
		candidates: candidates.slice(0, RESULT_LIMIT),
		evidenceGaps: ['multiple_matching_incidents', ...gaps],
	};
}

function found(
	target: IncidentTarget,
	row: TraceRow,
	inspected: Awaited<ReturnType<typeof inspectCandidate>>,
	exact: boolean,
): IncidentResult {
	const { candidate, gaps } = inspected;
	const delivery = candidate.stage === 'reply_delivery';
	const codexAuthReason = exact ? inspected.codexAuthReason : undefined;
	const cause = delivery && exact
		? 'reply_delivery_failed' as const
		: candidate.stage === 'reply_generation' && exact
			? 'reply_not_generated' as const
			: codexAuthReason ? 'codex_auth_failure' as const : undefined;
	return {
		status: 'found',
		targetKind: target.kind,
		incident: {
			...candidate,
			...(codexAuthReason ? { occurrenceTimeUtc: inspected.codexAuthOccurredAtUtc } : {}),
			classification: delivery
				? 'delivery_failed'
				: candidate.stage === 'channel_intake'
					? 'intake_failed'
					: candidate.stage === 'unknown' ? 'unknown' : 'execution_failed',
			scope: target.kind === 'preceding_request' ? 'single_request' : 'single_execution',
			impact: delivery
				? 'reply_not_delivered'
				: target.kind === 'preceding_request'
					? inspected.anchorFailed ? 'request_failed' : 'execution_degraded'
					: 'execution_failed',
			...(cause ? { cause } : {}),
			...(codexAuthReason ? { codexAuthReason } : {}),
			...(exact ? { traceReference: { traceId: row.traceId, spanId: row.spanId } } : {}),
		},
		evidenceGaps: [
			...gaps,
			...exact ? [] : ['trace_identity_not_exact' as const],
			...cause ? [] : ['cause_unproven' as const],
		],
	};
}

const deploymentUnavailableGaps: Record<DeploymentIncidentComponent, IncidentEvidenceGap> = {
	host: 'host_probe_unavailable',
	docker: 'docker_probe_unavailable',
	app: 'deployment_evidence_unavailable',
	postgres: 'postgres_query_unavailable',
	clickhouse: 'clickhouse_query_unavailable',
	cloudflare_tunnel: 'tunnel_probe_unavailable',
	tailscale: 'tailscale_probe_unavailable',
};

const dockerStages = {
	app: 'app_container',
	postgres: 'postgres_container',
	clickhouse: 'clickhouse_container',
	cloudflared: 'cloudflared_container',
} as const;

interface DeploymentFinding {
	candidate: Extract<IncidentCandidate, { observedAtUtc: string }>;
	classification: Extract<IncidentClassification, 'component_not_running' | 'component_error'>;
	impact: Extract<IncidentResult, { status: 'found' }>['incident']['impact'];
}

function deploymentResult(
	target: ApplicationIncidentTarget,
	findings: DeploymentFinding[],
	gaps: IncidentEvidenceGap[] = [],
): IncidentResult {
	if (findings.length > 1)
		return ambiguous(target, findings.map(finding => finding.candidate), gaps);
	if (findings.length === 0)
		return notFound(target, gaps);
	const finding = findings[0]!;
	return {
		status: 'found',
		targetKind: 'application',
		incident: {
			...finding.candidate,
			classification: finding.classification,
			scope: target.component === 'cloudflare_tunnel' ? 'current_and_recent_5m' : 'current',
			impact: finding.impact,
		},
		evidenceGaps: [...gaps, 'occurrence_time_unknown', 'cause_unproven'],
	};
}

async function readDeploymentIncident(
	target: DeploymentIncidentTarget,
	context: IncidentReaderContext,
): Promise<IncidentResult> {
	let evidence: Awaited<ReturnType<typeof readFullDeploymentEvidence>>;
	try {
		evidence = await context.readDeploymentEvidence?.() ?? await readFullDeploymentEvidence(context.getStore);
	} catch {
		return unavailable(target, 'deployment_evidence_unavailable');
	}
	const current = target.component === 'cloudflare_tunnel'
		? evidence.cloudflareTunnel
		: evidence[target.component];
	if (current.availability !== 'available')
		return unavailable(target, deploymentUnavailableGaps[target.component]);
	if (current.freshness !== 'fresh')
		return unavailable(target, 'stale_evidence');
	const observedAtMs = Date.parse(current.observedAt);
	if (target.explicitWindow && (observedAtMs < target.window.start.getTime() || observedAtMs > target.window.end.getTime()))
		return unavailable(target, 'invalid_window');
	const sourceGaps: IncidentEvidenceGap[] = current.gaps;

	const finding = (stage: IncidentFailureStage, classification: DeploymentFinding['classification'], impact: DeploymentFinding['impact']): DeploymentFinding => ({
		candidate: { component: target.component, observedAtUtc: current.observedAt, stage },
		classification,
		impact,
	});
	if (target.component === 'docker') {
		const containers = evidence.docker.containers.filter(container => !target.container || container.component === target.container);
		const findings = containers
			.filter(container => container.state !== 'running' && container.state !== 'unknown')
			.map(container => finding(dockerStages[container.component], 'component_not_running', 'component_unavailable'));
		const hasUnknownState = containers.some(container => container.state === 'unknown');
		if (findings.length === 0 && hasUnknownState)
			return unavailable(target, 'container_state_unavailable', sourceGaps);
		return deploymentResult(target, findings, [...sourceGaps, ...hasUnknownState ? ['container_state_unavailable' as const] : []]);
	}
	if (target.component === 'cloudflare_tunnel') {
		const findings: DeploymentFinding[] = [];
		if (evidence.cloudflareTunnel.containerState !== 'running' && evidence.cloudflareTunnel.containerState !== 'unknown')
			findings.push(finding('cloudflared_container', 'component_not_running', 'component_unavailable'));
		if (evidence.cloudflareTunnel.recentDiagnostic === 'local_error')
			findings.push(finding('tunnel_diagnostic', 'component_error', 'component_degraded'));
		const gaps: IncidentEvidenceGap[] = [
			...sourceGaps,
			...(evidence.cloudflareTunnel.containerState === 'unknown' ? ['container_state_unavailable' as const] : []),
			...(evidence.cloudflareTunnel.recentDiagnostic === 'unknown' ? ['tunnel_diagnostic_unavailable' as const] : []),
		];
		if (findings.length === 0 && evidence.cloudflareTunnel.containerState === 'unknown')
			return unavailable(target, 'container_state_unavailable', gaps);
		if (findings.length === 0 && evidence.cloudflareTunnel.recentDiagnostic === 'unknown')
			return unavailable(target, 'tunnel_diagnostic_unavailable', gaps);
		return deploymentResult(target, findings, gaps);
	}
	if (target.component === 'tailscale') {
		const findings: DeploymentFinding[] = [];
		if (evidence.tailscale.serviceState !== 'active' && evidence.tailscale.serviceState !== 'unknown')
			findings.push(finding('tailscale_service', 'component_not_running', 'component_unavailable'));
		if (evidence.tailscale.backendState !== 'Running' && evidence.tailscale.backendState !== 'unknown')
			findings.push(finding('tailscale_backend', 'component_not_running', 'component_unavailable'));
		const hasUnknownState = evidence.tailscale.serviceState === 'unknown' || evidence.tailscale.backendState === 'unknown';
		if (findings.length === 0 && hasUnknownState)
			return unavailable(target, 'container_state_unavailable', sourceGaps);
		return deploymentResult(target, findings, [...sourceGaps, ...hasUnknownState ? ['container_state_unavailable' as const] : []]);
	}
	return notFound(target, sourceGaps);
}

function snapshotCandidate(finding: DeploymentSnapshotFinding, observedAtUtc: string): IncidentCandidate {
	const { item } = finding;
	const component: IncidentCandidate['component'] = item.subject === 'operator_conversation'
		? item.fact === 'top_level_execution_failed' ? 'jamis' : 'sendblue-channel'
		: item.subject === 'fantasy_recaps' ? 'fantasy-weekly-recap' : item.subject;
	const stage: IncidentFailureStage = item.fact === 'reply_acceptance_failed'
		? 'reply_delivery'
		: item.fact === 'reply_not_generated'
			? 'reply_generation'
			: item.fact === 'intake_failed'
				? 'channel_intake'
				: item.fact === 'top_level_execution_failed'
					? 'agent'
					: item.fact === 'recap_failed' || item.fact === 'recap_delivery_unknown'
						? finding.fantasyStage ?? 'unknown'
						: item.fact === 'recap_execution_failed' || item.fact === 'recap_expired_active'
							? 'scheduled_job'
							: item.fact === 'tunnel_local_error'
								? 'tunnel_diagnostic'
								: item.fact === 'container_not_running' && item.container
									? dockerStages[item.container]
									: 'unknown';
	const base = { component, stage, ...(item.week ? { humanDomainReference: `week ${item.week}` } : {}) };
	return item.boundary === 'current' || item.boundary === 'current_instance' || item.boundary === 'current_and_recent_5m' || !item.at
		? { ...base, observedAtUtc: item.at ?? observedAtUtc }
		: { ...base, occurrenceTimeUtc: item.at };
}

async function readMonitoringFinding(
	target: Extract<IncidentTarget, { kind: 'monitoring_finding' }>,
	context: IncidentReaderContext,
): Promise<IncidentResult> {
	const capability = context.requestContext && getSendblueChannelCapability(context.requestContext);
	if (!capability)
		return unavailable(target, 'missing_channel_capability');
	let precedingMessageId: string | undefined;
	try {
		const { messages } = await capability.thread.adapter.fetchMessages(capability.thread.id, { limit: HISTORY_LIMIT });
		const operatorMessages = messages.filter(message => message.threadId === capability.thread.id && isOperator(message));
		const currentIndex = operatorMessages.findIndex(message => message.id === capability.message.id);
		precedingMessageId = currentIndex > 0 ? operatorMessages[currentIndex - 1]?.id : undefined;
	} catch {
		return unavailable(target, 'message_history_unavailable');
	}
	if (!precedingMessageId)
		return unavailable(target, 'monitoring_snapshot_unavailable');
	const snapshot = getDeploymentSnapshot(capability.thread.id, precedingMessageId);
	if (!snapshot && consumeFailedDeploymentSnapshotReply(capability.thread.id, precedingMessageId))
		return readIncident({ kind: 'preceding_request' }, context);
	if (!snapshot)
		return unavailable(target, 'monitoring_snapshot_unavailable');
	const clues = Object.entries(target.finding ?? {})
		.filter(([, value]) => value != null)
		.map(([key, value]) => [key, key === 'at' ? new Date(value as string).toISOString() : value] as const);
	const matches = snapshot.findings.filter(({ item }) => clues.every(([key, value]) => item[key as keyof typeof item] === value));
	if (matches.length === 0)
		return notFound(target, ['monitoring_finding_not_found']);
	if (matches.length > 1) {
		awaitDeploymentClarification(capability.thread.id, precedingMessageId, capability.message.id);
		return ambiguous(target, matches.map(finding => snapshotCandidate(finding, snapshot.summary.observedAt)));
	}
	clearDeploymentSnapshot(capability.thread.id);
	const finding = matches[0]!;
	const { item } = finding;
	const candidate = snapshotCandidate(finding, snapshot.summary.observedAt);
	const classification: IncidentClassification = item.fact === 'reply_acceptance_failed'
		? 'delivery_failed'
		: item.fact === 'intake_failed'
			? 'intake_failed'
			: item.fact === 'recap_failed' || item.fact === 'recap_delivery_unknown'
				? finding.fantasyClassification ?? 'unknown'
				: item.fact === 'recap_expired_active'
					? 'unknown'
					: item.fact === 'top_level_execution_failed' || item.fact === 'reply_not_generated' || item.fact === 'recap_execution_failed'
						? 'execution_failed'
						: item.fact === 'tunnel_local_error' ? 'component_error' : 'component_not_running';
	const provenFantasyDeliveryFailure = item.fact === 'recap_failed' && finding.fantasyStage === 'reply_delivery' && finding.fantasyClassification === 'delivery_failed';
	const impact: Extract<IncidentResult, { status: 'found' }>['incident']['impact'] = item.fact === 'reply_acceptance_failed' || provenFantasyDeliveryFailure
		? 'reply_not_delivered'
		: item.fact === 'intake_failed' || item.fact === 'reply_not_generated'
			? 'request_failed'
			: item.fact === 'recap_delivery_unknown'
				? 'delivery_unconfirmed'
				: item.fact === 'top_level_execution_failed' || item.fact === 'recap_failed' || item.fact === 'recap_execution_failed'
					? 'execution_failed'
					: item.fact === 'recap_expired_active'
						? 'execution_degraded'
						: item.fact === 'tunnel_local_error' ? 'component_degraded' : 'component_unavailable';
	const gaps: IncidentEvidenceGap[] = snapshot.summary.unknowns
		.filter(unknown => unknown.subject === item.subject && (!unknown.container || unknown.container === item.container))
		.map(unknown => unknown.gap);
	if ('observedAtUtc' in candidate)
		gaps.push('occurrence_time_unknown');
	if (candidate.stage === 'unknown')
		gaps.push('failure_stage_unknown');
	const cause = (item.fact === 'reply_acceptance_failed' && finding.traceReference) || provenFantasyDeliveryFailure
		? 'reply_delivery_failed' as const
		: item.fact === 'reply_not_generated' && finding.traceReference ? 'reply_not_generated' as const : undefined;
	if (!cause)
		gaps.push('cause_unproven');
	return {
		status: 'found',
		targetKind: 'monitoring_finding',
		incident: {
			...candidate,
			classification,
			scope: item.boundary === 'current_and_recent_5m'
				? 'current_and_recent_5m'
				: 'observedAtUtc' in candidate
					? 'current'
					: item.subject === 'operator_conversation' ? 'single_request' : 'single_execution',
			impact,
			...(cause ? { cause } : {}),
			...(finding.traceReference ? { traceReference: finding.traceReference } : {}),
		},
		evidenceGaps: [...new Set(gaps)],
	};
}

function hasMore(response: { pagination?: { hasMore: boolean; total: number } }, returned: number): boolean {
	return !!response.pagination?.hasMore || (response.pagination?.total ?? returned) > returned;
}

async function resolvePrecedingDigest(requestContext: RequestContext | undefined): Promise<
	{ digest: string } | { gap: 'missing_channel_capability' | 'message_history_unavailable' | 'preceding_request_not_found' }
> {
	if (!requestContext)
		return { gap: 'missing_channel_capability' };
	const capability = getSendblueChannelCapability(requestContext);
	if (!capability)
		return { gap: 'missing_channel_capability' };

	try {
		const { messages } = await capability.thread.adapter.fetchMessages(capability.thread.id, { limit: HISTORY_LIMIT });
		const operatorMessages = messages.filter(message => message.threadId === capability.thread.id && isOperator(message));
		const currentIndex = operatorMessages.findIndex(message => message.id === capability.message.id);
		const preceding = currentIndex > 0 ? operatorMessages[currentIndex - 1] : undefined;
		return preceding?.id.trim()
			? { digest: hashSendblueMessageHandle(preceding.id) }
			: { gap: 'preceding_request_not_found' };
	} catch {
		return { gap: 'message_history_unavailable' };
	}
}

async function readPrecedingIncident(
	target: Extract<IncidentTarget, { kind: 'preceding_request' }>,
	store: IncidentStore,
	digest: string,
): Promise<IncidentResult> {
	const response = await store.listTracesLight({
		filters: { metadata: { [SENDBLUE_CORRELATION_KEY]: digest } },
		pagination: { page: 0, perPage: QUERY_LIMIT },
		orderBy: { field: 'startedAt', direction: 'ASC' },
	});
	const rows = response.spans as TraceRow[];
	const jamisRows = rows.filter(row => row.spanType === SpanType.AGENT_RUN && componentOf(row) === 'jamis');
	const channelRows = rows.filter(row => !!channelFailure(row));

	if (jamisRows.length > 1 || channelRows.length > 1 || hasMore(response, rows.length)) {
		const conflicting = jamisRows.length > 1 ? jamisRows : [...jamisRows, ...channelRows];
		const inspected = await Promise.all(conflicting.slice(0, RESULT_LIMIT).map(row => inspectCandidate(store, row)));
		return ambiguous(target, inspected.map(result => result.candidate));
	}

	if (jamisRows[0]) {
		const inspected = await inspectCandidate(store, jamisRows[0]);
		if (inspected.failed)
			return found(target, jamisRows[0], inspected, true);
	}
	if (channelRows[0]) {
		const inspected = await inspectCandidate(store, channelRows[0]);
		return found(target, channelRows[0], inspected, true);
	}
	return notFound(target);
}

async function readApplicationIncident(
	target: Extract<IncidentTarget, { kind: 'application' }>,
	store: IncidentStore,
	context: IncidentReaderContext,
	fantasyRuns: RecapRun[] = [],
): Promise<IncidentResult> {
	const filters = { startedAt: { start: target.window.start, end: target.window.end } };
	const traceLimit = QUERY_LIMIT - fantasyRuns.length;
	let rows: TraceRow[];
	let more = false;
	if (target.component === 'sendblue-channel') {
		const response = await store.listTracesLight({
			filters: { ...filters, metadata: { classification: 'failed' } },
			pagination: { page: 0, perPage: traceLimit },
			orderBy: { field: 'startedAt', direction: 'ASC' },
		});
		rows = (response.spans as TraceRow[]).filter(row => row.name === SENDBLUE_CHANNEL_SPAN_NAME && !!channelFailure(row));
		more = hasMore(response, response.spans.length);
	} else if (target.component) {
		const response = await store.listBranches({
			filters: { ...filters, entityId: traceEntityId(target.component), status: TraceStatus.ERROR },
			pagination: { page: 0, perPage: traceLimit },
			orderBy: { field: 'startedAt', direction: 'ASC' },
		});
		rows = response.branches as TraceRow[];
		more = hasMore(response, rows.length);
	} else {
		const failures = await store.listTracesLight({
			filters: { ...filters, status: TraceStatus.ERROR },
			pagination: { page: 0, perPage: traceLimit },
			orderBy: { field: 'startedAt', direction: 'ASC' },
		});
		const remaining = Math.max(0, traceLimit - failures.spans.length);
		const channelFailures = remaining > 0
			? await store.listTracesLight({
					filters: { ...filters, metadata: { classification: 'failed' } },
					pagination: { page: 0, perPage: remaining },
					orderBy: { field: 'startedAt', direction: 'ASC' },
				})
			: undefined;
		const unique = new Map<string, TraceRow>();
		for (const row of failures.spans as TraceRow[])
			unique.set(`${row.traceId}:${row.spanId}`, row);
		for (const row of channelFailures?.spans as TraceRow[] ?? []) {
			if (row.name === SENDBLUE_CHANNEL_SPAN_NAME && channelFailure(row))
				unique.set(`${row.traceId}:${row.spanId}`, row);
		}
		const merged = [...unique.values()].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
		rows = merged.slice(0, traceLimit);
		more = merged.length > traceLimit
			|| hasMore(failures, failures.spans.length)
			|| (!!channelFailures && hasMore(channelFailures, channelFailures.spans.length));
	}
	const sources = [
		...rows.map(row => ({ kind: 'trace' as const, at: row.startedAt, row })),
		...fantasyRuns.map(run => ({ kind: 'fantasy' as const, at: run.updatedAt, run })),
	].sort((a, b) => a.at.getTime() - b.at.getTime());
	if (sources.length === 0)
		return notFound(target);

	if (sources.length > 1 || more) {
		const candidates = await Promise.all(sources.slice(0, RESULT_LIMIT).map(async source => source.kind === 'fantasy'
			? fantasyCandidate(source.run)
			: (await inspectCandidate(store, source.row, target.component)).candidate));
		return ambiguous(target, candidates);
	}

	const source = sources[0]!;
	if (source.kind === 'fantasy')
		return foundFantasyIncident(target, source.run, context, false);
	const inspected = await inspectCandidate(store, source.row, target.component);
	return inspected.failed ? found(target, source.row, inspected, false) : notFound(target);
}

function fantasyWeek(reference: string | undefined): number | undefined {
	const match = reference?.trim().match(/^week\s+([1-9]|1[0-8])$/i);
	return match ? Number(match[1]) : undefined;
}

function fantasyFailureStage(value: unknown): IncidentFailureStage {
	return value === 'scheduled_job' || value === 'model' || value === 'application_storage' || value === 'reply_delivery'
		? value
		: 'unknown';
}

function fantasyFailureClassification(value: unknown): IncidentClassification {
	return value === 'execution_failed' || value === 'execution_interrupted' || value === 'delivery_failed' || value === 'unknown'
		? value
		: 'unknown';
}

function fantasyCandidate(run: RecapRun): IncidentCandidate {
	return {
		component: 'fantasy-weekly-recap',
		occurrenceTimeUtc: run.updatedAt.toISOString(),
		stage: fantasyFailureStage(run.failureStage),
		humanDomainReference: `week ${run.fantasyWeek}`,
	};
}

async function foundFantasyIncident(
	target: Extract<IncidentTarget, { kind: 'application' }>,
	run: RecapRun,
	context: IncidentReaderContext,
	exact: boolean,
): Promise<IncidentResult> {
	const candidate = fantasyCandidate(run);
	const classification = fantasyFailureClassification(run.failureClassification);
	const evidenceGaps: IncidentEvidenceGap[] = candidate.stage === 'unknown' ? ['failure_stage_unknown'] : [];
	let traceReference: { traceId: string; spanId: string } | undefined;
	if (!exact) {
		evidenceGaps.push('trace_identity_not_exact');
	} else if (!run.latestAttemptTraceId) {
		evidenceGaps.push('trace_reference_missing');
	} else {
		try {
			await context.flush();
		} catch {
			evidenceGaps.push('observability_flush_failed');
		}
		if (!evidenceGaps.includes('observability_flush_failed')) {
			let store: IncidentStore | undefined;
			try {
				store = await context.getStore();
			} catch {
				evidenceGaps.push('observability_storage_unavailable');
			}
			if (!store) {
				if (!evidenceGaps.includes('observability_storage_unavailable'))
					evidenceGaps.push('observability_storage_unavailable');
			} else {
				try {
					const structure = await store.getStructure({ traceId: run.latestAttemptTraceId });
					const span = structure?.traceId === run.latestAttemptTraceId
						? (structure.spans as TraceRow[]).find(candidate =>
								candidate.entityId === 'fantasy-weekly-recap'
								&& (candidate.spanType === SpanType.WORKFLOW_RUN || candidate.spanType === SpanType.WORKFLOW_STEP))
						: undefined;
					if (span)
						traceReference = { traceId: run.latestAttemptTraceId, spanId: span.spanId };
					else
						evidenceGaps.push('trace_reference_stale');
				} catch {
					evidenceGaps.push('observability_query_failed');
				}
			}
		}
	}

	const provenDeliveryFailure = candidate.stage === 'reply_delivery' && classification === 'delivery_failed';
	if (!provenDeliveryFailure || !exact)
		evidenceGaps.push('cause_unproven');
	return {
		status: 'found',
		targetKind: 'application',
		incident: {
			...candidate,
			classification,
			scope: 'single_execution',
			impact: run.status === 'delivery_unknown'
				? 'delivery_unconfirmed'
				: provenDeliveryFailure ? 'reply_not_delivered' : 'execution_failed',
			...(provenDeliveryFailure && exact ? { cause: 'reply_delivery_failed' as const } : {}),
			...(traceReference ? { traceReference } : {}),
		},
		evidenceGaps,
	};
}

async function readFantasyIncident(
	target: Extract<IncidentTarget, { kind: 'application' }>,
	context: IncidentReaderContext,
): Promise<IncidentResult> {
	const week = fantasyWeek(target.humanDomainReference);
	if (target.humanDomainReference && week === undefined)
		return unavailable(target, 'unsupported_domain_reference');
	const leagueId = context.fantasyLeagueId ?? getFantasyConfig()?.sleeperLeagueId;
	if (!leagueId)
		return unavailable(target, 'fantasy_configuration_unavailable');

	let runs: RecapRun[];
	try {
		runs = context.readFantasyRuns
			? await context.readFantasyRuns(leagueId, week, target.window.start, target.window.end)
			: week === undefined
				? await listActionableRuns(leagueId, target.window.start, target.window.end, QUERY_LIMIT, getFantasySql())
				: [await getRun(leagueId, week, getFantasySql())].filter((run): run is RecapRun => run !== null);
	} catch {
		return unavailable(target, 'fantasy_storage_unavailable');
	}
	const actionable = runs
		.filter(run => run.status === 'failed' || run.status === 'delivery_unknown')
		.filter(run => week !== undefined || (run.updatedAt >= target.window.start && run.updatedAt <= target.window.end))
		.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
	if (actionable.length === 0)
		return notFound(target);
	if (actionable.length > 1)
		return ambiguous(target, actionable.map(fantasyCandidate));
	return foundFantasyIncident(target, actionable[0]!, context, week !== undefined);
}

export async function readIncident(target: IncidentTarget, context: IncidentReaderContext): Promise<IncidentResult> {
	if (target.kind === 'monitoring_finding')
		return readMonitoringFinding(target, context);
	let fantasyRuns: RecapRun[] = [];
	if (target.kind === 'application') {
		const startMs = target.window.start.getTime();
		const endMs = target.window.end.getTime();
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || endMs - startMs > MAX_WINDOW_MS)
			return unavailable(target, 'invalid_window');
		if (target.component !== undefined && !isIncidentComponent(target.component))
			return unavailable(target, 'unsupported_component');
		if (target.container && target.component !== 'docker')
			return unavailable(target, 'unsupported_component');
		if (target.humanDomainReference && target.component !== 'fantasy-weekly-recap')
			return unavailable(target, 'unsupported_domain_reference');
		if (target.component === 'fantasy-weekly-recap')
			return readFantasyIncident(target, context);
		if (isDeploymentIncidentComponent(target.component))
			return readDeploymentIncident(target as DeploymentIncidentTarget, context);
		if (!target.component && context.readFantasyRuns) {
			const leagueId = context.fantasyLeagueId ?? getFantasyConfig()?.sleeperLeagueId;
			if (leagueId) {
				try {
					fantasyRuns = (await context.readFantasyRuns(leagueId, undefined, target.window.start, target.window.end))
						.filter(run => run.status === 'failed' || run.status === 'delivery_unknown')
						.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
				} catch {
					return unavailable(target, 'fantasy_storage_unavailable');
				}
				if (fantasyRuns.length >= QUERY_LIMIT)
					return ambiguous(target, fantasyRuns.map(fantasyCandidate));
			}
		}
	}

	const preceding = target.kind === 'preceding_request'
		? await resolvePrecedingDigest(context.requestContext)
		: undefined;
	if (preceding && 'gap' in preceding)
		return unavailable(target, preceding.gap);

	try {
		await context.flush();
	} catch {
		return unavailable(target, 'observability_flush_failed');
	}

	let store: IncidentStore | undefined;
	try {
		store = await context.getStore();
	} catch {
		return unavailable(target, 'observability_storage_unavailable');
	}
	if (!store)
		return unavailable(target, 'observability_storage_unavailable');

	try {
		return target.kind === 'preceding_request'
			? await readPrecedingIncident(target, store, preceding && 'digest' in preceding ? preceding.digest : '')
			: await readApplicationIncident(target, store, context, fantasyRuns);
	} catch {
		return unavailable(target, 'observability_query_failed');
	}
}

function needsOperatorTimeZone(input: TriageIncidentInput): boolean {
	return input.kind === 'application'
		&& !!input.window
		&& [input.window.start, input.window.end].some(value => !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value));
}

function targetFromInput(input: TriageIncidentInput, timeZone?: string, nowMs = Date.now()): IncidentTarget {
	if (input.kind === 'preceding_request')
		return { kind: 'preceding_request' };
	if (input.kind === 'monitoring_finding')
		return { kind: 'monitoring_finding', ...(input.finding ? { finding: input.finding } : {}) };
	const endMs = input.window ? dateTimeInstant(input.window.end, timeZone) : nowMs;
	const startMs = input.window ? dateTimeInstant(input.window.start, timeZone) : endMs - DEFAULT_WINDOW_MS;
	return {
		kind: 'application',
		...(input.component ? { component: input.component } : {}),
		...(input.container ? { container: input.container } : {}),
		...(input.humanDomainReference ? { humanDomainReference: input.humanDomainReference } : {}),
		...(input.window ? { explicitWindow: true } : {}),
		window: { start: new Date(startMs), end: new Date(endMs) },
	};
}

export const triageIncidentTool = createTool({
	id: 'triage-incident',
	description: 'Triage one bounded incident from internal evidence: the preceding request, one finding in the accepted Deployment Monitoring reply, or a named component. Broad health, rates, and trends belong to Monitoring.',
	inputSchema: triageIncidentInputSchema,
	outputSchema: incidentResultSchema,
	execute: async (input, context) => {
		let timeZone: string | undefined;
		if (needsOperatorTimeZone(input)) {
			try {
				timeZone = (await resolveOperatorTimeZone(requireOperatorTimeZone())).timeZone;
			} catch {
				const result: IncidentResult = {
					status: 'unavailable',
					targetKind: 'application',
					...(input.kind === 'application' && input.component ? { component: input.component } : {}),
					evidenceGaps: ['operator_time_zone_unavailable'],
				};
				return result;
			}
		}

		return await readIncident(targetFromInput(input, timeZone), {
			requestContext: input.kind !== 'application' && context.agent?.agentId !== 'jamis'
				? undefined
				: context.requestContext,
			flush: async () => {
				if (!context.mastra)
					throw new Error('Observability unavailable');
				await context.mastra.observability.flush();
			},
			getStore: async () => await context.mastra?.getStorage()?.getStore('observability'),
			readDeploymentEvidence: async () => await readFullDeploymentEvidence(
				async () => await context.mastra?.getStorage()?.getStore('observability'),
			),
			readFantasyRuns: async (leagueId, week, start, end) => week === undefined
				? await listActionableRuns(leagueId, start, end, QUERY_LIMIT, getFantasySql())
				: [await getRun(leagueId, week, getFantasySql())].filter((run): run is RecapRun => run !== null),
		});
	},
});
