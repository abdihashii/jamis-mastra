import type { AnyExportedSpan } from '@mastra/core/observability';

import { expect, spyOn, test } from 'bun:test';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { MastraModelGateway } from '@mastra/core/llm';
import { SpanType, TracingEventType } from '@mastra/core/observability';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { Observability } from '@mastra/observability';
import { z } from 'zod';

import { createProjectLogger, filterProjectTrace, protectProjectSignals, spanOutputProcessors } from '../../observability';
import { createSpecialistInvocation, normalizeSpecialistResult } from '../../tools/invoke-specialist';
import { boundaryModel, jamisFixtureContext, PRIVATE_ARCHITECTURE_SENTINEL } from './specialist-boundary.fixture';

const inputSchema = z.object({ question: z.string() }).strict();
const resultSchema = z.object({ answer: z.string() }).strict();

test('constructor injection resolves the configured gateway, logger and tracing without inheriting memory', async () => {
	const spans: Array<{ type: string; span: AnyExportedSpan }> = [];
	const signals: unknown[] = [];
	const diagnostics: unknown[] = [];
	const errorOutput = spyOn(console, 'error').mockImplementation((...args) => {
		diagnostics.push(args);
	});
	const logger = createProjectLogger();
	const storage = new InMemoryStore();
	const observability = new Observability({ configs: { test: {
		serviceName: 'native-specialist-proof',
		spanOutputProcessors,
		spanFilter: filterProjectTrace,
		exporters: [protectProjectSignals({
			name: 'capture',
			onTracingEvent: (event) => { spans.push({ type: event.type, span: structuredClone(event.exportedSpan) }); },
			onLogEvent: (event) => { signals.push(structuredClone(event.log)); },
			onMetricEvent: (event) => { signals.push(structuredClone(event.metric)); },
			exportTracingEvent: async () => {},
			flush: async () => {},
			shutdown: async () => {},
		})],
	} } });
	let resolved = 0;
	const prompts: unknown[] = [];
	const model = boundaryModel([
		{ tool: 'read_fixture', input: {} },
		{ handback: { case: 'completed', result: { answer: 'Verified synthetic reading.' } } },
	], options => prompts.push(options));
	class FixtureGateway extends MastraModelGateway {
		readonly id = 'openai-codex';
		readonly name = 'Controlled configured gateway';
		async fetchProviders() { return { 'openai-codex': { name: this.name, gateway: this.id, apiKeyEnvVar: '', models: ['gpt-6-luna'] } }; }
		async buildUrl() { return undefined; }
		async getApiKey() { return 'fixture'; }
		async resolveLanguageModel({ modelId }: { modelId: string }) {
			expect(modelId).toBe('gpt-6-luna');
			resolved++;
			return model;
		}
	}
	const mastra = new Mastra({ storage, logger, observability, gateways: { 'openai-codex': new FixtureGateway() } });
	try {
		await storage.init();
		const memory = (await storage.getStore('memory'))!;
		await memory.saveThread({ thread: { id: 'private-thread', resourceId: 'private-resource', createdAt: new Date(), updatedAt: new Date() } });
		await memory.saveMessages({ messages: [{ id: 'private-message', threadId: 'private-thread', resourceId: 'private-resource', role: 'user', type: 'text', createdAt: new Date(), content: { format: 2, parts: [{ type: 'text', text: PRIVATE_ARCHITECTURE_SENTINEL }] } }] });
		let toolCalls = 0;
		const read = createTool({
			id: 'read_fixture',
			description: 'Read a synthetic fixture.',
			inputSchema: z.object({}).strict(),
			execute: async (_, context) => {
				toolCalls++;
				expect([...context.requestContext.entries()]).not.toContainEqual(['private', PRIVATE_ARCHITECTURE_SENTINEL]);
				logger.error(PRIVATE_ARCHITECTURE_SENTINEL, { private: PRIVATE_ARCHITECTURE_SENTINEL });
				return { answer: 'Verified synthetic reading.' };
			},
		});
		const agent = new Agent({ id: 'weather-agent', name: 'Native services fixture', mastra, instructions: 'Read the synthetic tool, then return structured handback.', model: 'openai-codex/gpt-6-luna', tools: { read_fixture: read }, memory: new Memory({ storage, options: { semanticRecall: false, workingMemory: { enabled: false }, lastMessages: 10 } }) });
		const invoke = createSpecialistInvocation({ id: 'invoke_weather', agent, inputSchema, resultSchema, allowedCallers: [{ kind: 'agent', id: 'jamis' }], project: input => input.question });
		const context = jamisFixtureContext();
		context.requestContext!.setRaw('MastraMemory', { thread: { id: 'private-thread' }, resourceId: 'private-resource' });
		context.requestContext!.setRaw('mastra__threadId', 'private-thread');
		context.requestContext!.setRaw('mastra__resourceId', 'private-resource');
		context.requestContext!.setRaw('private', PRIVATE_ARCHITECTURE_SENTINEL);
		expect(await invoke.execute!({ question: 'Read synthetic public evidence.' }, context)).toMatchObject({ case: 'completed' });
		expect(resolved).toBeGreaterThan(0);
		expect(toolCalls).toBe(1);
		expect(JSON.stringify(prompts)).not.toContain(PRIVATE_ARCHITECTURE_SENTINEL);
		expect((await memory.listMessages({ threadId: 'private-thread' })).total).toBe(1);
		await observability.getInstance('test')!.flush();
		expect(JSON.stringify({ spans, signals, diagnostics })).not.toContain(PRIVATE_ARCHITECTURE_SENTINEL);
		expect(diagnostics.length).toBeGreaterThan(0);
		expect(spans.some(event => event.type === TracingEventType.SPAN_STARTED && event.span.entityId === 'weather-agent')).toBe(true);
		expect(spans.some(event => event.span.type === SpanType.TOOL_CALL)).toBe(true);
		expect(spans.some(event => event.span.type === SpanType.MODEL_GENERATION)).toBe(true);
	}
	finally {
		errorOutput.mockRestore();
		await observability.getInstance('test')!.shutdown();
	}
});

test('native missing structured output fails without prose recovery', async () => {
	const agent = new Agent({ id: 'weather-agent', name: 'Missing object fixture', mastra: new Mastra(), instructions: 'Return a handback.', model: boundaryModel([{ text: 'Unstructured prose.' }]) });
	const invoke = createSpecialistInvocation({ id: 'invoke_weather', agent, inputSchema, resultSchema, allowedCallers: [{ kind: 'agent', id: 'jamis' }], project: input => input.question });
	expect(await normalizeSpecialistResult(resultSchema, () => invoke.execute!({ question: 'Bounded task.' }, jamisFixtureContext()))).toMatchObject({ case: 'failed', progress: null });
});

test('in-flight cancellation with a custom reason remains cancellation', async () => {
	const abort = new AbortController();
	const agent = new Agent({ id: 'weather-agent', name: 'Cancellation fixture', mastra: new Mastra(), instructions: 'Return a handback.', model: boundaryModel([{ handback: { case: 'completed', result: { answer: 'Late result.' } } }], () => abort.abort(new Error('Operator canceled'))) });
	const invoke = createSpecialistInvocation({ id: 'invoke_weather', agent, inputSchema, resultSchema, allowedCallers: [{ kind: 'agent', id: 'jamis' }], project: input => input.question });
	await expect(normalizeSpecialistResult(resultSchema, () => invoke.execute!({ question: 'Bounded task.' }, { ...jamisFixtureContext(), abortSignal: abort.signal }))).rejects.toThrow();
});
