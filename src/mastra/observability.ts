import type { SpanOutputProcessor } from '@mastra/core/observability';

const channelRenderContextKey = '__mastra_chat_channel_render';

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
