import type { Processor } from '@mastra/core/processors';

import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { expect, spyOn, test } from 'bun:test';
import { z } from 'zod';

import { createConversationContextProcessor, readConversationContext } from '../conversation-context';

const windows = {
	messages: { tokens: 123, threshold: 30000 },
	observations: { tokens: 456, threshold: 40000 },
};

function statusEmitter(threadId: string, invalid = false) {
	return {
		id: 'fixture_om_status',
		processInputStep: async ({ writer, stepNumber, messageList }) => {
			await writer?.custom({
				type: 'data-om-status',
				transient: true,
				data: {
					threadId,
					stepNumber,
					windows: { active: invalid ? { ...windows, messages: { tokens: -1, threshold: 0 } } : windows },
					observations: 'PRIVATE_OBSERVATIONS_SENTINEL',
				},
			});
			return messageList;
		},
	} satisfies Processor;
}

function modelFixture(tokens: Array<number | undefined>, beforeReply?: () => Promise<void>) {
	let step = 0;
	async function next() {
		await beforeReply?.();
		const inputTokens = tokens[step];
		const call = step++;
		return {
			call,
			callsTool: call < tokens.length - 1,
			usage: {
				inputTokens,
				outputTokens: 1,
				totalTokens: inputTokens === undefined ? undefined : inputTokens + 1,
			},
		};
	}
	return new MastraLanguageModelV2Mock({
		provider: 'fixture-provider',
		modelId: 'fixture-model',
		doGenerate: async () => {
			const { call, callsTool, usage } = await next();
			return {
				content: callsTool
					? [{ type: 'tool-call', toolCallId: `call-${call}`, toolName: 'inspect_context', input: '{}' }]
					: [{ type: 'text', text: 'Fixture answer.' }],
				finishReason: callsTool ? 'tool-calls' : 'stop',
				usage,
				warnings: [],
			};
		},
		doStream: async () => {
			const { call, callsTool, usage } = await next();
			return { stream: new ReadableStream({ start(controller) {
				controller.enqueue({ type: 'stream-start', warnings: [] });
				if (callsTool) {
					controller.enqueue({ type: 'tool-call', toolCallId: `call-${call}`, toolName: 'inspect_context', input: '{}' });
				} else {
					controller.enqueue({ type: 'text-start', id: 'reply' });
					controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'Fixture answer.' });
					controller.enqueue({ type: 'text-end', id: 'reply' });
				}
				controller.enqueue({ type: 'finish', finishReason: callsTool ? 'tool-calls' : 'stop', usage });
				controller.close();
			} }) };
		},
	});
}

async function runFixture(options: {
	mode?: 'generate' | 'stream';
	tokens?: Array<number | undefined>;
	emitStatus?: ReturnType<typeof statusEmitter>;
	memory?: Memory;
	capture?: boolean;
	requestContext?: RequestContext;
	beforeReply?: () => Promise<void>;
	onTool?: () => Promise<void>;
} = {}) {
	const requestContext = options.requestContext ?? new RequestContext();
	const snapshots: unknown[] = [];
	const capture = createConversationContextProcessor();
	const inspect = createTool({
		id: 'inspect_context',
		description: 'Inspect request-local context in a deterministic fixture.',
		inputSchema: z.object({}),
		execute: async (_, context) => {
			snapshots.push(structuredClone(readConversationContext(context.requestContext)));
			await options.onTool?.();
			return { inspected: true };
		},
	});
	const agent = new Agent({
		id: 'context_fixture',
		name: 'Context fixture',
		instructions: 'Inspect context, then answer.',
		model: modelFixture(options.tokens ?? [111, 222], options.beforeReply),
		memory: options.memory,
		tools: { inspect_context: inspect },
		inputProcessors: [
			...options.emitStatus ? [options.emitStatus] : [],
			...options.capture === false ? [] : [capture],
		],
		outputProcessors: options.capture === false ? [] : [capture],
	});
	const runOptions = {
		requestContext,
		maxSteps: 5,
		...options.memory ? { memory: { thread: 'fixture-thread', resource: 'fixture-resource' } } : {},
	};
	if (options.mode === 'stream') {
		const result = await agent.stream('PRIVATE_MESSAGE_SENTINEL', runOptions);
		await result.consumeStream();
	} else {
		await agent.generate('PRIVATE_MESSAGE_SENTINEL', runOptions);
	}
	return { snapshots, requestContext };
}

for (const mode of ['generate', 'stream'] as const) {
	test(`${mode}: captures latest step, model identity and numeric OM before local tool execution`, async () => {
		const requestContext = new RequestContext();
		requestContext.setRaw('MastraMemory', { thread: { id: 'fixture-thread' } });
		const { snapshots } = await runFixture({
			mode,
			tokens: [111, 222, 333],
			requestContext,
			emitStatus: statusEmitter('fixture-thread'),
		});
		expect(snapshots).toEqual([111, 222].map((inputTokens, stepNumber) => ({
			model: { provider: 'fixture-provider', modelId: 'fixture-model', stepNumber, inputTokens, capacityTokens: null },
			observationalMemory: windows,
		})));
		expect(JSON.stringify(snapshots)).not.toContain('PRIVATE_');
		expect(readConversationContext(requestContext)).toBeUndefined();
	});

	test(`${mode}: missing provider usage stays unavailable while zero remains zero`, async () => {
		const { snapshots } = await runFixture({ mode, tokens: [undefined, 0, 1] });
		expect(snapshots).toMatchObject([
			{ model: { inputTokens: null }, observationalMemory: null },
			{ model: { inputTokens: 0 }, observationalMemory: null },
		]);
	});

	test(`${mode}: native Observational Memory status needs no extra reads or writes`, async () => {
		async function nativeRun(capture: boolean) {
			const storage = new InMemoryStore();
			await storage.init();
			const memory = new Memory({ storage, options: {
				semanticRecall: false,
				workingMemory: { enabled: false },
				observationalMemory: {
					model: modelFixture([1]),
					scope: 'thread',
					retrieval: false,
					observation: { messageTokens: 30000, bufferTokens: false },
					reflection: { observationTokens: 40000 },
				},
			} });
			const domain = (await storage.getStore('memory'))!;
			const engine = (await memory.omEngine)!;
			const statusReads = spyOn(engine, 'getStatus');
			const recordReads = spyOn(engine, 'getOrCreateRecord');
			const writes = [
				spyOn(domain, 'setPendingMessageTokens'),
				spyOn(domain, 'saveMessages'),
				spyOn(domain, 'saveThread'),
				spyOn(domain, 'insertObservationalMemoryRecord'),
			];
			try {
				const run = await runFixture({ mode, memory, capture });
				await memory.settled();
				return {
					snapshots: run.snapshots,
					calls: [
						statusReads.mock.calls.length,
						recordReads.mock.calls.length,
						...writes.map(write => write.mock.calls.length),
					],
				};
			} finally {
				statusReads.mockRestore();
				recordReads.mockRestore();
				for (const write of writes)
					write.mockRestore();
			}
		}
		const baseline = await nativeRun(false);
		const captured = await nativeRun(true);
		expect(captured.calls).toEqual(baseline.calls);
		expect(captured.snapshots).toMatchObject([{ model: { inputTokens: 111 }, observationalMemory: {
			messages: { tokens: expect.any(Number), threshold: 30000 },
			observations: { tokens: 0, threshold: 40000 },
		} }]);
		expect(JSON.stringify(captured.snapshots)).not.toContain('PRIVATE_');
	});
}

test('OM status from another session or with invalid numbers is unavailable', async () => {
	for (const emitter of [statusEmitter('another-thread'), statusEmitter('fixture-thread', true)]) {
		const requestContext = new RequestContext();
		requestContext.setRaw('MastraMemory', { thread: { id: 'fixture-thread' } });
		const { snapshots } = await runFixture({ requestContext, emitStatus: emitter });
		expect(snapshots).toMatchObject([{ model: { inputTokens: 111 }, observationalMemory: null }]);
	}
	expect(readConversationContext()).toBeUndefined();
});

test('concurrent requests and nested specialist calls cannot overwrite Jamis usage', async () => {
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	const outerContext = new RequestContext();
	await Promise.all([
		runFixture({ requestContext: outerContext, tokens: [100, 101], onTool: async () => {
			const nested = await runFixture({ tokens: [900, 901] });
			expect(nested.snapshots).toMatchObject([{ model: { inputTokens: 900 } }]);
			expect(readConversationContext(outerContext)?.model.inputTokens).toBe(100);
			release();
		} }),
		runFixture({ tokens: [200, 201], beforeReply: () => ready, onTool: async () => {
			expect(readConversationContext(outerContext)?.model.inputTokens).not.toBe(200);
		} }),
	]);
	expect(readConversationContext(outerContext)).toBeUndefined();
});
