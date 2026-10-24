import { SpanType } from '@mastra/core/observability';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { getFantasyConfig } from '../../lib/fantasy/config';
import { runDailyRecap } from '../../lib/fantasy/daily';

const outcomeSchema = z.object({
	outcome: z.union([
		z.enum(['sent', 'failed', 'delivery_unknown', 'noop-already-sent', 'noop-no-completed-week', 'blocked-active-claim', 'blocked-delivery-unknown']),
		z.enum(['skipped-unconfigured', 'error']),
	]),
	week: z.number().nullable(),
	error: z.string().regex(/^[a-z][a-z0-9_:.-]{0,99}$/).optional(),
	reason: z.string().regex(/^[a-z][a-z0-9_:.-]{0,99}$/).optional(),
	generatorVersion: z.literal('fantasy-recap-v13').optional(),
	attemptId: z.uuid().optional(),
	reportId: z.string().regex(/^report-[a-f0-9]{64}$/).optional(),
	counts: z
		.object({
			nfl: z.number().int().min(0).max(3),
			drafts: z.number().int().min(0).max(3),
			reviews: z.number().int().min(0).max(3),
		})
		.strict()
		.optional(),
}).strict();

const weeklyRecapStep = createStep({
	id: 'weekly-recap',
	inputSchema: z.object({}),
	outputSchema: outcomeSchema,
	execute: async ({ mastra, tracingContext }) => {
		const started = Date.now();
		const currentSpan = tracingContext?.currentSpan;
		const attemptSpan = currentSpan ?? mastra?.observability.getDefaultInstance()?.startSpan({
			name: 'fantasy-weekly-recap-attempt',
			type: SpanType.WORKFLOW_RUN,
			entityId: 'fantasy-weekly-recap',
		});
		let outcome: Awaited<ReturnType<typeof runDailyRecap>>;
		try {
			outcome = await runDailyRecap(getFantasyConfig(), mastra!, {
				traceId: attemptSpan?.externalTraceId,
				tracingContext: attemptSpan ? { currentSpan: attemptSpan } : undefined,
			});
		} finally {
			if (!currentSpan)
				attemptSpan?.end();
		}
		// Structured, content-free: league/week/status/duration make traces; never text or numbers of people.
		mastra?.getLogger()?.info('[fantasy-recap] daily run', {
			outcome: outcome.outcome,
			week: outcome.week,
			durationMs: Date.now() - started,
		});
		return outcomeSchema.parse(outcome);
	},
});

export const fantasyWeeklyRecapSchedule = {
	cron: '0 10 * * *',
	timezone: getFantasyConfig()?.recapTimezone ?? 'America/Chicago',
	inputData: {},
};

/**
 * 10:00 America/Chicago daily. The coordinator inside `runDailyRecap` translates
 * a fire into exactly one of the durable-state outcomes; days with no newly
 * completed week are quiet no-ops.
 */
export const fantasyWeeklyRecapWorkflow = createWorkflow({
	id: 'fantasy-weekly-recap',
	inputSchema: z.object({}),
	outputSchema: outcomeSchema,
	schedule: fantasyWeeklyRecapSchedule,
}).then(weeklyRecapStep).commit();
