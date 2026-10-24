import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { SqlLike } from '../../lib/operator-time-zone';

import { resolveOperatorTimeZone } from '../../lib/operator-time-zone';
import { zonedDateTime } from '../../lib/time';
import { requireOperatorTimeZone } from '../env';

const currentTimeOutputSchema = z.object({
	nowUtc: z.string(),
	timeZone: z.string(),
	source: z.enum(['override', 'default']),
	operatorLocal: z.string(),
});

export async function readCurrentTime(
	defaultTimeZone: string,
	nowMs = Date.now(),
	sql?: SqlLike,
): Promise<z.infer<typeof currentTimeOutputSchema>> {
	const effective = await resolveOperatorTimeZone(defaultTimeZone, sql);
	return {
		nowUtc: new Date(nowMs).toISOString(),
		...effective,
		operatorLocal: zonedDateTime(effective.timeZone, nowMs),
	};
}

export const currentTimeTool = createTool({
	id: 'current-time',
	description: 'Return the current UTC instant and the same time in the configured operator time zone. The time zone is not a physical location.',
	inputSchema: z.object({}),
	outputSchema: currentTimeOutputSchema,
	execute: async () => await readCurrentTime(requireOperatorTimeZone()),
});
