import type { SpanOutputProcessor } from '@mastra/core/observability';

const channelRenderContextKey = '__mastra_chat_channel_render';
export const CODEX_AUTH_FAILURE_EVENT = 'codex_auth_failure';

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
