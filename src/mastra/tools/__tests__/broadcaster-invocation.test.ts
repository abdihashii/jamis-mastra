import type { AgentConfig, AgentExecutionOptions } from '@mastra/core/agent';
import type { ToolExecutionContext } from '@mastra/core/tools';

import { createOpenAI } from '@ai-sdk/openai';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { createTool, isValidationError, noopObserve } from '@mastra/core/tools';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { expect, spyOn, test } from 'bun:test';
import { z } from 'zod';

import type { SpecialistCaller } from '../invoke-specialist';

import { FANTASY_BROADCAST_MODEL, FANTASY_PUBLICATION_WORKFLOW_ID, SAVED_REPORT_DELIVERY_TOOL_ID } from '../../../lib/fantasy/broadcast-policy';
import { FANTASY_EDITORIAL_WORKFLOW_ID } from '../../../lib/fantasy/editorial-policy';
import { boundaryModel, jamisFixtureContext } from '../../agents/__tests__/specialist-boundary.fixture';
import { specialistHandbackSchema } from '../../agents/specialist-handback';
import { createSpecialistContext, createSpecialistInvocation, normalizeSpecialistResult, requireBroadcasterDeliveryAuthority, revokeSpecialistAuthority } from '../invoke-specialist';

const workflowCaller = { kind: 'workflow', id: FANTASY_PUBLICATION_WORKFLOW_ID } as const;
const inputSchema = z.object({ assignment: z.string() }).strict();
const resultSchema = z.object({ answer: z.string().min(1) }).strict();
const handback = { case: 'completed', result: { answer: 'Synthetic delivery recorded.' } } as const;
const assignment = { assignment: 'Deliver only the privately bound saved report.' };
const otherTargets = {
	invoke_fantasy_broadcast: 'fantasy-broadcast-agent',
	invoke_fantasy_pundit: 'fantasy-football-pundit',
	invoke_fantasy_editor: 'fantasy-football-editor',
	invoke_weather: 'weather-agent',
	invoke_research: 'research-agent',
	invoke_personal_accounts: 'personal-accounts-agent',
} as const;

function deliveryTool(onDelivery: (context: ToolExecutionContext) => void = () => {}) {
	return createTool({
		id: SAVED_REPORT_DELIVERY_TOOL_ID,
		description: 'Record a synthetic delivery without network or persistence.',
		inputSchema: z.object({}).strict(),
		outputSchema: z.object({ delivered: z.literal(true) }).strict(),
		execute: async (_, context) => {
			requireBroadcasterDeliveryAuthority(context);
			onDelivery(context);
			return { delivered: true as const };
		},
	});
}

function fixture(overrides: Partial<Pick<AgentConfig, 'model' | 'tools' | 'inputProcessors'>> = {}, allowedCallers: readonly SpecialistCaller[] = [workflowCaller]) {
	const agent = new Agent({
		id: 'broadcaster',
		name: 'Checked Broadcaster fixture',
		instructions: 'Call the inert delivery tool and return the scripted handback.',
		mastra: new Mastra({ logger: false }),
		model: boundaryModel([{ tool: SAVED_REPORT_DELIVERY_TOOL_ID, input: {} }, { handback }]),
		tools: { [SAVED_REPORT_DELIVERY_TOOL_ID]: deliveryTool() },
		...overrides,
	});
	const tool = createSpecialistInvocation({
		id: 'invoke_broadcaster',
		agent,
		inputSchema,
		resultSchema,
		allowedCallers,
		project: input => input.assignment,
	});
	return { agent, tool };
}

function workflowContext(requestContext = createSpecialistContext(workflowCaller), workflowId: string = FANTASY_PUBLICATION_WORKFLOW_ID): ToolExecutionContext {
	return {
		requestContext,
		workflow: { workflowId, runId: 'synthetic-run', state: {}, setState: () => {}, suspend: async () => {} },
		observe: noopObserve,
	};
}

function agentContext(requestContext?: RequestContext, agentId = 'broadcaster'): ToolExecutionContext {
	return { requestContext, agent: { agentId, toolCallId: 'synthetic-call', messages: [], suspend: async () => {} }, observe: noopObserve };
}

async function nativeRun(tool: ReturnType<typeof fixture>['tool'], requestContext?: RequestContext, workflowId: string = FANTASY_PUBLICATION_WORKFLOW_ID) {
	const workflow = createWorkflow({ id: workflowId, inputSchema, outputSchema: specialistHandbackSchema(resultSchema) })
		.then(createStep(tool))
		.commit();
	const mastra = new Mastra({ logger: false, workflows: { fixture: workflow } });
	return (await mastra.getWorkflow('fixture').createRun()).start({ inputData: assignment, requestContext });
}

test('native publication workflow grants isolated delivery with pinned Luna options and tool-free handback step', async () => {
	const parent = createSpecialistContext(workflowCaller, 'private-operation');
	const secret = 'PRIVATE_BROADCAST_PARENT_SENTINEL';
	for (const key of ['operatorRequest', 'MastraMemory', 'mastra__threadId', 'mastra__resourceId', 'caller', 'researchResults'])
		parent.setRaw(key, secret);
	const requests: Array<Record<string, any>> = [];
	let callee: RequestContext | undefined;
	let deliveries = 0;
	let forbiddenCalls = 0;
	const modelName = FANTASY_BROADCAST_MODEL.split('/')[1]!;
	const model = createOpenAI({
		name: 'openai-codex',
		baseURL: 'https://fixture.invalid',
		apiKey: 'fixture',
		fetch: Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
			requests.push(JSON.parse(init!.body as string));
			return Response.json({
				id: `resp_fixture_${requests.length}`,
				created_at: 1800000000,
				model: modelName,
				status: 'completed',
				output: requests.length === 1
					? [{ type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: SAVED_REPORT_DELIVERY_TOOL_ID, arguments: '{}' }]
					: [{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ handback }), annotations: [] }] }],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			});
		}, { preconnect() {} }),
	}).responses(modelName);
	const { agent, tool } = fixture({
		model,
		tools: {
			[SAVED_REPORT_DELIVERY_TOOL_ID]: deliveryTool((context) => {
				expect(context.agent?.agentId).toBe('broadcaster');
				expect(context.requestContext).toBe(callee);
				deliveries++;
			}),
			forbidden: createTool({
				id: 'forbidden',
				description: 'Must not execute.',
				inputSchema: z.object({}).strict(),
				execute: async () => {
					forbiddenCalls++;
					return {};
				},
			}),
		},
		inputProcessors: [{
			id: 'inspect_private_grant',
			processInput: ({ messageList, requestContext }) => {
				callee = requestContext;
				expect(callee).not.toBe(parent);
				expect([...requestContext!.entries()]).toEqual([]);
				requireBroadcasterDeliveryAuthority(agentContext(callee));
				return messageList;
			},
		}],
	});
	const generate = spyOn(agent, 'generate');
	try {
		expect(await nativeRun(tool, parent)).toMatchObject({ status: 'success', result: handback });
		expect(generate).toHaveBeenCalledTimes(1);
		const options = generate.mock.calls[0]!.at(1) as unknown as AgentExecutionOptions;
		expect(options).toMatchObject({
			requestContext: callee,
			maxSteps: 2,
			toolCallConcurrency: 1,
			modelSettings: { maxRetries: 0, timeout: { totalMs: 120_000, stepMs: 120_000 } },
			providerOptions: { openai: { reasoningEffort: 'max', parallelToolCalls: false } },
			tracingOptions: { hideInput: true, hideOutput: true },
			structuredOutput: { errorStrategy: 'strict' },
		});
		for (const key of ['memory', 'model', 'instructions', 'structuredOutput.model'])
			expect(options).not.toHaveProperty(key);
		const prepareStep = options.prepareStep!;
		expect(await prepareStep({ stepNumber: 0 } as Parameters<typeof prepareStep>[0]))
			.toEqual({ activeTools: [SAVED_REPORT_DELIVERY_TOOL_ID], toolChoice: 'required' });
		expect(await prepareStep({ stepNumber: 1 } as Parameters<typeof prepareStep>[0]))
			.toEqual({ activeTools: [], toolChoice: 'none' });
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(request).toMatchObject({
				model: 'gpt-6-luna',
				reasoning: { effort: 'max' },
				parallel_tool_calls: false,
				text: { format: { type: 'json_schema', strict: true, schema: { type: 'object', required: ['handback'], additionalProperties: false } } },
			});
			expect(request.text.format.schema.properties.handback).toBeDefined();
			expect(request.text.format.schema.anyOf).toBeUndefined();
		}
		expect(requests[0]!.tool_choice).toBe('required');
		expect(requests[0]!.tools.map((tool: { name: string }) => tool.name)).toEqual([SAVED_REPORT_DELIVERY_TOOL_ID]);
		expect(requests[0]!.tools[0].parameters).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
		// The OpenAI adapter omits tool_choice when the active tool list is empty.
		expect(requests[1]!.tool_choice).toBeUndefined();
		expect(requests[1]!.tools ?? []).toEqual([]);
		expect(JSON.stringify(requests)).not.toContain(secret);
		expect(deliveries).toBe(1);
		expect(forbiddenCalls).toBe(0);
		expect(() => requireBroadcasterDeliveryAuthority(agentContext(callee))).toThrow('not authorized');
	} finally {
		generate.mockRestore();
		revokeSpecialistAuthority(parent);
	}
});

test('missing, forged, serialized, wrong-native and revoked root grants never generate or deliver', async () => {
	let calls = 0;
	const { tool } = fixture({ model: boundaryModel([{ handback }], () => calls++) });
	const root = createSpecialistContext(workflowCaller);
	root.setRaw('caller', workflowCaller);
	root.setRaw('workflowId', FANTASY_PUBLICATION_WORKFLOW_ID);
	const forged = new RequestContext();
	forged.setRaw('caller', workflowCaller);
	forged.setRaw('broadcasterParent', root);
	const serialized = new RequestContext(JSON.parse(JSON.stringify([...root.entries()])));
	const revoked = createSpecialistContext(workflowCaller);
	revokeSpecialistAuthority(revoked);
	for (const context of [
		{ ...workflowContext(), requestContext: undefined },
		workflowContext(new RequestContext()),
		workflowContext(forged),
		workflowContext(serialized),
		workflowContext(revoked),
		workflowContext(root, FANTASY_EDITORIAL_WORKFLOW_ID),
		workflowContext(root, 'prepare_linear_reply'),
		{ ...workflowContext(root), workflow: undefined },
		agentContext(root),
		jamisFixtureContext(),
		workflowContext(createSpecialistContext({ kind: 'workflow', id: FANTASY_EDITORIAL_WORKFLOW_ID })),
	]) {
		await expect(tool.execute!(assignment, context)).rejects.toThrow('not authorized');
		expect(() => requireBroadcasterDeliveryAuthority(context)).toThrow('not authorized');
	}
	for (const [context, id] of [
		[undefined, FANTASY_PUBLICATION_WORKFLOW_ID],
		[forged, FANTASY_PUBLICATION_WORKFLOW_ID],
		[serialized, FANTASY_PUBLICATION_WORKFLOW_ID],
		[revoked, FANTASY_PUBLICATION_WORKFLOW_ID],
		[root, FANTASY_EDITORIAL_WORKFLOW_ID],
	] as const) {
		expect(await nativeRun(tool, context, id)).toMatchObject({ status: 'failed', error: { message: 'Specialist invocation is not authorized.' } });
	}
	for (const context of [undefined, agentContext(), agentContext(root), agentContext(forged), agentContext(serialized), agentContext(revoked)])
		expect(() => requireBroadcasterDeliveryAuthority(context)).toThrow('not authorized');
	expect(calls).toBe(0);
	revokeSpecialistAuthority(root);
});

test('only publication can configure Broadcaster and publication cannot borrow legacy or editorial edges', async () => {
	for (const caller of [
		{ kind: 'agent', id: 'jamis' },
		{ kind: 'agent', id: 'weather-agent' },
		{ kind: 'agent', id: 'personal-accounts-agent' },
		{ kind: 'agent', id: 'fantasy-broadcast-agent' },
		{ kind: 'workflow', id: 'prepare_linear_reply' },
		{ kind: 'workflow', id: FANTASY_EDITORIAL_WORKFLOW_ID },
	] as const) {
		expect(() => fixture({}, [caller])).toThrow('Unsupported specialist');
	}
	for (const [id, agentId] of Object.entries(otherTargets) as Array<[keyof typeof otherTargets, string]>) {
		const agent = new Agent({ id: agentId, name: 'Denied edge fixture', instructions: 'Never run.', model: boundaryModel([]) });
		const config = { id, agent, inputSchema, resultSchema, project: (input: z.infer<typeof inputSchema>) => input.assignment };
		expect(() => createSpecialistInvocation({ ...config, allowedCallers: [workflowCaller] })).toThrow('Unsupported specialist');
		const caller = id === 'invoke_fantasy_pundit' || id === 'invoke_fantasy_editor'
			? { kind: 'workflow', id: FANTASY_EDITORIAL_WORKFLOW_ID } as const
			: { kind: 'agent', id: 'jamis' } as const;
		const legacy = createSpecialistInvocation({ ...config, allowedCallers: [caller] });
		await expect(legacy.execute!(assignment, workflowContext())).rejects.toThrow('not authorized');
	}
	expect(() => createSpecialistInvocation({
		id: 'invoke_broadcaster',
		agent: new Agent({ id: 'fantasy-broadcast-agent', name: 'Wrong native target', instructions: 'Never run.', model: boundaryModel([]) }),
		inputSchema,
		resultSchema,
		allowedCallers: [workflowCaller],
		project: input => input.assignment,
	})).toThrow('Unsupported specialist');
});

test('live child cannot borrow workflow authority or mint delivery from serialized context', async () => {
	const parent = createSpecialistContext(workflowCaller);
	const delivery = deliveryTool();
	const nested = fixture();
	let inspected = false;
	const { tool } = fixture({ inputProcessors: [{
		id: 'inspect_child_boundary',
		processInput: async ({ messageList, requestContext }) => {
			inspected = true;
			requireBroadcasterDeliveryAuthority(agentContext(requestContext));
			await expect(nested.tool.execute!(assignment, workflowContext(requestContext))).rejects.toThrow('not authorized');
			requestContext!.setRaw('caller', workflowCaller);
			requestContext!.setRaw('broadcasterParent', parent);
			const serialized = new RequestContext(JSON.parse(JSON.stringify([...requestContext!.entries()])));
			for (const context of [
				agentContext(serialized),
				agentContext(parent),
				agentContext(requestContext, 'jamis'),
				agentContext(requestContext, 'fantasy-broadcast-agent'),
				workflowContext(requestContext),
			]) {
				expect(() => requireBroadcasterDeliveryAuthority(context)).toThrow('not authorized');
				await expect(delivery.execute!({}, context)).rejects.toThrow('not authorized');
			}
			for (const input of [{ reportId: 'forged' }, { text: 'replacement' }, { groupId: 'wrong-group' }, { caller: workflowCaller }, { options: {} }])
				expect(isValidationError(await delivery.execute!(input as unknown as Record<string, never>, agentContext(requestContext)))).toBe(true);
			return messageList;
		},
	}] });
	try {
		expect(await nativeRun(tool, parent)).toMatchObject({ status: 'success', result: handback });
		expect(inspected).toBe(true);
	} finally {
		revokeSpecialistAuthority(parent);
	}
});

for (const revokedGrant of ['parent', 'child'] as const) {
	test(`revoking ${revokedGrant} before native delivery denies the inert tool`, async () => {
		const parent = createSpecialistContext(workflowCaller);
		let callee: RequestContext | undefined;
		let denied = 0;
		const deniedTool = createTool({
			id: SAVED_REPORT_DELIVERY_TOOL_ID,
			description: 'Observe revoked grant without side effects.',
			inputSchema: z.object({}).strict(),
			outputSchema: z.object({}).strict(),
			execute: async (_, context) => {
				expect(() => requireBroadcasterDeliveryAuthority(context)).toThrow('not authorized');
				denied++;
				throw new Error('Delivery denied.');
			},
		});
		const { tool } = fixture({
			inputProcessors: [{
				id: 'revoke_before_delivery',
				processInput: ({ messageList, requestContext }) => {
					callee = requestContext;
					requireBroadcasterDeliveryAuthority(agentContext(callee));
					revokeSpecialistAuthority(revokedGrant === 'parent' ? parent : callee!);
					return messageList;
				},
			}],
			tools: { [SAVED_REPORT_DELIVERY_TOOL_ID]: deniedTool },
		});
		try {
			await nativeRun(tool, parent);
			expect(denied).toBe(1);
			expect(() => requireBroadcasterDeliveryAuthority(agentContext(callee))).toThrow('not authorized');
		} finally {
			revokeSpecialistAuthority(parent);
		}
	});
}

test('the 16000-character assignment ceiling holds and caller options are rejected', async () => {
	let calls = 0;
	const { tool } = fixture({ model: boundaryModel([{ handback }], () => calls++) });
	expect(await tool.execute!({ assignment: 'x'.repeat(16_000) }, workflowContext())).toEqual(handback);
	for (const text of ['', '   ', 'x'.repeat(16_001)])
		await expect(tool.execute!({ assignment: text }, workflowContext())).rejects.toThrow('assignment is invalid');
	for (const extra of [{ model: 'untrusted' }, { memory: {} }, { maxSteps: 5 }, { providerOptions: {} }, { caller: workflowCaller }, { prepareStep: 'override' }, { assignment: ['first', 'duplicate'] }])
		expect(await normalizeSpecialistResult(resultSchema, () => tool.execute!({ ...assignment, ...extra } as z.infer<typeof inputSchema>, workflowContext()))).toMatchObject({ case: 'failed', progress: null });
	expect(calls).toBe(1);
});

test('duplicate delivery on the second step cannot execute or extend the two-step budget', async () => {
	let calls = 0;
	let deliveries = 0;
	const { tool } = fixture({
		model: boundaryModel([
			{ tool: SAVED_REPORT_DELIVERY_TOOL_ID, input: {} },
			{ tool: SAVED_REPORT_DELIVERY_TOOL_ID, input: {} },
			{ handback },
		], () => calls++),
		tools: { [SAVED_REPORT_DELIVERY_TOOL_ID]: deliveryTool(() => deliveries++) },
	});
	expect(await normalizeSpecialistResult(resultSchema, () => tool.execute!(assignment, workflowContext()))).toMatchObject({ case: 'failed', progress: null });
	expect(calls).toBe(2);
	expect(deliveries).toBe(1);
});

test('invalid handbacks fail closed and revoke child delivery grants', async () => {
	for (const action of [
		{ text: 'Unstructured prose.' },
		{ text: JSON.stringify(handback) },
		{ text: JSON.stringify({ handback, approved: true }) },
		{ handback: { case: 'completed', result: { answer: 42 } } },
		{ handback: { case: 'failed', reason: 'Model-authored failure.', progress: null } },
		{ tool: 'forbidden', input: {} },
	]) {
		let calls = 0;
		let callee: RequestContext | undefined;
		let executions = 0;
		const { tool } = fixture({
			model: boundaryModel([action], () => calls++),
			inputProcessors: [{
				id: 'capture_context',
				processInput: ({ messageList, requestContext }) => {
					callee = requestContext;
					return messageList;
				},
			}],
			tools: {
				[SAVED_REPORT_DELIVERY_TOOL_ID]: deliveryTool(),
				forbidden: createTool({
					id: 'forbidden',
					description: 'Never execute.',
					inputSchema: z.object({}),
					execute: async () => {
						executions++;
						return {};
					},
				}),
			},
		});
		expect(await normalizeSpecialistResult(resultSchema, () => tool.execute!(assignment, workflowContext()))).toMatchObject({ case: 'failed', progress: null });
		expect(calls).toBeLessThanOrEqual(2);
		expect(executions).toBe(0);
		expect(() => requireBroadcasterDeliveryAuthority(agentContext(callee))).toThrow('not authorized');
	}
});

test('provider errors are not retried and cannot keep a delivery grant alive', async () => {
	let calls = 0;
	let callee: RequestContext | undefined;
	const model = createOpenAI({
		apiKey: 'fixture',
		baseURL: 'https://fixture.invalid',
		fetch: Object.assign(async () => {
			calls++;
			return Response.json({ error: { message: 'Scripted retryable failure.', type: 'server_error', code: 'server_error' } }, { status: 500 });
		}, { preconnect() {} }),
	}).responses('gpt-6-luna');
	const { tool } = fixture({
		model,
		inputProcessors: [{
			id: 'capture_context',
			processInput: ({ messageList, requestContext }) => {
				callee = requestContext;
				return messageList;
			},
		}],
	});
	expect(await normalizeSpecialistResult(resultSchema, () => tool.execute!(assignment, workflowContext()))).toMatchObject({ case: 'failed', progress: null });
	expect(calls).toBe(1);
	expect(() => requireBroadcasterDeliveryAuthority(agentContext(callee))).toThrow('not authorized');
});
