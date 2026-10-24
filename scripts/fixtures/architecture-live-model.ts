import type { Mastra } from '@mastra/core';

import { Agent } from '@mastra/core/agent';
import { createTool, noopObserve } from '@mastra/core/tools';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { createSpecialistContext, createSpecialistInvocation, normalizeSpecialistResult } from '../../src/mastra/tools/invoke-specialist';

export async function runArchitectureLiveModelFixture(mastra: Mastra) {
	const nonce = 'architecture-live-fixture-v1';
	let toolCalls = 0;
	const resultSchema = z.object({ nonce: z.string() }).strict();
	const readFixture = createTool({
		id: 'read_architecture_live_fixture',
		description: 'Read one synthetic public fixture and return its nonce. No external data or effects.',
		inputSchema: z.object({}).strict(),
		outputSchema: resultSchema,
		execute: async () => {
			assert.equal(++toolCalls, 1, 'The bounded observation must call its synthetic tool exactly once.');
			return { nonce };
		},
	});
	const model = 'openai-codex/gpt-6-luna';
	const agent = new Agent({
		id: 'weather-agent',
		name: 'Architecture Live Fixture',
		mastra,
		model,
		maxRetries: 0,
		instructions: 'Call read_architecture_live_fixture exactly once, then return a completed handback whose result contains the nonce returned by that tool. This is synthetic public data. Do not invent the nonce.',
		tools: { read_architecture_live_fixture: readFixture },
		defaultOptions: { maxSteps: 3, toolCallConcurrency: 1 },
	});
	const invocation = createSpecialistInvocation({
		id: 'invoke_weather',
		agent,
		inputSchema: z.object({ question: z.string() }).strict(),
		resultSchema,
		allowedCallers: [{ kind: 'agent', id: 'jamis' }],
		project: input => input.question,
	});
	const response = await normalizeSpecialistResult(resultSchema, () => invocation.execute!({
		question: 'Read the synthetic fixture once and return its nonce in a completed handback.',
	}, {
		requestContext: createSpecialistContext({ kind: 'agent', id: 'jamis' }),
		agent: { agentId: 'jamis', toolCallId: 'architecture-live-fixture', messages: [], suspend: async () => {} },
		abortSignal: AbortSignal.timeout(60_000),
		observe: noopObserve,
	}));
	assert.equal(response.case, 'completed', 'The real model must return a validated completed handback.');
	assert(response.case === 'completed');
	assert.equal(response.result.nonce, nonce, 'The structured result must preserve the synthetic tool nonce.');
	assert.equal(toolCalls, 1, 'The real model must use its synthetic read-only tool exactly once.');
	return { model, handback: response.case, toolCalls, structuredOutput: 'validated', externalEffects: 0 };
}
