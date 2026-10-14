import type { Processor } from '@mastra/core/processors';

import { createOpenAI } from '@ai-sdk/openai';
import { Mastra } from '@mastra/core';
import { expect, test } from 'bun:test';

if (!process.env.JAMIS_PROVIDER_SCHEMA_TEST) {
	test('production tool schemas reach the Responses SDK with object roots', async () => {
		const child = Bun.spawn([process.execPath, '--no-env-file', 'test', import.meta.path], {
			env: {
				...process.env,
				JAMIS_PROVIDER_SCHEMA_TEST: '1',
				JAMIS_ALLOWED_NUMBER: '+15555550101',
				SENDBLUE_WEBHOOK_SECRET: 'fixture',
				SENDBLUE_API_KEY: 'fixture',
				SENDBLUE_API_SECRET: 'fixture',
				SENDBLUE_FROM_NUMBER: '+15555550100',
				OPEN_WEATHER_API_KEY: 'fixture',
				FIRECRAWL_API_KEY: 'fc-fixture',
				PERPLEXITY_API_KEY: 'pplx-fixture',
				GOOGLE_CLIENT_ID: 'fixture',
				GOOGLE_CLIENT_SECRET: 'fixture',
				OPERATOR_TIMEZONE: 'UTC',
				PROJECT_VIEW_PATH: '',
			},
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 30_000,
		});
		const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		expect({ exit, output: exit ? stdout + stderr : '' }).toEqual({ exit: 0, output: '' });
	}, 35_000);
} else {
	globalThis.fetch = Object.assign(async () => {
		throw new Error('Unexpected network access in provider schema fixture.');
	}, { preconnect() {} });
	const { createJamisAgent } = await import('../jamis');
	const { forcingStoreFalse } = await import('../../gateways/openai-codex-gateway');
	const { applyCodexBodyRules } = await import('../../gateways/openai-codex-auth');
	const { readConversationContext } = await import('../../processors/conversation-context');
	const { boundaryModel } = await import('./specialist-boundary.fixture');
	const { createTool } = await import('@mastra/core/tools');
	const { RequestContext } = await import('@mastra/core/request-context');
	const { MastraLanguageModelV2Mock } = await import('@mastra/core/test-utils/llm-mock');
	const { z } = await import('zod');

	for (const mode of ['generate', 'stream'] as const) {
		test(`${mode}: production Jamis captures usage before its direct tool executes`, async () => {
			const snapshots: unknown[] = [];
			const model = boundaryModel([{ tool: 'inspect_context', input: {} }, { text: 'Fixture answer.' }]);
			const jamis = createJamisAgent({
				mastra: new Mastra({ logger: false }),
				model,
				memory: undefined,
				workspace: undefined,
				channels: undefined,
				tools: { inspect_context: createTool({
					id: 'inspect_context',
					description: 'Inspect the current fixture request.',
					inputSchema: z.object({}),
					execute: async (_, context) => {
						snapshots.push(readConversationContext(context.requestContext));
						return { inspected: true };
					},
				}) },
				specialists: { weather: { model }, research: { model }, personalAccounts: { model } },
			});
			if (mode === 'stream') {
				const result = await jamis.stream('Inspect context.');
				await result.consumeStream();
			} else {
				await jamis.generate('Inspect context.');
			}
			expect(snapshots).toEqual([{
				model: {
					provider: model.provider,
					modelId: model.modelId,
					stepNumber: 0,
					inputTokens: 1,
					capacityTokens: null,
				},
				observationalMemory: null,
			}]);
		});

		test(`${mode}: production Jamis reports context through its actual registered tool`, async () => {
			const script = boundaryModel([
				{ tool: 'conversation_context', input: {} },
				{ text: 'Fixture answer, not the reporting assertion.' },
			]);
			let step = 0;
			const usage = () => {
				const inputTokens = [222, 333][step++]!;
				return { inputTokens, outputTokens: 7, totalTokens: inputTokens + 7 };
			};
			const model = new MastraLanguageModelV2Mock({
				provider: 'fixture-provider',
				modelId: 'fixture-model',
				doGenerate: async options => ({ ...await script.doGenerate(options), usage: usage() }),
				doStream: async (options) => {
					const result = await script.doStream(options);
					const measuredUsage = usage();
					return {
						...result,
						stream: result.stream.pipeThrough(new TransformStream({
							transform(part, controller) {
								controller.enqueue(part.type === 'finish' ? { ...part, usage: measuredUsage } : part);
							},
						})),
					};
				},
			});
			const jamis = createJamisAgent({
				mastra: new Mastra({ logger: false }),
				model,
				memory: undefined,
				workspace: undefined,
				channels: undefined,
				specialists: { weather: { model }, research: { model }, personalAccounts: { model } },
			});
			const requestContext = new RequestContext();
			requestContext.setRaw('MastraMemory', { thread: { id: 'fixture-thread' } });
			const emitStatus = {
				id: 'fixture_context_om_status',
				processInputStep: async ({ writer, stepNumber, messageList }) => {
					await writer?.custom({
						type: 'data-om-status',
						transient: true,
						data: {
							threadId: 'fixture-thread',
							stepNumber,
							windows: { active: {
								messages: { tokens: 123, threshold: 30000 },
								observations: { tokens: 456, threshold: 40000 },
							} },
							observations: 'PRIVATE_OBSERVATIONS_SENTINEL',
						},
					});
					return messageList;
				},
			} satisfies Processor;
			const options = {
				requestContext,
				inputProcessors: [...await jamis.listConfiguredInputProcessors(requestContext), emitStatus],
			};
			const tools = await jamis.listTools({ requestContext });
			const contextTool = Object.entries(tools).find(([name]) => name === 'conversation_context')?.[1];
			expect(contextTool, 'Missing production conversation_context registration.').toBeDefined();
			expect(contextTool!.id as string).toBe('conversation_context');
			let results;
			if (mode === 'generate') {
				results = (await jamis.generate('How much context are we using? PRIVATE_MESSAGE_SENTINEL', options)).toolResults;
			} else {
				const result = await jamis.stream('How much context are we using? PRIVATE_MESSAGE_SENTINEL', options);
				await result.consumeStream();
				results = await result.toolResults;
			}
			expect(results).toHaveLength(1);
			expect(results[0]!.payload.toolName).toBe('conversation_context');
			expect(results[0]!.payload.result).toEqual({
				measurementPoint: 'latest_completed_jamis_model_call_before_tool_execution',
				modelContext: {
					status: 'available',
					provider: 'fixture-provider',
					modelId: 'fixture-model',
					stepNumber: 0,
					inputTokens: 222,
					capacityTokens: null,
					usagePercent: null,
					inputHeadroomTokens: null,
				},
				observationalMemory: {
					status: 'available',
					messages: { tokens: 123, threshold: 30000 },
					observations: { tokens: 456, threshold: 40000 },
					thresholdMeaning: 'compaction',
					countsMayBeEstimated: true,
				},
			});
			expect(JSON.stringify(results[0]!.payload.result)).not.toContain('PRIVATE_');
			expect(readConversationContext(requestContext)).toBeUndefined();
		});

		test(`${mode}: repeated reporting uses the latest Jamis step instead of aggregate usage`, async () => {
			const model = boundaryModel([
				{ tool: 'conversation_context', input: {} },
				{ tool: 'conversation_context', input: {} },
				{ text: 'Fixture answer.' },
			]);
			const jamis = createJamisAgent({
				mastra: new Mastra({ logger: false }),
				model,
				memory: undefined,
				workspace: undefined,
				channels: undefined,
				specialists: { weather: { model }, research: { model }, personalAccounts: { model } },
			});
			let results;
			if (mode === 'generate') {
				results = (await jamis.generate('Report current context twice.')).toolResults;
			} else {
				const result = await jamis.stream('Report current context twice.');
				await result.consumeStream();
				results = await result.toolResults;
			}
			expect(results).toHaveLength(2);
			expect(results.map(result => result.payload.result)).toMatchObject([
				{ modelContext: { status: 'available', stepNumber: 0, inputTokens: 1 } },
				{ modelContext: { status: 'available', stepNumber: 1, inputTokens: 1 } },
			]);
			const instructions = await jamis.getInstructions();
			expect(instructions).toEqual(expect.stringContaining('call conversation_context directly'));
			expect(instructions).toEqual(expect.stringContaining('historical token usage'));
			expect(instructions).toEqual(expect.stringContaining('call checkMonitoring with the application scope'));
		});
	}

	test('the first weather request includes only object-root function schemas', async () => {
		const requests: Array<{ tools: Array<{ type: string; name: string; description: string; parameters: Record<string, unknown> }> }> = [];
		const model = forcingStoreFalse(createOpenAI({
			name: 'openai-codex',
			baseURL: 'https://schema-fixture.invalid',
			apiKey: 'fixture',
			fetch: Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
				requests.push(applyCodexBodyRules(JSON.parse(init!.body as string)) as typeof requests[number]);
				throw new DOMException('Request captured without transport.', 'AbortError');
			}, { preconnect() {} }),
		}).responses('gpt-6.1-sol'));
		const jamis = createJamisAgent({
			mastra: new Mastra({ logger: false }),
			model,
			memory: undefined,
			workspace: undefined,
			channels: undefined,
			specialists: { weather: { model }, research: { model }, personalAccounts: { model } },
		});
		await jamis.generate('What is the weather outside?', { maxSteps: 1 }).catch(() => undefined);
		expect(requests).toHaveLength(1);
		const functions = requests[0]!.tools.filter(tool => tool.type === 'function');
		expect(functions.map(tool => tool.name)).toEqual(expect.arrayContaining(['invoke_weather', 'invoke_research', 'invoke_personal_accounts']));
		for (const tool of functions) {
			expect({ name: tool.name, type: tool.parameters.type }).toEqual({ name: tool.name, type: 'object' });
			expect(tool.parameters.anyOf).toBeUndefined();
			expect(tool.parameters.oneOf).toBeUndefined();
		}
		const context = functions.find(tool => tool.name === 'conversation_context');
		expect(context, 'Missing conversation_context schema in the actual Responses SDK request.').toBeDefined();
		expect(context!.parameters).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
		expect(Object.keys(context!.parameters.properties as Record<string, unknown>)).toEqual([]);
		const weather = functions.find(tool => tool.name === 'invoke_weather')!;
		expect(weather.description).toContain('current conditions');
		expect(weather.description).toContain('future-date forecasts');
		const assignment = weather.parameters.properties as Record<string, { description: string }>;
		expect(assignment.continueClarification!.description).toContain('immediately preceding active-session input need');
		expect(assignment.question!.description).toContain('original task');
		const research = functions.find(tool => tool.name === 'invoke_research')!;
		const selectors = research.parameters.properties as Record<string, { description: string }>;
		expect(selectors.kind!.description).toContain('never a private or mixed account task');
		expect(selectors.subjectId!.description).toContain('Never supply private text');
		expect(functions.find(tool => tool.name === 'invoke_personal_accounts')!.description).toContain('read-only Gmail');
		expect(functions.find(tool => tool.name === 'invoke_fantasy_broadcast')!.description).toContain('one-off message');
	});
}
