import type { AnyExportedSpan } from '@mastra/core/observability';

import { expect, test } from 'bun:test';

import { RequestContext } from '@mastra/core/di';
import { SpanType, TracingEventType } from '@mastra/core/observability';
import { Observability } from '@mastra/observability';

import { redactChannelRenderContext } from './observability';

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
