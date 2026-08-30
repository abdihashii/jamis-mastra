import { expect, test } from 'bun:test';

import { RequestContext } from '@mastra/core/di';
import { SpanType } from '@mastra/core/observability';
import { Observability } from '@mastra/observability';

import { redactChannelRenderContext } from './observability';

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
