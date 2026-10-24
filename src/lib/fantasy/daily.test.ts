import type { Mastra } from '@mastra/core/mastra';

import { describe, expect, it, spyOn } from 'bun:test';

import { fantasyWeeklyRecapSchedule, fantasyWeeklyRecapWorkflow } from '../../mastra/workflows/fantasy-weekly-recap';
import { parseFantasyConfig } from './config';
import { runDailyRecap } from './daily';

const config = parseFantasyConfig({
	FANTASY_SENDBLUE_GROUP_ID: 'g1',
	FANTASY_SLEEPER_LEAGUE_ID: '111',
	FANTASY_MANAGER_MAP: '{}',
	FANTASY_RECAP_TIMEZONE: 'America/Chicago',
})!;

describe('runDailyRecap', () => {
	it('unconfigured fantasy is a quiet skip, no Sleeper calls', async () => {
		const outcome = await runDailyRecap(null, {} as Mastra);
		expect(outcome).toEqual({ outcome: 'skipped-unconfigured', week: null });
	});

	it('never needs the wire when unconfigured (no dynamic deliver import)', async () => {
		await expect(runDailyRecap(null, {} as Mastra)).resolves.toMatchObject({ outcome: 'skipped-unconfigured' });
	});

	it('Sleeper failures return error without throwing; DM attempt is best-effort', async () => {
		const spy = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response('down', { status: 500 })) as unknown as typeof fetch);
		const dms: string[] = [];
		const send = {
			sendToGroup: async () => ({ kind: 'unknown' as const, error: 'never reached' }),
			directMessage: async (t: string) => {
				dms.push(t);
			},
		};
		try {
			const outcome = await runDailyRecap(config, {} as Mastra, { send });
			if (outcome.outcome === 'error')
				expect(outcome.error).toBe('recap_scope_unavailable');
			else
				throw new Error(`expected error outcome, got ${outcome.outcome}`);
			expect(outcome.week).toBeNull();
		} finally {
			spy.mockRestore();
		}
	});
});

describe('fantasyWeeklyRecapWorkflow', () => {
	it('is the single daily step behind the 10:00 America/Chicago cron', () => {
		expect(fantasyWeeklyRecapWorkflow.id).toBe('fantasy-weekly-recap');
		expect(fantasyWeeklyRecapSchedule).toEqual({ cron: '0 10 * * *', timezone: 'America/Chicago', inputData: {} });
		const schema = fantasyWeeklyRecapWorkflow.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } };
		expect(schema.safeParse({}).success).toBe(true);
	});
});
