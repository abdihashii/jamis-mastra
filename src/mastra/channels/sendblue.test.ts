import { describe, expect, test } from 'bun:test';

import { MODEL_AUTH_FAILURE } from '../gateways/openai-codex-auth.js';

process.env.JAMIS_ALLOWED_NUMBER = '+15555550101';
process.env.SENDBLUE_API_KEY = 'test-api-key';
process.env.SENDBLUE_API_SECRET = 'test-api-secret';
process.env.SENDBLUE_FROM_NUMBER = '+15555550100';
process.env.SENDBLUE_WEBHOOK_SECRET = 'test-webhook-secret';

const {
	CODEX_AUTH_CHANNEL_ERROR,
	formatSendblueError,
	GENERIC_CHANNEL_ERROR,
} = await import('./sendblue.js');

describe('Sendblue error formatting', () => {
	test('renders the model-auth sentinel as an actionable message', () => {
		const error = new Error(`wrapped: ${MODEL_AUTH_FAILURE} raw-provider-text test-access-token test-refresh-token`);

		expect(formatSendblueError(error)).toBe(CODEX_AUTH_CHANNEL_ERROR);
		expect(formatSendblueError(error)).not.toMatch(/raw-provider-text|access-token|refresh-token/);
	});

	test('hides every other error', () => {
		expect(formatSendblueError(new Error('provider response contained a credential'))).toBe(GENERIC_CHANNEL_ERROR);
	});
});
