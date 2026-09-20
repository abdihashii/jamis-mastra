import type { RequestContext } from '@mastra/core/request-context';
import type { GetStructureResponse, ObservabilityStorage } from '@mastra/core/storage';

import { SpanType } from '@mastra/core/observability';
import { extractBranchSpans, TraceStatus } from '@mastra/core/storage';

import {
	getSendblueChannelCapability,
	hashSendblueMessageHandle,
	isOperator,
	SENDBLUE_CHANNEL_SPAN_NAME,
	SENDBLUE_CORRELATION_KEY,
} from '../channels/sendblue';

const QUERY_LIMIT = 6;
const RESULT_LIMIT = 5;
const HISTORY_LIMIT = 50;
const MAX_WINDOW_MS = 168 * 60 * 60 * 1000;

const incidentComponents = [
	'sendblue-channel',
	'jamis',
	'fantasy-agent',
	'research-agent',
	'weather-agent',
	'personal-accounts-agent',
	'fantasy-broadcast-agent',
	'fantasy-weekly-recap',
	'check-monitoring',
	'current-time',
	'propose-operator-time-zone-change',
	'calendar-events',
	'gmail-search',
	'firecrawl-search',
	'firecrawl-scrape',
	'weather-tool',
	'forecast-tool',
	'draft_group_message',
	'send_group_message',
] as const;

export type IncidentComponent = typeof incidentComponents[number];
export type IncidentFailureStage
	= | 'channel_intake'
		| 'agent'
		| 'model'
		| 'tool'
		| 'workflow'
		| 'scheduled_job'
		| 'application_storage'
		| 'reply_delivery'
		| 'unknown';
export type IncidentClassification = 'intake_failed' | 'execution_failed' | 'delivery_failed' | 'unknown';
export type IncidentEvidenceGap
	= | 'invalid_window'
		| 'unsupported_component'
		| 'missing_channel_capability'
		| 'message_history_unavailable'
		| 'preceding_request_not_found'
		| 'observability_flush_failed'
		| 'observability_storage_unavailable'
		| 'observability_query_failed'
		| 'trace_structure_unavailable'
		| 'failure_stage_unknown'
		| 'trace_identity_not_exact'
		| 'cause_unproven'
		| 'no_matching_incident'
		| 'multiple_matching_incidents';

export type IncidentTarget
	= | { kind: 'preceding_request' }
		| {
			kind: 'application';
			component?: IncidentComponent;
			window: { start: Date; end: Date };
		};

export interface IncidentCandidate {
	component: IncidentComponent | 'unknown';
	occurrenceTimeUtc: string;
	stage: IncidentFailureStage;
}

export type IncidentResult
	= | {
		status: 'found';
		targetKind: IncidentTarget['kind'];
		incident: IncidentCandidate & {
			classification: IncidentClassification;
			scope: 'single_request' | 'single_execution';
			impact: 'request_failed' | 'execution_failed' | 'execution_degraded' | 'reply_not_delivered';
			cause?: 'reply_delivery_failed';
			traceReference?: { traceId: string; spanId: string };
		};
		evidenceGaps: IncidentEvidenceGap[];
	}
	| {
		status: 'ambiguous';
		targetKind: IncidentTarget['kind'];
		candidates: IncidentCandidate[];
		evidenceGaps: ['multiple_matching_incidents'];
	}
	| {
		status: 'not_found' | 'unavailable';
		targetKind: IncidentTarget['kind'];
		component?: IncidentComponent;
		evidenceGaps: IncidentEvidenceGap[];
	};

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
}

function isIncidentComponent(value: unknown): value is IncidentComponent {
	return typeof value === 'string' && (incidentComponents as readonly string[]).includes(value);
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

function channelFailure(row: TraceRow): 'channel_intake' | 'reply_delivery' | undefined {
	if (row.name !== SENDBLUE_CHANNEL_SPAN_NAME || row.metadata?.classification !== 'failed')
		return;
	if (row.metadata.stage === 'channel_intake')
		return 'channel_intake';
	if (row.metadata.stage === 'reply_delivery')
		return 'reply_delivery';
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

async function inspectCandidate(
	store: IncidentStore,
	row: TraceRow,
	expectedComponent?: IncidentComponent,
): Promise<{ anchorFailed: boolean; candidate: IncidentCandidate; failed: boolean; gaps: IncidentEvidenceGap[] }> {
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
		failed: !!failure || anchorFailed,
		gaps,
	};
}

function unavailable(target: IncidentTarget, gap: IncidentEvidenceGap): IncidentResult {
	return {
		status: 'unavailable',
		targetKind: target.kind,
		...(target.kind === 'application' && isIncidentComponent(target.component) ? { component: target.component } : {}),
		evidenceGaps: [gap],
	};
}

function notFound(target: IncidentTarget): IncidentResult {
	return {
		status: 'not_found',
		targetKind: target.kind,
		...(target.kind === 'application' && target.component ? { component: target.component } : {}),
		evidenceGaps: ['no_matching_incident'],
	};
}

function ambiguous(target: IncidentTarget, candidates: IncidentCandidate[]): IncidentResult {
	return {
		status: 'ambiguous',
		targetKind: target.kind,
		candidates: candidates.slice(0, RESULT_LIMIT),
		evidenceGaps: ['multiple_matching_incidents'],
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
	return {
		status: 'found',
		targetKind: target.kind,
		incident: {
			...candidate,
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
			...(delivery && exact ? { cause: 'reply_delivery_failed' as const } : {}),
			...(exact ? { traceReference: { traceId: row.traceId, spanId: row.spanId } } : {}),
		},
		evidenceGaps: [
			...gaps,
			...exact ? [] : ['trace_identity_not_exact' as const],
			...delivery && exact ? [] : ['cause_unproven' as const],
		],
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
	}
	catch {
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
): Promise<IncidentResult> {
	const filters = { startedAt: { start: target.window.start, end: target.window.end } };
	let rows: TraceRow[];
	let more = false;
	if (target.component === 'sendblue-channel') {
		const response = await store.listTracesLight({
			filters: { ...filters, metadata: { classification: 'failed' } },
			pagination: { page: 0, perPage: QUERY_LIMIT },
			orderBy: { field: 'startedAt', direction: 'ASC' },
		});
		rows = (response.spans as TraceRow[]).filter(row => row.name === SENDBLUE_CHANNEL_SPAN_NAME && !!channelFailure(row));
		more = hasMore(response, response.spans.length);
	}
	else if (target.component) {
		const response = await store.listBranches({
			filters: { ...filters, entityId: target.component, status: TraceStatus.ERROR },
			pagination: { page: 0, perPage: QUERY_LIMIT },
			orderBy: { field: 'startedAt', direction: 'ASC' },
		});
		rows = response.branches as TraceRow[];
		more = hasMore(response, rows.length);
	}
	else {
		const failures = await store.listTracesLight({
			filters: { ...filters, status: TraceStatus.ERROR },
			pagination: { page: 0, perPage: QUERY_LIMIT },
			orderBy: { field: 'startedAt', direction: 'ASC' },
		});
		const remaining = Math.max(0, QUERY_LIMIT - failures.spans.length);
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
		rows = merged.slice(0, QUERY_LIMIT);
		more = merged.length > QUERY_LIMIT
			|| hasMore(failures, failures.spans.length)
			|| (!!channelFailures && hasMore(channelFailures, channelFailures.spans.length));
	}
	const selected = rows;
	if (selected.length === 0)
		return notFound(target);

	if (selected.length > 1 || more) {
		const inspected = await Promise.all(selected.slice(0, RESULT_LIMIT).map(row => inspectCandidate(store, row, target.component)));
		return ambiguous(target, inspected.map(result => result.candidate));
	}

	const inspected = await inspectCandidate(store, selected[0]!, target.component);
	return inspected.failed ? found(target, selected[0]!, inspected, false) : notFound(target);
}

export async function readIncident(target: IncidentTarget, context: IncidentReaderContext): Promise<IncidentResult> {
	if (target.kind === 'application') {
		const startMs = target.window.start.getTime();
		const endMs = target.window.end.getTime();
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || endMs - startMs > MAX_WINDOW_MS)
			return unavailable(target, 'invalid_window');
		if (target.component !== undefined && !isIncidentComponent(target.component))
			return unavailable(target, 'unsupported_component');
	}

	const preceding = target.kind === 'preceding_request'
		? await resolvePrecedingDigest(context.requestContext)
		: undefined;
	if (preceding && 'gap' in preceding)
		return unavailable(target, preceding.gap);

	try {
		await context.flush();
	}
	catch {
		return unavailable(target, 'observability_flush_failed');
	}

	let store: IncidentStore | undefined;
	try {
		store = await context.getStore();
	}
	catch {
		return unavailable(target, 'observability_storage_unavailable');
	}
	if (!store)
		return unavailable(target, 'observability_storage_unavailable');

	try {
		return target.kind === 'preceding_request'
			? await readPrecedingIncident(target, store, preceding && 'digest' in preceding ? preceding.digest : '')
			: await readApplicationIncident(target, store);
	}
	catch {
		return unavailable(target, 'observability_query_failed');
	}
}
