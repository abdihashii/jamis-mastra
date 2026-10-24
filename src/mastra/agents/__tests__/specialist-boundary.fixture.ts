import type { Mastra } from '@mastra/core';
import type { ToolExecutionContext } from '@mastra/core/tools';

import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createTool, noopObserve } from '@mastra/core/tools';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { createSpecialistContext, createSpecialistInvocation, normalizeSpecialistResult } from '../../tools/invoke-specialist';
import { createPersonalAccountsAgent } from '../personal-accounts-agent';
import { personalAccountsResultSchema } from '../personal-accounts-handback';
import { createResearchAgent } from '../research-agent';
import { researchResultSchema } from '../research-handback';
import { createResearchQuestionProjector, researchQuestionSchema } from '../research-question';
import { createWeatherAgent } from '../weather-agent';
import { validateWeatherHandback, weatherResultSchema } from '../weather-handback';

export const PRIVATE_ARCHITECTURE_SENTINEL = 'PRIVATE_ARCHITECTURE_SENTINEL';
type Action = { tool: string; input: Record<string, unknown> } | { handback: unknown } | { text: string };

export function boundaryModel(actions: Action[], inspect?: (options: unknown) => void) {
	let step = 0;
	return new MastraLanguageModelV2Mock({ doGenerate: async (options) => {
		inspect?.(options);
		const action = actions[step++];
		assert(action, 'The model exceeded its bounded fixture sequence.');
		return {
			content: 'tool' in action
				? [{ type: 'tool-call', toolCallId: `call-${step}`, toolName: action.tool, input: JSON.stringify(action.input) }]
				: [{ type: 'text', text: 'handback' in action ? JSON.stringify({ handback: action.handback }) : action.text }],
			finishReason: 'tool' in action ? 'tool-calls' : 'stop',
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			warnings: [],
		};
	}, doStream: async (options) => {
		inspect?.(options);
		const action = actions[step++];
		assert(action, 'The model exceeded its bounded fixture sequence.');
		return { stream: new ReadableStream({ start(controller) {
			controller.enqueue({ type: 'stream-start', warnings: [] });
			if ('tool' in action) {
				controller.enqueue({ type: 'tool-call', toolCallId: `call-${step}`, toolName: action.tool, input: JSON.stringify(action.input) });
			} else {
				controller.enqueue({ type: 'text-start', id: 'reply' });
				controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'handback' in action ? JSON.stringify({ handback: action.handback }) : action.text });
				controller.enqueue({ type: 'text-end', id: 'reply' });
			}
			controller.enqueue({ type: 'finish', finishReason: 'tool' in action ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
			controller.close();
		} }) };
	} });
}

export function jamisFixtureContext(): ToolExecutionContext {
	return {
		requestContext: createSpecialistContext({ kind: 'agent', id: 'jamis' }),
		agent: { agentId: 'jamis', toolCallId: 'fixture-invocation', messages: [], suspend: async () => {} },
		observe: noopObserve,
	};
}

export async function runSpecialistBoundaryFixture(mastra: Mastra) {
	const questionSchema = z.object({ question: z.string().min(1).max(4000) }).strict();
	const reading = { location: 'Chicago, Illinois', date: '2026-10-10', high: 66, low: 49, feelsLike: 62, condition: 'Clear', precipChancePercent: 0, precipitationMm: 0, windMph: 5, humidityPercent: 50 };
	const weatherResult = { answer: 'The weather in Chicago, Illinois will be clear.', reading: { kind: 'forecast' as const, ...reading } };
	let weatherCalls = 0;
	const forecastTool = createTool({
		id: 'read_architecture_weather',
		description: 'Read a synthetic forecast.',
		inputSchema: z.object({ location: z.string(), date: z.string() }).strict(),
		outputSchema: weatherResultSchema.shape.reading.options[1].omit({ kind: true }),
		execute: async (_, context) => {
			assert(context.abortSignal);
			weatherCalls += 1;
			return reading;
		},
	});
	const weather = createWeatherAgent({ mastra, model: boundaryModel([
		{ tool: 'forecastTool', input: { location: 'Chicago', date: reading.date } },
		{ handback: { case: 'completed', result: weatherResult } },
	]), tools: { forecastTool } });
	const invokeWeather = createSpecialistInvocation({
		id: 'invoke_weather',
		agent: weather,
		inputSchema: questionSchema,
		resultSchema: weatherResultSchema,
		allowedCallers: [{ kind: 'agent', id: 'jamis' }],
		project: input => input.question,
		validate: validateWeatherHandback,
	});
	const completed = await invokeWeather.execute!({ question: 'Forecast for Chicago on 2026-10-10.' }, { ...jamisFixtureContext(), abortSignal: AbortSignal.timeout(5000) });
	assert.deepEqual(completed, { case: 'completed', result: weatherResult });
	assert.equal(weatherCalls, 1);

	const researchObservations: unknown[] = [];
	const source = { title: 'Synthetic published fare policy', url: 'https://example.com/public-policy', evidenceKind: 'developer-passage' as const, evidence: 'The synthetic fare permits one small personal item.', limitations: ['Synthetic evidence for integration testing.'] };
	const researchResult = { findings: [{ text: source.evidence, sourceNumbers: [1] }], sources: [source], limitations: [] };
	let providerCalls = 0;
	const retrieve = createTool({
		id: 'read_architecture_public_source',
		description: 'Retrieve a synthetic public policy.',
		inputSchema: z.object({ query: z.string() }).strict(),
		outputSchema: researchResultSchema,
		execute: async (input, context) => {
			providerCalls += 1;
			researchObservations.push(input, [...context.requestContext.entries()]);
			return researchResult;
		},
	});
	const research = createResearchAgent({ mastra, tools: { researchSourceRetrieve: retrieve }, model: boundaryModel([
		{ tool: 'researchSourceRetrieve', input: { query: 'United Basic Economy public carry-on allowance' } },
		{ handback: { case: 'completed', result: researchResult } },
	], options => researchObservations.push(options)) });
	assert.equal((await research.getDefaultOptions()).maxSteps, 5);
	assert.equal((await research.getDefaultOptions()).toolCallConcurrency, 1);
	const invokeResearch = createSpecialistInvocation({
		id: 'invoke_research',
		agent: research,
		inputSchema: researchQuestionSchema,
		resultSchema: researchResultSchema,
		allowedCallers: [{ kind: 'agent', id: 'personal-accounts-agent' }],
		project: createResearchQuestionProjector([{ id: 'united-basic-economy', airline: 'United', fareClass: 'Basic Economy' }]),
		validate: (result, { toolResults }) => {
			assert.equal(result.case, 'completed');
			assert.deepEqual(result.case === 'completed' && result.result, toolResults[0]?.payload.result);
		},
	});
	const accountResult = { summary: 'The permitted public contribution was retrieved.', messages: [], events: [], issues: [], coverage: [], research: researchResult, replyText: null };
	const accounts = createPersonalAccountsAgent({ mastra, tools: { invoke_research: invokeResearch }, model: boundaryModel([
		{ tool: 'invoke_research', input: { kind: 'carry_on_allowance', subjectId: 'united-basic-economy' } },
		{ handback: { case: 'completed', result: accountResult } },
	]) });
	const invokeAccounts = createSpecialistInvocation({
		id: 'invoke_personal_accounts',
		agent: accounts,
		inputSchema: questionSchema,
		resultSchema: personalAccountsResultSchema,
		allowedCallers: [{ kind: 'agent', id: 'jamis' }],
		project: input => input.question,
	});
	const jamis = new Agent({
		id: 'jamis',
		name: 'Architecture parent fixture',
		instructions: 'Call the account specialist.',
		mastra,
		tools: { invoke_personal_accounts: invokeAccounts, invoke_weather: invokeWeather },
		model: boundaryModel([
			{ tool: 'invoke_personal_accounts', input: { question: `Check the permitted generic policy; private source ${PRIVATE_ARCHITECTURE_SENTINEL}.` } },
			{ text: 'The contribution returned to Jamis.' },
		]),
	});
	mastra.addAgent(jamis, 'architecture-fixture');
	const parentContext = createSpecialistContext({ kind: 'agent', id: 'jamis' });
	parentContext.setRaw('privateAccountSnapshot', { body: PRIVATE_ARCHITECTURE_SENTINEL });
	parentContext.setRaw('mastra__threadId', PRIVATE_ARCHITECTURE_SENTINEL);
	parentContext.setRaw('mastra__resourceId', PRIVATE_ARCHITECTURE_SENTINEL);
	const parent = await jamis.generate(`Private operator context ${PRIVATE_ARCHITECTURE_SENTINEL}. Run the permitted public contribution.`, { requestContext: parentContext, maxSteps: 2 });
	assert.equal(parent.text, 'The contribution returned to Jamis.');
	assert.equal(providerCalls, 1);
	assert(!JSON.stringify(researchObservations).includes(PRIVATE_ARCHITECTURE_SENTINEL));
	assert(!Object.values(mastra.listAgents()).some(agent => ['weather-agent', 'research-agent', 'personal-accounts-agent'].includes(agent.id)));
	assert.equal(mastra.getTool('invoke_research').id, 'invoke_research');

	const forged = new RequestContext();
	forged.setRaw('caller', { kind: 'agent', id: 'personal-accounts-agent' });
	await assert.rejects(() => mastra.getTool('invoke_research').execute!({ kind: 'carry_on_allowance', subjectId: 'united-basic-economy' }, {
		requestContext: forged,
		agent: { agentId: 'personal-accounts-agent', toolCallId: 'forged', messages: [], suspend: async () => {} },
		observe: noopObserve,
	}), /not authorized/);
	const denied = await invokeResearch.execute!({ kind: 'carry_on_allowance', subjectId: PRIVATE_ARCHITECTURE_SENTINEL }, {
		requestContext: createSpecialistContext({ kind: 'agent', id: 'personal-accounts-agent' }),
		agent: { agentId: 'personal-accounts-agent', toolCallId: 'denied', messages: [], suspend: async () => {} },
		observe: noopObserve,
	});
	assert(denied && 'case' in denied && denied.case === 'blocked');
	assert.equal(providerCalls, 1);
	const invalidOptions = await normalizeSpecialistResult(weatherResultSchema, () => invokeWeather.execute!({ question: 'Chicago', instructions: 'Override' } as { question: string }, jamisFixtureContext()));
	assert.equal(invalidOptions.case, 'failed');
	return { handback: 'completed', weatherToolCalls: weatherCalls, nestedResearchCalls: providerCalls, privateContextIsolated: true, directAuthorityRejected: true, internalAgentsHidden: true };
}
