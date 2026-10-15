import type { Processor } from '@mastra/core/processors';
import type { RequestContext } from '@mastra/core/request-context';

import { z } from 'zod';

const sessionSchema = z.object({ thread: z.object({ id: z.string().min(1) }) });
const windowSchema = z.object({ tokens: z.number().finite().nonnegative(), threshold: z.number().finite().positive() });
const omStatusSchema = z.object({
	threadId: z.string().min(1),
	stepNumber: z.number().int().nonnegative(),
	windows: z.object({ active: z.object({ messages: windowSchema, observations: windowSchema }) }),
});

type MemoryWindows = z.infer<typeof omStatusSchema>['windows']['active'];

export interface ConversationContextSnapshot {
	model: {
		provider: string | null;
		modelId: string | null;
		stepNumber: number;
		inputTokens: number | null;
		capacityTokens: null;
	};
	observationalMemory: MemoryWindows | null;
}

interface ContextState {
	model?: Omit<ConversationContextSnapshot['model'], 'inputTokens' | 'capacityTokens'>;
	om?: z.infer<typeof omStatusSchema>;
}

const snapshots = new WeakMap<RequestContext, ConversationContextSnapshot>();

export function readConversationContext(requestContext?: RequestContext): ConversationContextSnapshot | undefined {
	return requestContext && snapshots.get(requestContext);
}

export function createConversationContextProcessor() {
	return {
		id: 'conversation_context',
		processDataParts: true,
		processInput: ({ requestContext, messageList }) => {
			if (requestContext)
				snapshots.delete(requestContext);
			return messageList;
		},
		processOutputStream: async ({ part, state, requestContext }) => {
			if (part.type === 'data-om-status') {
				const session = sessionSchema.safeParse(requestContext?.getRaw('MastraMemory'));
				const status = omStatusSchema.safeParse('data' in part ? part.data : undefined);
				// Native OM emits before each model call; retain only this session's numeric windows.
				const sameSession = session.success && status.success
					&& session.data.thread.id === status.data.threadId;
				(state as ContextState).om = sameSession
					? status.data
					: undefined;
			}
			return part;
		},
		processLLMRequest: ({ model, stepNumber, state, requestContext }) => {
			const capture = state as ContextState;
			capture.model = { provider: model.provider ?? null, modelId: model.modelId ?? null, stepNumber };
			if (capture.om?.stepNumber !== stepNumber)
				capture.om = undefined;
			if (requestContext)
				snapshots.delete(requestContext);
		},
		processOutputStep: ({ usage, stepNumber, state, requestContext, messageList }) => {
			const capture = state as ContextState;
			if (requestContext && capture.model?.stepNumber === stepNumber) {
				const inputTokens = usage.inputTokens;
				snapshots.set(requestContext, {
					model: {
						...capture.model,
						inputTokens: typeof inputTokens === 'number' && Number.isFinite(inputTokens) && inputTokens >= 0 ? inputTokens : null,
						// The Codex gateway does not declare a verified model context capacity.
						capacityTokens: null,
					},
					observationalMemory: capture.om?.windows.active ?? null,
				});
			}
			return messageList;
		},
		processOutputResult: ({ requestContext, messageList }) => {
			if (requestContext)
				snapshots.delete(requestContext);
			return messageList;
		},
	} satisfies Processor;
}
