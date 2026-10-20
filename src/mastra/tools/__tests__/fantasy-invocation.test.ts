import type { AgentConfig } from '@mastra/core/agent';
import type { ToolExecutionContext } from '@mastra/core/tools';
import type { SpecialistCaller } from '../invoke-specialist';

import { expect, spyOn, test } from 'bun:test';
import { createOpenAI } from '@ai-sdk/openai';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { createTool, noopObserve } from '@mastra/core/tools';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { FANTASY_EDITORIAL_LIMITS, FANTASY_EDITORIAL_WORKFLOW_ID } from '../../../lib/fantasy/editorial-policy';
import { boundaryModel, jamisFixtureContext } from '../../agents/__tests__/specialist-boundary.fixture';
import { specialistHandbackSchema } from '../../agents/specialist-handback';
import { createSpecialistContext, createSpecialistInvocation, normalizeSpecialistResult, revokeSpecialistAuthority } from '../invoke-specialist';

const targets = {
	invoke_fantasy_pundit: 'fantasy-football-pundit',
	invoke_fantasy_editor: 'fantasy-football-editor',
} as const;
const legacyTargets = {
	invoke_fantasy_broadcast: 'fantasy-broadcast-agent',
	invoke_weather: 'weather-agent',
	invoke_research: 'research-agent',
	invoke_personal_accounts: 'personal-accounts-agent',
} as const;
type Target = keyof typeof targets | keyof typeof legacyTargets;
const workflowCaller = { kind: 'workflow', id: FANTASY_EDITORIAL_WORKFLOW_ID } as const;
const inputSchema = z.object({ assignment: z.string() }).strict();
const resultSchema = z.object({ answer: z.string().min(1) }).strict();
const handback = { case: 'completed', result: { answer: 'Synthetic checked contribution.' } } as const;
const assignment = { assignment: 'Use only this synthetic evidence packet.' };

function fixture(id: Target, overrides: Partial<Pick<AgentConfig, 'model' | 'tools' | 'inputProcessors'>> = {}, allowedCallers: readonly SpecialistCaller[] = [workflowCaller]) {
	const agent = new Agent({
		id: { ...targets, ...legacyTargets }[id],
		name: 'Checked invocation fixture',
		instructions: 'Return the scripted typed handback.',
		mastra: new Mastra({ logger: false }),
		model: boundaryModel([{ handback }]),
		...overrides,
	});
	const tool = createSpecialistInvocation({
		id,
		agent,
		inputSchema,
		resultSchema,
		allowedCallers,
		project: input => input.assignment,
	});
	return { agent, tool };
}

function workflowContext(
	requestContext = createSpecialistContext(workflowCaller),
	workflowId: string = FANTASY_EDITORIAL_WORKFLOW_ID,
): ToolExecutionContext {
	return {
		requestContext,
		workflow: { workflowId, runId: 'synthetic-run', state: {}, setState: () => {}, suspend: async () => {} },
		observe: noopObserve,
	};
}

async function nativeRun(tool: ReturnType<typeof fixture>['tool'], requestContext?: RequestContext, workflowId: string = FANTASY_EDITORIAL_WORKFLOW_ID) {
	const workflow = createWorkflow({
		id: workflowId,
		inputSchema,
		outputSchema: specialistHandbackSchema(resultSchema),
	}).then(createStep(tool)).commit();
	const mastra = new Mastra({ logger: false, workflows: { fixture: workflow } });
	return (await mastra.getWorkflow('fixture').createRun()).start({ inputData: assignment, requestContext });
}

for (const id of Object.keys(targets) as Array<keyof typeof targets>) {
	test(`${id}: native workflow grant, isolated context and fixed tool-free provider serialization`, async () => {
		const requests: Array<Record<string, any>> = [];
		const parent = createSpecialistContext(workflowCaller, 'private-pending-operation');
		const secret = 'PRIVATE_PARENT_CONTEXT_SENTINEL';
		for (const key of ['operatorRequest', 'MastraMemory', 'mastra__threadId', 'mastra__resourceId', 'caller'])
			parent.setRaw(key, secret);
		let callee: RequestContext | undefined;
		let nestedCalls = 0;
		const nested = fixture('invoke_research', {
			model: boundaryModel([{ handback }], () => { nestedCalls += 1; }),
		// Even a mistakenly exposed Research edge must not find child authority.
		}, [{ kind: 'agent', id: targets[id] } as unknown as SpecialistCaller]);
		let toolCalls = 0;
		const forbidden = createTool({
			id: 'forbidden',
			description: 'Must not be offered or executed.',
			inputSchema: z.object({}).strict(),
			execute: async () => {
				toolCalls++;
				return {};
			},
		});
		const model = createOpenAI({
			name: 'openai-codex',
			baseURL: 'https://fixture.invalid',
			apiKey: 'fixture',
			fetch: Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
				requests.push(JSON.parse(init!.body as string));
				return Response.json({
					id: 'resp_fixture',
					created_at: 1800000000,
					model: 'gpt-6-astra',
					status: 'completed',
					output: [{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ handback }), annotations: [] }] }],
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				});
			}, { preconnect() {} }),
		}).responses('gpt-6-astra');
		const { agent, tool } = fixture(id, {
			model,
			tools: { forbidden },
			inputProcessors: [{
				id: 'inspect_isolated_context',
				processInput: async ({ messageList, requestContext }) => {
					callee = requestContext;
					expect(requestContext).not.toBe(parent);
					expect(JSON.stringify([...requestContext!.entries()])).not.toContain(secret);
					await expect(nested.tool.execute!(assignment, {
						requestContext,
						agent: { agentId: targets[id], toolCallId: 'nested', messages: [], suspend: async () => {} },
						observe: noopObserve,
					})).rejects.toThrow('not authorized');
					return messageList;
				},
			}],
		});
		const generate = spyOn(agent, 'generate');
		try {
			expect(await nativeRun(tool, parent)).toMatchObject({ status: 'success', result: handback });
			expect(generate).toHaveBeenCalledTimes(1);
			const options = generate.mock.calls[0]!.at(1);
			expect(options).toMatchObject({
				maxSteps: 1,
				toolCallConcurrency: 1,
				activeTools: [],
				toolChoice: 'none',
				modelSettings: { maxRetries: 0, timeout: { totalMs: 300_000, stepMs: 300_000 } },
				providerOptions: { openai: { reasoningEffort: 'xhigh', parallelToolCalls: false } },
				tracingOptions: { hideInput: true, hideOutput: true },
				structuredOutput: { errorStrategy: 'strict' },
			});
			expect(options).toHaveProperty('requestContext', callee);
			expect(options).not.toHaveProperty('memory');
			expect(options).not.toHaveProperty('instructions');
			expect(options).not.toHaveProperty('structuredOutput.model');
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({
				model: 'gpt-6-astra',
				reasoning: { effort: 'xhigh' },
				parallel_tool_calls: false,
				text: { format: { type: 'json_schema', strict: true, schema: { type: 'object', required: ['handback'], additionalProperties: false } } },
			});
			expect(requests[0]!.text.format.schema.properties.handback).toBeDefined();
			expect(requests[0]!.text.format.schema.anyOf).toBeUndefined();
			expect(requests[0]!.tools ?? []).toEqual([]);
			expect(JSON.stringify(requests)).not.toContain(secret);
			expect(toolCalls).toBe(0);
			expect(nestedCalls).toBe(0);
		} finally {
			generate.mockRestore();
			revokeSpecialistAuthority(parent);
		}
	});

	test(`${id}: missing, forged, serialized, wrong-native and revoked grants never generate`, async () => {
		let calls = 0;
		const { tool } = fixture(id, { model: boundaryModel([{ handback }], () => calls++) });
		const grant = createSpecialistContext(workflowCaller);
		grant.setRaw('caller', workflowCaller);
		grant.setRaw('workflowId', FANTASY_EDITORIAL_WORKFLOW_ID);
		const forged = new RequestContext();
		forged.setRaw('caller', workflowCaller);
		forged.setRaw('workflowId', FANTASY_EDITORIAL_WORKFLOW_ID);
		const serialized = new RequestContext(JSON.parse(JSON.stringify([...grant.entries()])));
		const revoked = createSpecialistContext(workflowCaller);
		revokeSpecialistAuthority(revoked);
		for (const context of [
			{ ...workflowContext(), requestContext: undefined },
			workflowContext(new RequestContext()),
			workflowContext(forged),
			workflowContext(serialized),
			workflowContext(revoked),
			workflowContext(grant, 'prepare_linear_reply'),
			{ ...workflowContext(grant), workflow: undefined },
			{ ...jamisFixtureContext(), requestContext: grant },
			jamisFixtureContext(),
			workflowContext(createSpecialistContext({ kind: 'workflow', id: 'prepare_linear_reply' }), 'prepare_linear_reply'),
		]) {
			await expect(tool.execute!(assignment, context)).rejects.toThrow('not authorized');
		}
		for (const [context, nativeId] of [
			[undefined, FANTASY_EDITORIAL_WORKFLOW_ID],
			[forged, FANTASY_EDITORIAL_WORKFLOW_ID],
			[serialized, FANTASY_EDITORIAL_WORKFLOW_ID],
			[revoked, FANTASY_EDITORIAL_WORKFLOW_ID],
			[grant, 'prepare_linear_reply'],
		] as const) {
			expect(await nativeRun(tool, context, nativeId)).toMatchObject({ status: 'failed', error: { message: 'Specialist invocation is not authorized.' } });
		}
		expect(calls).toBe(0);
		revokeSpecialistAuthority(grant);
	});

	test(`${id}: only the closed workflow edge can be configured`, () => {
		for (const caller of [
			{ kind: 'agent', id: 'jamis' },
			{ kind: 'agent', id: 'weather-agent' },
			{ kind: 'agent', id: 'personal-accounts-agent' },
			{ kind: 'agent', id: 'fantasy-broadcast-agent' },
			{ kind: 'workflow', id: 'prepare_linear_reply' },
		] as const) {
			expect(() => fixture(id, {}, [caller])).toThrow('Unsupported specialist');
		}
	});

	test(`${id}: trusted assignment ceiling is exact and caller options remain invalid`, async () => {
		let calls = 0;
		const { tool } = fixture(id, { model: boundaryModel([{ handback }], () => calls++) });
		expect(await tool.execute!({ assignment: 'x'.repeat(FANTASY_EDITORIAL_LIMITS.assignmentChars) }, workflowContext())).toEqual(handback);
		for (const text of ['', '   ', 'x'.repeat(FANTASY_EDITORIAL_LIMITS.assignmentChars + 1)])
			await expect(tool.execute!({ assignment: text }, workflowContext())).rejects.toThrow('assignment is invalid');
		for (const extra of [{ maxSteps: 5 }, { model: 'untrusted' }, { providerOptions: {} }, { caller: workflowCaller }]) {
			expect(await normalizeSpecialistResult(resultSchema, () => tool.execute!({ ...assignment, ...extra }, workflowContext()))).toMatchObject({ case: 'failed', progress: null });
		}
		expect(calls).toBe(1);
	});

	test(`${id}: strict handbacks fail closed without retries or executing invented tools`, async () => {
		for (const action of [
			{ text: 'Unstructured prose.' },
			{ text: JSON.stringify(handback) },
			{ text: JSON.stringify({ handback, approved: true }) },
			{ handback: { case: 'completed', result: { answer: 42 } } },
			{ handback: { case: 'failed', reason: 'Model-authored failure.', progress: null } },
			{ tool: 'forbidden', input: {} },
		]) {
			let calls = 0;
			let executions = 0;
			const { tool } = fixture(id, {
				model: boundaryModel([action], () => { calls += 1; }),
				tools: { forbidden: createTool({
					id: 'forbidden',
					description: 'Inert prohibited tool.',
					inputSchema: z.object({}),
					execute: async () => {
						executions++;
						return {};
					},
				}) },
			});
			expect(await normalizeSpecialistResult(resultSchema, () => tool.execute!(assignment, workflowContext()))).toMatchObject({ case: 'failed', progress: null });
			expect(calls).toBe(1);
			expect(executions).toBe(0);
		}
	});
}

test('new workflow cannot borrow any legacy edge; linear reply remains Accounts-only', async () => {
	for (const id of Object.keys(legacyTargets) as Array<keyof typeof legacyTargets>) {
		expect(() => fixture(id)).toThrow('Unsupported specialist');
		if (id !== 'invoke_personal_accounts')
			expect(() => fixture(id, {}, [{ kind: 'workflow', id: 'prepare_linear_reply' }])).toThrow('Unsupported specialist');
	}
	const linearCaller = { kind: 'workflow', id: 'prepare_linear_reply' } as const;
	const linear = fixture('invoke_personal_accounts', {}, [linearCaller]);
	expect(await nativeRun(linear.tool, createSpecialistContext(linearCaller), linearCaller.id)).toMatchObject({ status: 'success', result: handback });
	expect(() => createSpecialistInvocation({
		id: 'invoke_fantasy_pundit',
		agent: fixture('invoke_fantasy_editor').agent,
		inputSchema,
		resultSchema,
		allowedCallers: [workflowCaller],
		project: input => input.assignment,
	})).toThrow('Unsupported specialist');
});

test('legacy agents retain five-step generation options and the 16000-character ceiling', async () => {
	for (const id of Object.keys(legacyTargets) as Array<keyof typeof legacyTargets>) {
		const { agent, tool } = fixture(id, {}, [{ kind: 'agent', id: 'jamis' }]);
		const generate = spyOn(agent, 'generate');
		try {
			expect(await tool.execute!({ assignment: 'x'.repeat(16_000) }, jamisFixtureContext())).toEqual(handback);
			await expect(tool.execute!({ assignment: 'x'.repeat(16_001) }, jamisFixtureContext())).rejects.toThrow('assignment is invalid');
			expect(generate).toHaveBeenCalledTimes(1);
			const options = generate.mock.calls[0]!.at(1);
			expect(options).toMatchObject({ maxSteps: 5, toolCallConcurrency: 1, structuredOutput: { errorStrategy: 'strict' } });
			for (const key of ['activeTools', 'toolChoice', 'modelSettings', 'providerOptions', 'tracingOptions'])
				expect(options).not.toHaveProperty(key);
		} finally {
			generate.mockRestore();
		}
	}
});

test('native provider errors are not retried by the editorial boundary', async () => {
	let calls = 0;
	const model = createOpenAI({
		apiKey: 'fixture',
		baseURL: 'https://fixture.invalid',
		fetch: Object.assign(async () => {
			calls++;
			return Response.json({ error: { message: 'Scripted retryable failure.', type: 'server_error', code: 'server_error' } }, { status: 500 });
		}, { preconnect() {} }),
	}).responses('gpt-6-astra');
	const { tool } = fixture('invoke_fantasy_pundit', { model });
	expect(await normalizeSpecialistResult(resultSchema, () => tool.execute!(assignment, workflowContext()))).toMatchObject({ case: 'failed', progress: null });
	expect(calls).toBe(1);
});
