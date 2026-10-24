import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
/**
 * Gateway smoke: one real generation through the openai-codex gateway, with
 * no agent flips and no server. Proves the full resolution path live:
 * model router claims `openai-codex/gpt-5.6-terra` -> resolveAuth ->
 * createOpenAI Responses model -> codexFetch -> chatgpt.com backend.
 *
 * Usage: bun scripts/openai-codex-gateway-smoke.ts
 */
import process from 'node:process';

import { openAICodexGateway } from '../src/mastra/gateways/openai-codex-gateway.js';

const smoke = new Agent({
	id: 'codex-gateway-smoke',
	name: 'codex-gateway-smoke',
	instructions: 'You are a smoke test. Reply with exactly one word: ok',
	model: 'openai-codex/gpt-5.6-terra',
});

const mastra = new Mastra({
	agents: { smoke },
	gateways: { 'openai-codex': openAICodexGateway },
});

const result = await mastra.getAgent('smoke').generate('Reply with exactly one word: ok');

if (!result.text || !/\bok\b/i.test(result.text)) {
	console.error(`unexpected reply: ${JSON.stringify(result.text)}`);
	process.exit(1);
}

// The streaming call mode is the production path (the server's /stream route);
// it bypasses the SSE-to-JSON translation, so smoke both.
const streamResult = await mastra.getAgent('smoke').stream('Reply with exactly one word: ok');
let streamed = '';
for await (const chunk of streamResult.textStream) {
	streamed += chunk;
}
if (!/\bok\b/i.test(streamed)) {
	console.error(`unexpected streamed reply: ${JSON.stringify(streamed)}`);
	process.exit(1);
}

console.log(`openai-codex/gpt-5.6-terra via gateway: ${result.text}`);
console.log(`openai-codex/gpt-5.6-terra via gateway (stream): ${streamed}`);
