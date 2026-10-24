import type { AnyExportedSpan, ExportedLog, ExportedMetric } from '@mastra/core/observability';

import { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/di';
import { SpanType, TracingEventType } from '@mastra/core/observability';
import { Observability } from '@mastra/observability';
import { expect, test } from 'bun:test';

import { createProjectLogger, filterProjectTrace, protectProjectSignals, redactChannelRenderContext, spanOutputProcessors } from './observability';

const sendblueCorrelationKey = 'sendblue_message_digest';

test('does not export channel render context', async () => {
	const requestContexts: Array<Record<string, unknown> | undefined> = [];
	const observability = new Observability({
		configs: {
			test: {
				serviceName: 'test',
				exporters: [{
					name: 'discard',
					onTracingEvent: () => {},
					exportTracingEvent: async () => {},
					flush: async () => {},
					shutdown: async () => {},
				}],
				spanOutputProcessors: [redactChannelRenderContext],
				spanFilter(span) {
					requestContexts.push(structuredClone(span.requestContext));
					return false;
				},
			},
		},
	});
	const instance = observability.getInstance('test');

	if (!instance) {
		throw new Error('Missing test observability instance');
	}

	const requestContext = new RequestContext();
	requestContext.setRaw('channel', { platform: 'sendblue' });
	requestContext.setRaw('__mastra_chat_channel_render', { runtimeOnly: true });

	instance.startSpan({
		name: 'test',
		type: SpanType.GENERIC,
		requestContext,
	}).end();

	expect(requestContexts).toEqual([
		{ channel: { platform: 'sendblue' } },
		{ channel: { platform: 'sendblue' } },
	]);
	await instance.shutdown();
});

test('exports only the Sendblue digest as indexed request metadata', async () => {
	const spans: AnyExportedSpan[] = [];
	const observability = new Observability({
		configs: {
			test: {
				serviceName: 'test',
				requestContextKeys: [sendblueCorrelationKey],
				exporters: [{
					name: 'capture',
					onTracingEvent(event) {
						if (event.type === TracingEventType.SPAN_ENDED)
							spans.push(event.exportedSpan);
					},
					exportTracingEvent: async () => {},
					flush: async () => {},
					shutdown: async () => {},
				}],
			},
		},
	});
	const instance = observability.getInstance('test');
	if (!instance)
		throw new Error('Missing test observability instance');

	const correlations = [
		{ digest: 'a'.repeat(64), handle: 'raw-handle-concurrent-a' },
		{ digest: 'b'.repeat(64), handle: 'raw-handle-concurrent-b' },
	];
	await Promise.all(correlations.map(async ({ digest, handle }) => {
		const requestContext = new RequestContext();
		requestContext.setRaw(sendblueCorrelationKey, digest);
		requestContext.setRaw('unindexed', {
			adapterConfig: 'raw-adapter-config',
			operatorNumber: '+15555550101',
			payload: handle,
			text: 'raw-message-text',
		});
		instance.startSpan({
			name: 'request',
			type: SpanType.GENERIC,
			requestContext,
		}).end();
	}));
	await instance.flush();

	expect(new Set(spans.map(span => span.traceId)).size).toBe(2);
	expect(spans.map(span => span.metadata)).toEqual(correlations.map(({ digest }) => ({
		[sendblueCorrelationKey]: digest,
	})));
	expect(JSON.stringify(spans.map(span => span.metadata))).not.toMatch(
		/raw-handle|raw-adapter-config|raw-message-text|15555550101/,
	);
	await instance.shutdown();
});

test('standalone specialist, invocation, and workflow roots protect their first event and signals', async () => {
	const events: Array<{ type: string; span: AnyExportedSpan }> = [];
	const logs: ExportedLog[] = [];
	const metrics: ExportedMetric[] = [];
	const observability = new Observability({ configs: { test: {
		serviceName: 'architecture-proof',
		spanOutputProcessors,
		spanFilter: filterProjectTrace,
		exporters: [protectProjectSignals({
			name: 'capture',
			onTracingEvent: (event) => {
				events.push({
					type: event.type,
					span: structuredClone(event.exportedSpan),
				});
			},
			onLogEvent: (event) => { logs.push(structuredClone(event.log)); },
			onMetricEvent: (event) => { metrics.push(structuredClone(event.metric)); },
			exportTracingEvent: async () => {},
			flush: async () => {},
			shutdown: async () => {},
		})],
	} } });
	// The runtime initializes native signal correlation and logger integration.
	const runtime = new Mastra({ observability, logger: createProjectLogger() });
	const instance = runtime.observability.getInstance('test')!;
	const roots = ['weather-agent', 'research-agent', 'personal-accounts-agent', 'fantasy-agent', 'fantasy-football-pundit', 'fantasy-football-editor', 'fantasy-debug-maintenance', 'invoke_fantasy_pundit', 'invoke_fantasy_editor', 'prepare_fantasy_recap', 'prepare_fantasy_editorial_candidate', 'broadcaster', 'invoke_broadcaster', 'publish_fantasy_recap', 'publish_saved_fantasy_report', 'deliver_saved_report', 'validate_saved_report_delivery_args', 'invoke_weather', 'invoke_research', 'invoke_personal_accounts', 'jamis-input-processor', 'jamis-output-processor', 'prepare_linear_reply', 'await_linear_outcome', 'prepare_linked_reply', 'await_reply_acceptance'];
	try {
		for (const entityId of roots) {
			const requestContext = new RequestContext();
			requestContext.setRaw('private', 'PRIVATE_ARCHITECTURE_SENTINEL');
			const root = instance.startSpan({ name: 'PRIVATE_ARCHITECTURE_SENTINEL', type: SpanType.GENERIC, entityId, input: 'PRIVATE_ARCHITECTURE_SENTINEL', requestContext, metadata: { private: 'PRIVATE_ARCHITECTURE_SENTINEL' } });
			const child = root.createChildSpan({ name: 'PRIVATE_ARCHITECTURE_SENTINEL', type: SpanType.GENERIC, entityId: 'untrusted-child-PRIVATE_ARCHITECTURE_SENTINEL', input: 'PRIVATE_ARCHITECTURE_SENTINEL' });
			instance.getLoggerContext?.(child).error('PRIVATE_ARCHITECTURE_SENTINEL', { private: 'PRIVATE_ARCHITECTURE_SENTINEL' });
			instance.getMetricsContext?.(child).emit('architecture_duration', 1, { status: 'ok', private: 'PRIVATE_ARCHITECTURE_SENTINEL' });
			child.error({ error: new Error('PRIVATE_ARCHITECTURE_SENTINEL'), endSpan: true });
			root.end({ output: 'PRIVATE_ARCHITECTURE_SENTINEL' });
			expect(root.input).toBe('PRIVATE_ARCHITECTURE_SENTINEL');
			expect(root.output).toBe('PRIVATE_ARCHITECTURE_SENTINEL');
		}
		const jamis = instance.startSpan({ name: 'Jamis', type: SpanType.AGENT_RUN, entityId: 'jamis' });
		const contextTool = jamis.createChildSpan({
			name: 'PRIVATE_ARCHITECTURE_SENTINEL',
			type: SpanType.TOOL_CALL,
			entityId: 'conversation_context',
			entityName: 'PRIVATE_ARCHITECTURE_SENTINEL',
			input: 'PRIVATE_ARCHITECTURE_SENTINEL',
			metadata: { private: 'PRIVATE_ARCHITECTURE_SENTINEL' },
		});
		instance.getLoggerContext?.(contextTool).error('PRIVATE_ARCHITECTURE_SENTINEL');
		instance.getMetricsContext?.(contextTool).emit('context_fixture_duration', 1, { private: 'PRIVATE_ARCHITECTURE_SENTINEL' });
		contextTool.end({ output: 'PRIVATE_ARCHITECTURE_SENTINEL' });
		jamis.end();
		await instance.flush();
		expect(events.some(event => event.type === TracingEventType.SPAN_ENDED
			&& event.span.entityId === 'conversation_context' && event.span.entityName === 'conversation_context')).toBe(true);
		expect(logs.some(log => log.correlationContext?.entityId === 'conversation_context')).toBe(true);
		expect(metrics.some(metric => metric.correlationContext?.entityId === 'conversation_context')).toBe(true);
		expect(JSON.stringify({ events, logs, metrics })).not.toContain('PRIVATE_ARCHITECTURE_SENTINEL');
		expect(logs.filter(log => roots.includes(log.correlationContext?.rootEntityId ?? ''))).toHaveLength(roots.length);
		expect(metrics.filter(metric => metric.name === 'architecture_duration')).toHaveLength(roots.length);
		for (const entityId of roots) {
			expect(
				events.some(event => event.type === TracingEventType.SPAN_STARTED && event.span.entityId === entityId),
			).toBe(true);
			expect(logs.some(log => log.correlationContext?.rootEntityId === entityId)).toBe(true);
		}
	} finally { await instance.shutdown(); }
});
