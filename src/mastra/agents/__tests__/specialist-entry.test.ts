import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { createTool, noopObserve } from '@mastra/core/tools';
import { expect, test } from 'bun:test';
import { z } from 'zod';

import { createJamisSpecialistProcessor, createSpecialistInvocation } from '../../tools/invoke-specialist';
import { boundaryModel } from './specialist-boundary.fixture';

test('native entry shares verified research across fresh owners and revokes caller authority', async () => {
	const mastra = new Mastra({ logger: false });
	const inputSchema = z.object({ question: z.string() }).strict();
	const resultSchema = z.object({ answer: z.string() }).strict();
	const completed = { case: 'completed' as const, result: { answer: 'Verified public contribution.' } };
	let researchCalls = 0;
	const childContexts: RequestContext[] = [];
	const research = new Agent({
		id: 'research-agent',
		name: 'Research',
		instructions: 'Read the public source.',
		mastra,
		model: boundaryModel([{ tool: 'read_source', input: {} }, { handback: completed }]),
		tools: { read_source: createTool({
			id: 'read_source',
			description: 'Read a controlled source.',
			inputSchema: z.object({}).strict(),
			outputSchema: resultSchema,
			execute: async () => {
				researchCalls += 1;
				return completed.result;
			},
		}) },
	});
	const invokeResearch = createSpecialistInvocation({
		id: 'invoke_research',
		agent: research,
		inputSchema,
		resultSchema,
		allowedCallers: [{ kind: 'agent', id: 'weather-agent' }],
		project: input => input.question,
	});
	const owner = new Agent({
		id: 'weather-agent',
		name: 'Owner',
		instructions: 'Use the permitted contribution.',
		mastra,
		model: boundaryModel([
			{ tool: 'invoke_research', input: { question: 'One public question.' } },
			{ handback: completed },
			{ tool: 'invoke_research', input: { question: 'One public question.' } },
			{ handback: completed },
		]),
		inputProcessors: [{ id: 'capture_context', processInput: ({ messageList, requestContext }) => {
			childContexts.push(requestContext!);
			return messageList;
		} }],
		tools: { invoke_research: invokeResearch },
	});
	const invokeOwner = createSpecialistInvocation({
		id: 'invoke_weather',
		agent: owner,
		inputSchema,
		resultSchema,
		allowedCallers: [{ kind: 'agent', id: 'jamis' }],
		project: input => input.question,
	});
	const authority = createJamisSpecialistProcessor(() => undefined);
	const jamis = new Agent({
		id: 'jamis',
		name: 'Jamis',
		instructions: 'Request two bounded owner contributions.',
		mastra,
		inputProcessors: [authority],
		outputProcessors: [authority],
		tools: { invoke_weather: invokeOwner },
		defaultOptions: { toolCallConcurrency: 1 },
		model: boundaryModel([
			{ tool: 'invoke_weather', input: { question: 'First owner invocation.' } },
			{ tool: 'invoke_weather', input: { question: 'Fresh owner invocation with the prior public contribution.' } },
			{ text: 'Both contributions are available.' },
		]),
	});
	const requestContext = new RequestContext();
	const response = await jamis.generate('Current public task.', { requestContext });
	expect(response.text).toBe('Both contributions are available.');
	expect(response.toolResults.map(result => result.payload.result)).toEqual([completed, completed]);
	expect(researchCalls).toBe(1);
	expect(childContexts).toHaveLength(2);
	expect(childContexts[0]).not.toBe(childContexts[1]);
	await expect(invokeOwner.execute!({ question: 'Replay after root completion.' }, {
		requestContext,
		observe: noopObserve,
		agent: { agentId: 'jamis', toolCallId: 'replay', messages: [], suspend: async () => {} },
	})).rejects.toThrow('not authorized');
	await expect(invokeResearch.execute!({ question: 'Replay after child completion.' }, {
		requestContext: childContexts[0]!,
		observe: noopObserve,
		agent: { agentId: 'weather-agent', toolCallId: 'replay-child', messages: [], suspend: async () => {} },
	})).rejects.toThrow('not authorized');
});

test('root projection reads current input only, ignoring ambient and earlier user messages', async () => {
	const mastra = new Mastra({ logger: false });
	const resultSchema = z.object({ answer: z.string() }).strict();
	const prompts: unknown[] = [];
	const research = new Agent({
		id: 'research-agent',
		name: 'Research',
		instructions: 'Return a contribution.',
		mastra,
		model: boundaryModel([{ handback: { case: 'completed', result: { answer: 'Verified.' } } }], options => prompts.push(options)),
	});
	const invocation = createSpecialistInvocation({
		id: 'invoke_research',
		agent: research,
		inputSchema: z.object({ kind: z.literal('operator_request') }).strict(),
		resultSchema,
		allowedCallers: [{ kind: 'agent', id: 'jamis' }],
		project: (_, { operatorRequest }) => operatorRequest!,
	});
	const authority = createJamisSpecialistProcessor(() => undefined);
	const jamis = new Agent({
		id: 'jamis',
		name: 'Jamis',
		instructions: 'Get the current public contribution.',
		mastra,
		inputProcessors: [authority],
		outputProcessors: [authority],
		tools: { invoke_research: invocation },
		model: boundaryModel([{ tool: 'invoke_research', input: { kind: 'operator_request' } }, { text: 'Done.' }]),
	});
	const requestContext = new RequestContext();
	requestContext.setRaw('operatorRequest', 'PRIVATE_SENTINEL');
	requestContext.setRaw('caller', { kind: 'agent', id: 'jamis' });
	await jamis.generate([
		{ role: 'user', content: 'PRIVATE_SENTINEL' },
		{ role: 'assistant', content: 'Previous task completed.' },
		{ role: 'user', content: 'The current public question.' },
	], { requestContext });
	expect(JSON.stringify(prompts)).toContain('The current public question.');
	expect(JSON.stringify(prompts)).not.toContain('PRIVATE_SENTINEL');
});

test('native thrown tool calls remain unavailable evidence alongside validated independent progress', async () => {
	const mastra = new Mastra({ logger: false });
	const resultSchema = z.object({ answer: z.string() }).strict();
	const partial = { case: 'partial' as const, result: { answer: 'Available calendar evidence.' }, gaps: ['Email is unavailable.'] };
	const accounts = new Agent({
		id: 'personal-accounts-agent',
		name: 'Accounts',
		instructions: 'Read both requested sources.',
		mastra,
		model: boundaryModel([
			{ tool: 'read_email', input: {} },
			{ tool: 'read_calendar', input: {} },
			{ handback: partial },
		]),
		tools: {
			read_email: createTool({ id: 'read_email', description: 'Read email.', inputSchema: z.object({}), execute: async () => { throw new Error('PRIVATE_UPSTREAM_DIAGNOSTIC'); } }),
			read_calendar: createTool({ id: 'read_calendar', description: 'Read calendar.', inputSchema: z.object({}), execute: async () => partial.result }),
		},
	});
	let validated = false;
	const invocation = createSpecialistInvocation({
		id: 'invoke_personal_accounts',
		agent: accounts,
		inputSchema: z.object({ question: z.string() }).strict(),
		resultSchema,
		allowedCallers: [{ kind: 'agent', id: 'jamis' }],
		project: input => input.question,
		validate: (handback, { toolResults }) => {
			validated = true;
			expect(handback.case).toBe('partial');
			expect(toolResults).toHaveLength(2);
			expect(toolResults.find(result => result.payload.toolName === 'read_email')?.payload).toMatchObject({ isError: true, result: null });
			expect(toolResults.find(result => result.payload.toolName === 'read_calendar')?.payload.result).toEqual(partial.result);
			expect(JSON.stringify(toolResults)).not.toContain('PRIVATE_UPSTREAM_DIAGNOSTIC');
		},
	});
	const authority = createJamisSpecialistProcessor(() => undefined);
	const jamis = new Agent({
		id: 'jamis',
		name: 'Jamis',
		instructions: 'Get both sources.',
		mastra,
		inputProcessors: [authority],
		outputProcessors: [authority],
		tools: { invoke_personal_accounts: invocation },
		model: boundaryModel([{ tool: 'invoke_personal_accounts', input: { question: 'Read calendar and email.' } }, { text: 'The calendar is available; email is unavailable.' }]),
	});
	const response = await jamis.generate('Read calendar and email.');
	expect(validated).toBe(true);
	expect(response.toolResults[0]?.payload.result).toEqual(partial);
});
