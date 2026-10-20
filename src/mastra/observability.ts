import type { AnyExportedSpan, AnySpan, CorrelationContext, ExportedLog, ExportedMetric, ObservabilityExporter, SpanOutputProcessor } from '@mastra/core/observability';

import process from 'node:process';

import { ConsoleLogger, LogLevel } from '@mastra/core/logger';
import { resolveCurrentSpan } from '@mastra/core/observability';
import { SensitiveDataFilter } from '@mastra/observability';

import { isView } from './project-cli-contract';

const channelRenderContextKey = '__mastra_chat_channel_render';
export const CODEX_AUTH_FAILURE_EVENT = 'codex_auth_failure';

// Native ConsoleLogger.filter only gates stdout. Decorate before both sinks,
// including children and framework exceptions containing live tracing context.
export function createProjectLogger(logger = new ConsoleLogger({ name: 'Mastra', level: process.env.NODE_ENV === 'production' && process.env.MASTRA_DEV !== 'true' ? LogLevel.WARN : LogLevel.INFO })) {
	for (const level of ['debug', 'info', 'warn', 'error'] as const) {
		const log = logger[level].bind(logger);
		logger[level] = (message, ...args) => {
			if (isProjectSpan(resolveCurrentSpan()) || args.some(isProjectDiagnostic)) {
				const denied = message === 'Tool input validation failed';
				log(denied ? 'Project query input denied' : 'Jamis diagnostic', { status: denied ? 'denied' : level === 'error' ? 'failed' : 'recorded' });
			} else {
				log(message, ...args);
			}
		};
	}
	const trackException = logger.trackException.bind(logger);
	logger.trackException = (error, metadata) => {
		if (isProjectSpan(resolveCurrentSpan()) || isProjectDiagnostic(metadata)) {
			const safe = new Error('Execution failed');
			safe.stack = undefined;
			trackException(safe, { status: 'failed' });
		} else {
			trackException(error, metadata);
		}
	};
	const child = logger.child.bind(logger);
	logger.child = component => createProjectLogger(child(component));
	return logger;
}

// A later tool call cannot retract an already-exported model prompt. Protect the
// Jamis tree and standalone internal entry points from their first event.
const projectTraceKey = '__jamis_project_trace';
const protectedRootEntityIds = [
	'jamis',
	'jamis-input-processor',
	'jamis-output-processor',
	'research-agent',
	'weather-agent',
	'personal-accounts-agent',
	'fantasy-broadcast-agent',
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
	'project-rg',
	'project-jq',
	'projectRg',
	'projectJq',
	'invoke_weather',
	'invoke_research',
	'invoke_personal_accounts',
	'invoke_fantasy_broadcast',
	'prepare_linear_reply',
	'await_linear_outcome',
	'prepare_linked_reply',
	'await_reply_acceptance',
];
// Mastra TOOL_CALL entityIds are registry keys, not createTool ids. Incident
// triage queries these identities, including Jamis's delegated tool failures.
const safeTraceEntityIds = [
	...protectedRootEntityIds,
	'checkMonitoring',
	'conversation_context',
	'currentTime',
	'proposeOperatorTimeZoneChange',
	'triageIncident',
	'gmailSearchTool',
	'calendarEventsTool',
	'linearReadTool',
	'linearCreateProposalTool',
	'webSearch',
	'webScrape',
	'researchSourceDiscover',
	'researchSourceRetrieve',
	'weatherTool',
	'forecastTool',
	'draft_group_message',
	'send_group_message',
];
const markProjectTrace: SpanOutputProcessor = {
	name: 'mark-project-trace',
	process(span) {
		if (!span)
			return span;
		if (!isProjectSpan(span))
			return span;
		span.metadata = { ...span.metadata, [projectTraceKey]: true };
		return span;
	},
	shutdown: async () => {},
};

function isProjectSpan(span?: AnySpan): boolean {
	for (let current = span; current; current = current.parent) {
		if (protectedRootEntityIds.includes(current.entityId ?? '') || ['project.query', 'sendblue.channel'].includes(current.name))
			return true;
	}
	return false;
}

function isProjectDiagnostic(value: unknown): boolean {
	if (!value || typeof value !== 'object')
		return false;
	const data = value as { agent?: string; agentId?: string; workflowId?: string; tool?: string; tracing?: { currentSpan?: AnySpan }; tracingContext?: { currentSpan?: AnySpan } };
	return data.agent === 'Jamis' || [data.agentId, data.workflowId, data.tool].some(id => protectedRootEntityIds.includes(id ?? '')) || isProjectSpan(data.tracing?.currentSpan ?? data.tracingContext?.currentSpan);
}

// Logs/metrics copy live metadata without invoking spanFilter. Replace signal
// snapshots at the native exporter hooks, never the runtime span or its context.
export function protectProjectSignals<T extends ObservabilityExporter>(exporter: T): T {
	const protectedSignal = (signal: ExportedLog | ExportedMetric) => signal.metadata?.[projectTraceKey] || [signal.correlationContext?.entityId, signal.correlationContext?.rootEntityId].some(id => protectedRootEntityIds.includes(id ?? '')) || ('data' in signal && isProjectDiagnostic(signal.data));
	const correlation = (context?: CorrelationContext): CorrelationContext | undefined => context && {
		traceId: context.traceId,
		spanId: context.spanId,
		...(safeTraceEntityIds.includes(context.entityId ?? '') ? { entityId: context.entityId, entityName: context.entityId === 'jamis' ? 'Jamis' : context.entityId, entityType: context.entityType } : {}),
		...(safeTraceEntityIds.includes(context.parentEntityId ?? '') ? { parentEntityId: context.parentEntityId, parentEntityName: context.parentEntityId === 'jamis' ? 'Jamis' : context.parentEntityId, parentEntityType: context.parentEntityType } : {}),
		...(safeTraceEntityIds.includes(context.rootEntityId ?? '') ? { rootEntityId: context.rootEntityId, rootEntityName: context.rootEntityId === 'jamis' ? 'Jamis' : context.rootEntityId, rootEntityType: context.rootEntityType } : {}),
	};
	const metadata = (value?: Record<string, unknown>) => typeof value?.sendblue_message_digest === 'string' && /^[a-f0-9]{64}$/.test(value.sendblue_message_digest) ? { sendblue_message_digest: value.sendblue_message_digest } : {};
	const onLogEvent = exporter.onLogEvent?.bind(exporter);
	if (onLogEvent) {
		exporter.onLogEvent = event => onLogEvent(protectedSignal(event.log)
			? { ...event, log: { ...event.log, message: event.log.message === 'Project query input denied' ? event.log.message : 'Jamis diagnostic', data: undefined, tags: undefined, metadata: metadata(event.log.metadata), correlationContext: correlation(event.log.correlationContext) } }
			: event);
	}
	const onMetricEvent = exporter.onMetricEvent?.bind(exporter);
	if (onMetricEvent) {
		exporter.onMetricEvent = event => onMetricEvent(protectedSignal(event.metric)
			? { ...event, metric: { ...event.metric, labels: ['ok', 'error'].includes(event.metric.labels.status ?? '') ? { status: event.metric.labels.status } : {}, metadata: metadata(event.metric.metadata), correlationContext: correlation(event.metric.correlationContext), costContext: event.metric.costContext && { provider: event.metric.costContext.provider, model: event.metric.costContext.model } } }
			: event);
	}
	return exporter;
}

// Mastra creates this export snapshot after the live processors. Replacing its
// fields preserves runtime inputs, memory thread context and parent metadata.
export function filterProjectTrace(span: AnyExportedSpan) {
	if (!span.metadata?.[projectTraceKey])
		return true;
	const attributes = span.attributes as Record<string, unknown> | undefined;
	const usage = attributes?.usage as Record<string, unknown> | undefined;
	const numeric = (value: Record<string, unknown> | undefined, keys: string[]) => Object.fromEntries(keys.flatMap(key => typeof value?.[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 ? [[key, value[key]]] : []));
	span.attributes = {
		...(typeof attributes?.success === 'boolean' ? { success: attributes.success } : {}),
		...(usage
			? { usage: {
					...numeric(usage, ['inputTokens', 'outputTokens']),
					inputDetails: numeric(usage.inputDetails as Record<string, unknown> | undefined, ['text', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'audio', 'image']),
					outputDetails: numeric(usage.outputDetails as Record<string, unknown> | undefined, ['text', 'reasoning', 'audio', 'image']),
				} }
			: {}),
	};
	const metadata: Record<string, unknown> = {};
	const digest = span.metadata?.sendblue_message_digest;
	if (typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest))
		metadata.sendblue_message_digest = digest;
	if (span.name === 'project.query') {
		const operation = attributes?.operation;
		if (typeof operation === 'string' && ['search', 'files', 'count', 'jq'].includes(operation))
			metadata.operation = operation;
		const result = span.output as Record<string, unknown> | undefined;
		if (result?.ok === true) {
			metadata.status = 'ok';
			if (isView(result.view))
				metadata.view = result.view;
		} else if (result?.ok === false && ['denied', 'missing', 'unavailable', 'invalid', 'limit', 'busy'].includes(String(result.error))) {
			metadata.status = result.error;
		}
	}
	if (span.name === 'sendblue.channel') {
		if (['channel_intake', 'reply_generation', 'reply_delivery'].includes(span.metadata?.stage))
			metadata.stage = span.metadata?.stage;
		if (['accepted', 'delivered', 'failed'].includes(span.metadata?.classification))
			metadata.classification = span.metadata?.classification;
	}
	if (span.name === CODEX_AUTH_FAILURE_EVENT) {
		metadata.reasonCode = span.metadata?.reasonCode;
		metadata.occurredAtUtc = span.metadata?.occurredAtUtc;
	}
	span.metadata = metadata;
	if (!['project.query', 'sendblue.channel', CODEX_AUTH_FAILURE_EVENT].includes(span.name))
		span.name = span.type;
	if (!safeTraceEntityIds.includes(span.entityId ?? '')) {
		delete span.entityId;
		delete span.entityName;
	} else {
		span.entityName = span.entityId === 'jamis' ? 'Jamis' : span.entityId;
	}
	delete span.input;
	delete span.output;
	delete span.requestContext;
	delete span.tags;
	if (span.errorInfo)
		span.errorInfo = { message: 'Execution failed' };
	return true;
}

export const allowlistCodexAuthFailure: SpanOutputProcessor = {
	name: 'allowlist-codex-auth-failure',
	process(span) {
		if (span?.name === CODEX_AUTH_FAILURE_EVENT) {
			span.metadata = {
				reasonCode: span.metadata?.reasonCode,
				occurredAtUtc: span.metadata?.occurredAtUtc,
			};
			delete span.requestContext;
		}
		return span;
	},
	shutdown: async () => {},
};

export const redactChannelRenderContext: SpanOutputProcessor = {
	name: 'redact-channel-render-context',
	process(span) {
		if (span?.requestContext) {
			delete span.requestContext[channelRenderContextKey];
		}

		return span;
	},
	shutdown: async () => {},
};

export const spanOutputProcessors = [redactChannelRenderContext, allowlistCodexAuthFailure, markProjectTrace, new SensitiveDataFilter()];
