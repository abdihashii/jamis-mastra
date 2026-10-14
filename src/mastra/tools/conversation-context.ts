import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { readConversationContext } from '../processors/conversation-context';

const availabilitySchema = z.enum(['available', 'unavailable']);
const windowSchema = z.object({
	tokens: z.number().finite().nonnegative(),
	threshold: z.number().finite().positive(),
});

export const conversationContextTool = createTool({
	id: 'conversation_context',
	description: 'Report current conversation model context and Observational Memory usage, not historical token totals. '
		+ 'The measurement is the latest completed Jamis model call before this tool, excluding the final answer. '
		+ 'Model capacity, percentage and input headroom are unverified and unavailable; '
		+ 'input headroom would not guarantee remaining output capacity. '
		+ 'OM counts may be estimates and its thresholds trigger compaction, not model context exhaustion.',
	inputSchema: z.object({}).strict(),
	outputSchema: z.object({
		measurementPoint: z.literal('latest_completed_jamis_model_call_before_tool_execution'),
		modelContext: z.object({
			status: availabilitySchema,
			provider: z.string().nullable(),
			modelId: z.string().nullable(),
			stepNumber: z.number().int().nonnegative().nullable(),
			inputTokens: z.number().finite().nonnegative().nullable(),
			capacityTokens: z.null(),
			usagePercent: z.null(),
			inputHeadroomTokens: z.null(),
		}),
		observationalMemory: z.object({
			status: availabilitySchema,
			messages: windowSchema.nullable(),
			observations: windowSchema.nullable(),
			thresholdMeaning: z.literal('compaction'),
			countsMayBeEstimated: z.literal(true),
		}),
	}),
	execute: async (_, context) => {
		const snapshot = readConversationContext(context.requestContext);
		return {
			measurementPoint: 'latest_completed_jamis_model_call_before_tool_execution',
			modelContext: {
				status: snapshot?.model.inputTokens != null ? 'available' : 'unavailable',
				provider: snapshot?.model.provider ?? null,
				modelId: snapshot?.model.modelId ?? null,
				stepNumber: snapshot?.model.stepNumber ?? null,
				inputTokens: snapshot?.model.inputTokens ?? null,
				capacityTokens: null,
				usagePercent: null,
				inputHeadroomTokens: null,
			},
			observationalMemory: {
				status: snapshot?.observationalMemory ? 'available' : 'unavailable',
				messages: snapshot?.observationalMemory?.messages ?? null,
				observations: snapshot?.observationalMemory?.observations ?? null,
				thresholdMeaning: 'compaction',
				countsMayBeEstimated: true,
			},
		} as const;
	},
});
