import type { GatewayLanguageModel } from '@mastra/core/llm';
import { Mastra } from '@mastra/core';
import { MastraModelGateway } from '@mastra/core/llm';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';

export interface EditorialModelInput { role: 'writer' | 'reviewer'; data: Record<string, any>; options: any }
export function editorialFixtureRuntime(
	respond: (input: EditorialModelInput) => unknown | Promise<unknown>,
	config: Pick<NonNullable<ConstructorParameters<typeof Mastra>[0]>, 'storage' | 'observability'> = {},
) {
	const calls: EditorialModelInput[] = [];
	const resolved: string[] = [];
	async function reply(options: any) {
		const system = options.prompt.filter((row: any) => row.role === 'system').map((row: any) => row.content).join('\n');
		const message = options.prompt.filter((row: any) => row.role === 'user').at(-1);
		const text = typeof message.content === 'string'
			? message.content
			: message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
		const input: EditorialModelInput = { role: system.includes('You are the Fantasy Football Editor') ? 'reviewer' : 'writer', data: JSON.parse(text), options };
		calls.push(input);
		return JSON.stringify({ handback: await respond(input) });
	}
	const model = new MastraLanguageModelV2Mock({
		doGenerate: async options => ({ content: [{ type: 'text', text: await reply(options) }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }),
		doStream: async (options) => {
			const text = await reply(options);
			return { stream: new ReadableStream({ start(controller) {
				controller.enqueue({ type: 'stream-start', warnings: [] });
				controller.enqueue({ type: 'text-start', id: 'reply' });
				controller.enqueue({ type: 'text-delta', id: 'reply', delta: text });
				controller.enqueue({ type: 'text-end', id: 'reply' });
				controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
				controller.close();
			} }) };
		},
	});
	class FixtureGateway extends MastraModelGateway {
		readonly id = 'openai-codex';
		readonly name = 'Editorial fixture';
		fetchProviders() {
			return Promise.resolve({ 'openai-codex': { name: 'Editorial fixture', gateway: 'openai-codex', apiKeyEnvVar: '', models: ['gpt-6-astra'], npm: '@ai-sdk/openai' } });
		}

		buildUrl() { return undefined; }
		getApiKey() { return Promise.resolve('fixture'); }
		resolveLanguageModel({ modelId }: { modelId: string }): Promise<GatewayLanguageModel> {
			resolved.push(modelId);
			return Promise.resolve(model);
		}
	}
	return { runtime: new Mastra({ ...config, logger: false, gateways: { fixture: new FixtureGateway() } }), calls, resolved };
}
export function passingEditorialReview(data: Record<string, any>) {
	return { case: 'completed', result: { evidenceId: data.evidence.evidenceId, candidateId: data.candidate.id, verdict: 'pass', issues: [] } };
}
