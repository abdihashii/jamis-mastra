import { expect, test } from 'bun:test';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';

import { createSpecialistContext, createSpecialistInvocation, normalizeSpecialistResult } from '../../tools/invoke-specialist';
import { specialistHandbackSchema } from '../specialist-handback';
import { boundaryModel, jamisFixtureContext, runSpecialistBoundaryFixture } from './specialist-boundary.fixture';

test('native specialist boundary: tool use, nested public projection, registry and direct authority', async () => {
	await runSpecialistBoundaryFixture(new Mastra());
}, 10_000);

const resultSchema = z.object({ answer: z.string().min(1) }).strict();
const inputSchema = z.object({ question: z.string() }).strict();
function invocation(handback: unknown) {
	return createSpecialistInvocation({
		id: 'invoke_weather',
		agent: new Agent({ id: 'weather-agent', name: 'Fixture', instructions: 'Return typed handback.', mastra: new Mastra(), model: boundaryModel([{ handback }]) }),
		inputSchema,
		resultSchema,
		allowedCallers: [{ kind: 'agent', id: 'jamis' }],
		project: input => input.question,
	});
}

test('the four model cases are strict and runtime failed cannot be authored by the model', async () => {
	for (const handback of [
		{ case: 'completed', result: { answer: 'Verified.' } },
		{ case: 'partial', result: { answer: 'Verified part.' }, gaps: ['Remaining fact unavailable.'] },
		{ case: 'needs_help', need: { kind: 'input', question: 'Which city?', missing: ['location'] }, progress: null },
		{ case: 'blocked', reason: 'Evidence status: insufficient. I could not verify the requested factual answer.', progress: null },
	] satisfies z.infer<ReturnType<typeof specialistHandbackSchema<{ answer: string }>>>[]) {
		const tool = invocation(handback);
		expect(await tool.execute!({ question: 'Bounded task.' }, jamisFixtureContext())).toEqual(handback);
	}
	expect(specialistHandbackSchema(resultSchema).safeParse({ case: 'failed', reason: 'Pretend runtime failure.', progress: null }).success).toBe(false);
	expect(specialistHandbackSchema(resultSchema).safeParse({ case: 'completed', result: { answer: 'ok' }, approved: true }).success).toBe(false);
});

test('malformed output, missing object and native validation values fail without invented progress', async () => {
	const malformed = invocation({ case: 'completed', result: { answer: 42 } });
	expect(await normalizeSpecialistResult(resultSchema, () => malformed.execute!({ question: 'Bounded task.' }, jamisFixtureContext()))).toMatchObject({ case: 'failed', progress: null });
	expect(await normalizeSpecialistResult(resultSchema, async () => undefined, { answer: 'Independently verified.' })).toMatchObject({ case: 'failed', progress: { answer: 'Independently verified.' } });
	expect(await normalizeSpecialistResult(resultSchema, async () => ({ error: true, message: 'Input validation failed', validationErrors: [] }))).toMatchObject({ case: 'failed', progress: null });
});

test('caller, generation override and approval references cannot expand authority', async () => {
	const tool = invocation({ case: 'needs_help', need: { kind: 'approval', operationId: '00000000-0000-4000-8000-000000000001' }, progress: null });
	await expect(tool.execute!({ question: 'Bounded task.' }, jamisFixtureContext())).rejects.toThrow('pending operation');
	const context = jamisFixtureContext();
	context.requestContext = createSpecialistContext({ kind: 'agent', id: 'weather-agent' });
	await expect(tool.execute!({ question: 'Bounded task.' }, context)).rejects.toThrow('not authorized');
	expect(await normalizeSpecialistResult(resultSchema, () => tool.execute!({ question: 'Bounded task.', maxSteps: 100 } as { question: string }, jamisFixtureContext()))).toMatchObject({ case: 'failed' });
});

test('caller cancellation remains a runtime fact and prevents generation', async () => {
	const tool = invocation({ case: 'completed', result: { answer: 'Should not run.' } });
	const abort = new AbortController();
	abort.abort();
	await expect(normalizeSpecialistResult(resultSchema, () => tool.execute!({ question: 'Bounded task.' }, { ...jamisFixtureContext(), abortSignal: abort.signal }))).rejects.toThrow();
});
