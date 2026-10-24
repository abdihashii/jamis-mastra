import { Agent } from '@mastra/core/agent';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createTool } from '@mastra/core/tools';
import { expect, test } from 'bun:test';
import { z } from 'zod';

test('the default stream executes a completed tool call before the model step finishes, exactly once', async () => {
	const started = Promise.withResolvers<void>();
	let modelFinished = false;
	let calls = 0;
	const probe = createTool({
		id: 'probe',
		description: 'Return a synthetic result.',
		inputSchema: z.object({}),
		outputSchema: z.object({ ok: z.boolean() }),
		execute: async () => {
			expect(modelFinished).toBe(false);
			calls += 1;
			started.resolve();
			return { ok: true };
		},
	});
	const model = new MastraLanguageModelV2Mock({
		doStream: async () => ({
			stream: new ReadableStream({
				async start(controller) {
					controller.enqueue({ type: 'stream-start', warnings: [] });
					controller.enqueue({ type: 'tool-call', toolCallId: 'call-1', toolName: 'probe', input: '{}' });
					await started.promise;
					modelFinished = true;
					controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
					controller.close();
				},
			}),
		}),
	});
	const agent = new Agent({ id: 'upgrade-probe', name: 'Upgrade probe', instructions: 'Call probe.', model, tools: { probe } });
	const output = await agent.stream('Run the probe.', { maxSteps: 1 });
	await output.consumeStream();
	const results = await output.toolResults;
	expect(calls).toBe(1);
	expect(results).toHaveLength(1);
	expect(results[0]?.payload.result).toEqual({ ok: true });
}, 3000);
