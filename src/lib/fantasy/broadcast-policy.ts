import type { ProcessOutputStepArgs, ProcessOutputStreamArgs } from '@mastra/core/processors';
import { z } from 'zod';

export const savedReportDeliveryArgumentsSchema = z.object({}).strict();

export const FANTASY_BROADCAST_MODEL = 'openai-codex/gpt-6-luna' as const;
export const FANTASY_PUBLICATION_WORKFLOW_ID = 'publish_fantasy_recap' as const;
export const SAVED_REPORT_DELIVERY_TOOL_ID = 'deliver_saved_report' as const;
export const FANTASY_BROADCAST_LIMITS = Object.freeze({ steps: 2, callMs: 120_000 });

export function fantasyBroadcastDefaults() {
	return {
		maxSteps: FANTASY_BROADCAST_LIMITS.steps,
		toolCallConcurrency: 1,
		modelSettings: {
			maxRetries: 0,
			timeout: { totalMs: FANTASY_BROADCAST_LIMITS.callMs, stepMs: FANTASY_BROADCAST_LIMITS.callMs },
		},
		providerOptions: { openai: { reasoningEffort: 'max', parallelToolCalls: false } },
		tracingOptions: { hideInput: true, hideOutput: true },
		outputProcessors: [{
			id: 'validate_saved_report_delivery_args',
			processOutputStream: async ({ part, abort }: ProcessOutputStreamArgs) => {
				if (part.type === 'tool-call' && part.payload.toolName === SAVED_REPORT_DELIVERY_TOOL_ID
					&& !savedReportDeliveryArgumentsSchema.safeParse(part.payload.args).success) {
					abort('Broadcaster delivery arguments are invalid.');
				}
				return part;
			},
			// Disable eager tools and validate again before any buffered calls execute.
			processOutputStep: ({ toolCalls, messageList }: ProcessOutputStepArgs) => {
				if (toolCalls?.some(call => call.toolName === SAVED_REPORT_DELIVERY_TOOL_ID
					&& !savedReportDeliveryArgumentsSchema.safeParse(call.args).success)) {
					throw new Error('Broadcaster delivery arguments are invalid.');
				}
				return messageList;
			},
		}],
		prepareStep: ({ stepNumber }: { stepNumber: number }) => stepNumber === 0
			? { activeTools: [SAVED_REPORT_DELIVERY_TOOL_ID], toolChoice: 'required' as const }
			: { activeTools: [], toolChoice: 'none' as const },
	};
}
