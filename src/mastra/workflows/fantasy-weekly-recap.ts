import { createStep, createWorkflow } from '@mastra/core/workflows';

import { z } from 'zod';

import { getFantasyConfig } from '../../fantasy/config';
import { runDailyRecap } from '../../fantasy/daily';

const outcomeSchema = z.object({
	outcome: z.union([
		z.enum(['sent', 'failed', 'delivery_unknown', 'noop-already-sent', 'noop-no-completed-week', 'blocked-active-claim', 'blocked-delivery-unknown']),
		z.enum(['skipped-unconfigured', 'error']),
	]),
	week: z.number().nullable(),
	error: z.string().optional(),
});

const weeklyRecapStep = createStep({
	id: 'weekly-recap',
	inputSchema: z.object({}),
	outputSchema: outcomeSchema,
	execute: async ({ mastra, tracingContext }) => {
		const started = Date.now();
		const outcome = await runDailyRecap(getFantasyConfig(), mastra!, {
			traceId: tracingContext?.currentSpan?.externalTraceId,
		});
		// Structured, content-free: league/week/status/duration make traces; never text or numbers of people.
		mastra?.getLogger()?.info('[fantasy-recap] daily run', {
			outcome: outcome.outcome,
			week: outcome.week,
			durationMs: Date.now() - started,
		});
		return outcomeSchema.parse(outcome);
	},
});

/**
 * 10:00 America/Chicago daily. The coordinator inside `runDailyRecap` translates
 * a fire into exactly one of the durable-state outcomes; days with no newly
 * completed week are quiet no-ops.
 */
export const fantasyWeeklyRecapWorkflow = createWorkflow({
	id: 'fantasy-weekly-recap',
	inputSchema: z.object({}),
	outputSchema: outcomeSchema,
	schedule: {
		cron: '0 10 * * *',
		timezone: getFantasyConfig()?.recapTimezone ?? 'America/Chicago',
		inputData: {},
	},
}).then(weeklyRecapStep).commit();
