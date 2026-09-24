import type { ObservabilityStorage, WorkflowsStorage } from '@mastra/core/storage';
import type { FantasyMonitoringRun } from '../../fantasy/runs';
import type { readFullDeploymentEvidence } from './deployment-evidence';

import { SpanType } from '@mastra/core/observability';
import { TraceStatus } from '@mastra/core/storage';
import { z } from 'zod';

const subject = z.enum(['operator_conversation', 'fantasy_recaps', 'host', 'docker', 'app', 'postgres', 'clickhouse', 'cloudflare_tunnel', 'tailscale']);
const boundary = z.enum(['current', 'current_instance', 'current_and_recent_5m', 'recent_history', 'configured_fantasy_season']);
const fact = z.enum([
	'intake_accepted_reply_pending',
	'reply_accepted',
	'recap_sent',
	'recap_noop',
	'recap_execution_failed',
	'host_observed',
	'docker_observed',
	'app_observed',
	'postgres_observed',
	'clickhouse_observed',
	'tunnel_observed',
	'tailscale_observed',
	'intake_failed',
	'reply_acceptance_failed',
	'top_level_execution_failed',
	'recap_failed',
	'recap_delivery_unknown',
	'recap_expired_active',
	'container_not_running',
	'tunnel_local_error',
	'tailscale_not_running',
]);
const gap = z.enum([
	'channel_history_unavailable',
	'application_history_unavailable',
	'history_truncated',
	'handset_delivery_unverified',
	'reply_status_unverified',
	'fantasy_not_configured',
	'fantasy_runs_unavailable',
	'fantasy_execution_unverified',
	'fantasy_row_invalid',
	'host_probe_unavailable',
	'docker_probe_unavailable',
	'container_state_unavailable',
	'tunnel_probe_unavailable',
	'tailscale_probe_unavailable',
	'postgres_query_unavailable',
	'clickhouse_query_unavailable',
	'component_evidence_unavailable',
	'stale_evidence',
	'external_reachability_unverified',
	'operator_device_reachability_unverified',
	'service_functionality_unverified',
	'recent_host_events_unavailable',
	'recent_tunnel_diagnostics_unavailable',
	'no_recent_traces',
	'no_fantasy_runs',
]);
const utc = z.iso.datetime({ offset: true });
const item = z.object({
	subject,
	fact,
	boundary,
	at: utc.optional(),
	week: z.number().int().min(1).max(18).optional(),
	container: z.enum(['app', 'postgres', 'clickhouse', 'cloudflared']).optional(),
}).strict();
const unknown = z.object({ subject, gap, boundary, container: z.enum(['app', 'postgres', 'clickhouse', 'cloudflared']).optional() }).strict();
const counts = z.object({
	sent: z.number().int().min(0).max(18),
	failed: z.number().int().min(0).max(18),
	deliveryUnknown: z.number().int().min(0).max(18),
	active: z.number().int().min(0).max(18),
	expiredActive: z.number().int().min(0).max(18),
}).strict();

export const deploymentMonitoringOutputSchema = z.object({
	scope: z.literal('deployment'),
	observedAt: utc,
	historyWindow: z.object({ start: utc, end: utc }).strict(),
	tunnelWindow: z.object({ start: utc, end: utc }).strict(),
	serviceOutcomes: z.tuple([
		z.object({
			service: z.literal('operator_conversation'),
			boundary: z.literal('recent_history'),
			currentRequest: z.enum(['intake_accepted_reply_pending', 'not_observed']),
			historicalActivity: z.enum(['requests_observed', 'no_recent_activity', 'unavailable']),
			completedHistoricalRequests: z.number().int().min(0).max(100).nullable(),
			replyAccepted: z.number().int().min(0).max(100).nullable(),
			replyFailed: z.number().int().min(0).max(100).nullable(),
			intakeFailed: z.number().int().min(0).max(100).nullable(),
			topLevelExecutionFailed: z.number().int().min(0).max(100).nullable(),
			topLevelExecutionSucceeded: z.number().int().min(0).max(100).nullable(),
			handsetDelivery: z.literal('unverified'),
		}).strict(),
		z.object({
			service: z.literal('fantasy_recaps'),
			boundary: z.literal('configured_fantasy_season'),
			counts: counts.nullable(),
		}).strict(),
	]),
	needsAttention: z.array(item).max(250),
	operatingNormally: z.array(item).max(250),
	recentRecoveredEvents: z.tuple([]),
	unknowns: z.array(unknown).max(100),
	components: z.array(z.object({
		component: z.enum(['host', 'docker', 'app', 'postgres', 'clickhouse', 'cloudflare_tunnel', 'tailscale']),
		assessment: z.enum(['needs_attention', 'operating_normally', 'unknown']),
		boundary,
		gaps: z.array(gap),
	}).strict()).length(7),
}).strict();

export type DeploymentMonitoringSummary = z.infer<typeof deploymentMonitoringOutputSchema>;
type Item = DeploymentMonitoringSummary['needsAttention'][number];
type Unknown = DeploymentMonitoringSummary['unknowns'][number];
type Evidence = Awaited<ReturnType<typeof readFullDeploymentEvidence>>;
type TraceStore = Pick<ObservabilityStorage, 'listTracesLight'>;
type WorkflowStore = Pick<WorkflowsStorage, 'listWorkflowRuns'>;

export interface DeploymentMonitoringSources {
	getStore: () => Promise<TraceStore | undefined>;
	getWorkflowStore: () => Promise<WorkflowStore | undefined>;
	readFantasyRuns: () => Promise<FantasyMonitoringRun[] | null>;
	readEvidence: (hours: number, nowMs: number) => Promise<Evidence>;
	currentDigest?: string;
}

const componentOrder = ['host', 'docker', 'app', 'postgres', 'clickhouse', 'cloudflare_tunnel', 'tailscale'] as const;

function limited<T>(read: () => Promise<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('reader unavailable')), 3_000);
		Promise.resolve().then(read).then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				reject(new Error('reader unavailable'));
			},
		);
	});
}

export async function readDeploymentMonitoring(sources: DeploymentMonitoringSources, hours = 24, nowMs = Date.now()): Promise<DeploymentMonitoringSummary> {
	const start = new Date(nowMs - hours * 3_600_000);
	const end = new Date(nowMs);
	const needsAttention: Item[] = [];
	const operatingNormally: Item[] = [];
	const unknowns: Unknown[] = [];
	const add = (target: Item[], subject: Item['subject'], fact: Item['fact'], boundary: Item['boundary'], at?: Date | string, week?: number, container?: Item['container']) => {
		const timestamp = at instanceof Date ? at : at ? new Date(at) : undefined;
		target.push({ subject, fact, boundary, ...(timestamp && Number.isFinite(timestamp.getTime()) ? { at: timestamp.toISOString() } : {}), ...(week ? { week } : {}), ...(container ? { container } : {}) });
	};
	const missing = (subject: Unknown['subject'], gap: Unknown['gap'], boundary: Unknown['boundary'], container?: Unknown['container']) => {
		if (!unknowns.some(item => item.subject === subject && item.gap === gap && item.boundary === boundary && item.container === container))
			unknowns.push({ subject, gap, boundary, ...(container ? { container } : {}) });
	};

	const [evidenceResult, fantasyResult, workflowResult, storeResult] = await Promise.allSettled([
		sources.readEvidence(hours, nowMs),
		limited(sources.readFantasyRuns),
		limited(sources.getWorkflowStore),
		limited(sources.getStore),
	]);
	const evidence = evidenceResult.status === 'fulfilled' ? evidenceResult.value : undefined;
	const fantasyRuns = fantasyResult.status === 'fulfilled' ? fantasyResult.value : null;
	const store = storeResult.status === 'fulfilled' ? storeResult.value : undefined;

	let completedHistoricalRequests: number | null = null;
	let replyAccepted: number | null = null;
	let replyFailed: number | null = null;
	let intakeFailed: number | null = null;
	let topLevelExecutionFailed: number | null = null;
	let topLevelExecutionSucceeded: number | null = null;
	let historicalActivity: 'requests_observed' | 'no_recent_activity' | 'unavailable' = 'unavailable';
	if (store) {
		const filters = { startedAt: { start, end } };
		const [channelResult, agentResult] = await Promise.allSettled([
			limited(() => store.listTracesLight({ filters: { ...filters, spanType: SpanType.GENERIC }, pagination: { page: 0, perPage: 100 }, orderBy: { field: 'startedAt', direction: 'DESC' } })),
			limited(() => store.listTracesLight({ filters: { ...filters, spanType: SpanType.AGENT_RUN, entityId: 'jamis' }, pagination: { page: 0, perPage: 100 }, orderBy: { field: 'startedAt', direction: 'DESC' } })),
		]);
		if (channelResult.status === 'fulfilled') {
			const response = channelResult.value;
			const rows = response.spans.filter(row => row.name === 'sendblue.channel'
				&& (!sources.currentDigest || row.metadata?.sendblue_message_digest !== sources.currentDigest));
			historicalActivity = rows.length ? 'requests_observed' : response.pagination?.hasMore ? 'unavailable' : 'no_recent_activity';
			const completed = rows.filter(row => row.metadata?.stage === 'reply_delivery'
				&& (row.metadata.classification === 'delivered' || row.metadata.classification === 'failed'));
			const intakeFailures = rows.filter(row => row.metadata?.stage === 'channel_intake' && row.metadata.classification === 'failed');
			completedHistoricalRequests = completed.length;
			replyAccepted = completed.filter(row => row.metadata?.stage === 'reply_delivery' && row.metadata.classification === 'delivered').length;
			replyFailed = completed.filter(row => row.metadata?.stage === 'reply_delivery' && row.metadata.classification === 'failed').length;
			intakeFailed = intakeFailures.length;
			for (const row of completed) {
				if (row.metadata?.stage === 'reply_delivery' && row.metadata.classification === 'failed')
					add(needsAttention, 'operator_conversation', 'reply_acceptance_failed', 'recent_history', row.endedAt ?? row.startedAt);
			}
			for (const row of intakeFailures)
				add(needsAttention, 'operator_conversation', 'intake_failed', 'recent_history', row.endedAt ?? row.startedAt);
			if (replyAccepted > 0)
				add(operatingNormally, 'operator_conversation', 'reply_accepted', 'recent_history');
			if (rows.some(row => row.metadata?.stage === 'channel_intake' && row.metadata.classification === 'accepted'))
				missing('operator_conversation', 'reply_status_unverified', 'recent_history');
			if (response.pagination?.hasMore || (!response.pagination && response.spans.length === 100))
				missing('operator_conversation', 'history_truncated', 'recent_history');
		}
		else {
			missing('operator_conversation', 'channel_history_unavailable', 'recent_history');
		}
		if (agentResult.status === 'fulfilled') {
			const response = agentResult.value;
			const correlated = response.spans.filter(row => row.spanType === SpanType.AGENT_RUN && row.entityId === 'jamis'
				&& row.metadata?.sendblue_message_digest !== sources.currentDigest
				&& typeof row.metadata?.sendblue_message_digest === 'string');
			if (correlated.length && historicalActivity === 'no_recent_activity') {
				historicalActivity = 'requests_observed';
				missing('operator_conversation', 'reply_status_unverified', 'recent_history');
			}
			const failed = correlated.filter(row => row.status === TraceStatus.ERROR);
			topLevelExecutionFailed = failed.length;
			topLevelExecutionSucceeded = correlated.filter(row => row.status === TraceStatus.SUCCESS).length;
			for (const row of failed)
				add(needsAttention, 'operator_conversation', 'top_level_execution_failed', 'recent_history', row.endedAt ?? row.startedAt);
			if (response.pagination?.hasMore || (!response.pagination && response.spans.length === 100))
				missing('operator_conversation', 'history_truncated', 'recent_history');
		}
		else {
			missing('operator_conversation', 'application_history_unavailable', 'recent_history');
		}
	}
	else {
		missing('operator_conversation', 'channel_history_unavailable', 'recent_history');
		missing('operator_conversation', 'application_history_unavailable', 'recent_history');
	}
	if (sources.currentDigest)
		add(operatingNormally, 'operator_conversation', 'intake_accepted_reply_pending', 'recent_history');
	missing('operator_conversation', 'handset_delivery_unverified', 'recent_history');

	let fantasyCounts: DeploymentMonitoringSummary['serviceOutcomes'][1]['counts'] = null;
	if (fantasyRuns && fantasyRuns.length <= 18 && new Set(fantasyRuns.map(run => run.fantasyWeek)).size === fantasyRuns.length
		&& fantasyRuns.every(run => Number.isInteger(run.fantasyWeek) && run.fantasyWeek >= 1 && run.fantasyWeek <= 18
			&& run.updatedAt instanceof Date && Number.isFinite(run.updatedAt.getTime())
			&& ['sent', 'failed', 'delivery_unknown', 'started'].includes(run.status))) {
		fantasyCounts = { sent: 0, failed: 0, deliveryUnknown: 0, active: 0, expiredActive: 0 };
		for (const run of fantasyRuns) {
			if (run.status === 'sent') {
				fantasyCounts.sent++;
				add(operatingNormally, 'fantasy_recaps', 'recap_sent', 'configured_fantasy_season', run.sentAt ?? run.updatedAt, run.fantasyWeek);
			}
			else if (run.status === 'failed') {
				fantasyCounts.failed++;
				add(needsAttention, 'fantasy_recaps', 'recap_failed', 'configured_fantasy_season', run.updatedAt, run.fantasyWeek);
			}
			else if (run.status === 'delivery_unknown') {
				fantasyCounts.deliveryUnknown++;
				add(needsAttention, 'fantasy_recaps', 'recap_delivery_unknown', 'configured_fantasy_season', run.updatedAt, run.fantasyWeek);
			}
			else if (run.status === 'started' && run.leaseExpiresAt instanceof Date && run.leaseExpiresAt.getTime() < nowMs) {
				fantasyCounts.expiredActive++;
				add(needsAttention, 'fantasy_recaps', 'recap_expired_active', 'configured_fantasy_season', run.leaseExpiresAt, run.fantasyWeek);
			}
			else if (run.status === 'started') {
				fantasyCounts.active++;
			}
		}
		if (fantasyRuns.length === 0)
			missing('fantasy_recaps', 'no_fantasy_runs', 'configured_fantasy_season');
	}
	else {
		missing('fantasy_recaps', fantasyRuns ? 'fantasy_row_invalid' : fantasyResult.status === 'fulfilled' ? 'fantasy_not_configured' : 'fantasy_runs_unavailable', 'configured_fantasy_season');
	}

	if (workflowResult.status === 'fulfilled' && workflowResult.value) {
		try {
			const workflowStore = workflowResult.value;
			const { runs, total } = await limited(() => workflowStore.listWorkflowRuns({ workflowName: 'fantasy-weekly-recap', fromDate: start, toDate: end, perPage: 10, page: 0 }));
			if (total > runs.length)
				missing('fantasy_recaps', 'history_truncated', 'recent_history');
			let noop = false;
			let observed = false;
			for (const run of runs) {
				try {
					const snapshot: unknown = typeof run.snapshot === 'string' ? JSON.parse(run.snapshot) : run.snapshot;
					const parsed = z.object({
						status: z.literal('success'),
						result: z.object({ status: z.literal('success'), output: z.object({ outcome: z.enum([
							'noop-already-sent',
							'noop-no-completed-week',
							'skipped-unconfigured',
							'error',
							'sent',
							'failed',
							'delivery_unknown',
							'blocked-active-claim',
							'blocked-delivery-unknown',
						]) }) }),
					}).safeParse(snapshot);
					if (!parsed.success)
						continue;
					observed = true;
					const outcome = parsed.data.result.output.outcome;
					if (outcome === 'noop-already-sent' || outcome === 'noop-no-completed-week')
						noop = true;
					if (outcome === 'error')
						add(needsAttention, 'fantasy_recaps', 'recap_execution_failed', 'recent_history', run.updatedAt);
				}
				catch { /* malformed stored output does not hide another run */ }
			}
			if (noop)
				add(operatingNormally, 'fantasy_recaps', 'recap_noop', 'recent_history');
			if (!observed)
				missing('fantasy_recaps', 'fantasy_execution_unverified', 'recent_history');
		}
		catch {
			missing('fantasy_recaps', 'fantasy_execution_unverified', 'recent_history');
		}
	}
	else {
		missing('fantasy_recaps', 'fantasy_execution_unverified', 'recent_history');
	}

	for (const component of componentOrder) {
		const current = evidence?.[component === 'cloudflare_tunnel' ? 'cloudflareTunnel' : component];
		const sourceBoundary = component === 'app' ? 'current_instance' : component === 'cloudflare_tunnel' ? 'current_and_recent_5m' : component === 'postgres' ? 'configured_fantasy_season' : component === 'clickhouse' ? 'recent_history' : 'current';
		if (!current || current.availability === 'unavailable' || current.freshness !== 'fresh') {
			missing(component, !current ? 'component_evidence_unavailable' : current.freshness === 'stale' ? 'stale_evidence' : component === 'host' ? 'host_probe_unavailable' : component === 'docker' ? 'docker_probe_unavailable' : component === 'postgres' ? 'postgres_query_unavailable' : component === 'clickhouse' ? 'clickhouse_query_unavailable' : component === 'cloudflare_tunnel' ? 'tunnel_probe_unavailable' : 'tailscale_probe_unavailable', sourceBoundary);
			continue;
		}
		if (component === 'docker' && evidence) {
			for (const container of evidence.docker.containers) {
				if (container.state === 'unknown')
					missing(component, 'container_state_unavailable', sourceBoundary, container.component);
				else if (container.state !== 'running')
					add(needsAttention, component, 'container_not_running', sourceBoundary, current.observedAt, undefined, container.component);
			}
			if (evidence.docker.containers.every(container => container.state === 'running'))
				add(operatingNormally, component, 'docker_observed', sourceBoundary, current.observedAt);
		}
		else if (component === 'cloudflare_tunnel' && evidence) {
			if (evidence.cloudflareTunnel.recentDiagnostic === 'local_error')
				add(needsAttention, component, 'tunnel_local_error', sourceBoundary, current.observedAt);
			if (evidence.cloudflareTunnel.containerState === 'unknown')
				missing(component, 'container_state_unavailable', sourceBoundary, 'cloudflared');
			else if (evidence.cloudflareTunnel.containerState !== 'running')
				add(needsAttention, component, 'container_not_running', sourceBoundary, current.observedAt, undefined, 'cloudflared');
			else if (evidence.cloudflareTunnel.recentDiagnostic !== 'local_error')
				add(operatingNormally, component, 'tunnel_observed', sourceBoundary, current.observedAt);
		}
		else if (component === 'tailscale' && evidence) {
			const failed = (evidence.tailscale.serviceState !== 'active' && evidence.tailscale.serviceState !== 'unknown')
				|| (evidence.tailscale.backendState !== 'Running' && evidence.tailscale.backendState !== 'unknown');
			const unverified = evidence.tailscale.serviceState === 'unknown' || evidence.tailscale.backendState === 'unknown';
			if (failed)
				add(needsAttention, component, 'tailscale_not_running', sourceBoundary, current.observedAt);
			if (unverified)
				missing(component, 'component_evidence_unavailable', sourceBoundary);
			if (!failed && !unverified)
				add(operatingNormally, component, 'tailscale_observed', sourceBoundary, current.observedAt);
		}
		else {
			add(operatingNormally, component, component === 'cloudflare_tunnel' ? 'tunnel_observed' : `${component}_observed` as Item['fact'], sourceBoundary, current.observedAt);
		}
		if (component === 'host') {
			missing(component, 'external_reachability_unverified', sourceBoundary);
			missing(component, 'recent_host_events_unavailable', sourceBoundary);
		}
		else if (component === 'docker') {
			missing(component, 'service_functionality_unverified', sourceBoundary);
		}
		else if (component === 'cloudflare_tunnel') {
			missing(component, 'external_reachability_unverified', sourceBoundary);
			if (evidence?.cloudflareTunnel.recentDiagnostic === 'unknown')
				missing(component, 'recent_tunnel_diagnostics_unavailable', sourceBoundary);
		}
		else if (component === 'tailscale') {
			missing(component, 'operator_device_reachability_unverified', sourceBoundary);
		}
		else if (component === 'clickhouse' && evidence?.clickhouse.gaps.includes('no_recent_traces')) {
			missing(component, 'no_recent_traces', sourceBoundary);
		}
	}

	return deploymentMonitoringOutputSchema.parse({
		scope: 'deployment',
		observedAt: end.toISOString(),
		historyWindow: { start: start.toISOString(), end: end.toISOString() },
		tunnelWindow: { start: new Date(nowMs - 5 * 60_000).toISOString(), end: end.toISOString() },
		serviceOutcomes: [
			{ service: 'operator_conversation', boundary: 'recent_history', currentRequest: sources.currentDigest ? 'intake_accepted_reply_pending' : 'not_observed', historicalActivity, completedHistoricalRequests, replyAccepted, replyFailed, intakeFailed, topLevelExecutionFailed, topLevelExecutionSucceeded, handsetDelivery: 'unverified' },
			{ service: 'fantasy_recaps', boundary: 'configured_fantasy_season', counts: fantasyCounts },
		],
		needsAttention,
		operatingNormally,
		recentRecoveredEvents: [],
		unknowns,
		components: componentOrder.map((component) => {
			const finding = needsAttention.find(item => item.subject === component);
			const normal = operatingNormally.find(item => item.subject === component);
			return {
				component,
				assessment: finding ? 'needs_attention' : normal ? 'operating_normally' : 'unknown',
				boundary: finding?.boundary ?? normal?.boundary ?? unknowns.find(item => item.subject === component)?.boundary ?? 'current',
				gaps: unknowns.filter(item => item.subject === component).map(item => item.gap),
			};
		}),
	});
}
