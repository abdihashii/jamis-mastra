import type { Mastra } from '@mastra/core/mastra';
import type { MastraDBMessage } from '@mastra/core/memory';

import type { WeekFacts } from './analysis';
import type { FantasyConfig } from './config';
import type { CoordinatorOutcome } from './coordinator';
import type { SendClient } from './deliver';
import type { ChatContextMessage, RecapShaping } from './generate';
import type { SleeperManager } from './sleeper';

import { buildWeekFacts } from './analysis';
import { runWeeklyRecap } from './coordinator';
import { buildRecapPrompt, DEFAULT_RECAP_MODEL, recapShapingSchema, ShapingValidationError, validateShaping } from './generate';
import { ensureFantasyRecapsTable, getFantasySql, recordGeneration } from './recaps';
import { createRunsStore } from './runs';
import { getLeague, getManagers, getNflState, getScores, getWinnersBracket, latestCompletedWeek, withBracketRounds } from './sleeper';

export type DailyOutcome
	= | { outcome: CoordinatorOutcome; week: number | null }
		| { outcome: 'skipped-unconfigured' | 'error'; week: null; error?: string };

/**
 * The one daily flow: both `bun run fantasy:recap run` and the scheduled
 * workflow call this. Never throws; Sleeper/config failures land in `error`
 * (after the operator DM attempt).
 */
export async function runDailyRecap(
	config: FantasyConfig | null,
	mastra: Mastra,
	/** Test/op-only seam: without this, the real Sendblue client is dynamically imported. */
	overrides?: { send?: SendClient },
): Promise<DailyOutcome> {
	if (!config)
		return { outcome: 'skipped-unconfigured', week: null };
	// Resolved before any fetch: an import failure here answers at boot, not mid-alert.
	const send: SendClient = overrides?.send ?? (await import('./deliver')).sendblueSendClient;
	const sql = getFantasySql();
	const runs = createRunsStore(config.sleeperLeagueId, sql);
	try {
		const [state, rawLeague, managers, bracket] = await Promise.all([
			getNflState(),
			getLeague(config.sleeperLeagueId),
			getManagers(config.sleeperLeagueId),
			getWinnersBracket(config.sleeperLeagueId),
		]);
		const league = withBracketRounds(rawLeague, bracket);
		const week = latestCompletedWeek(state, league, bracket);

		const deps = {
			runs,
			recaps: { ensureSchema: () => ensureFantasyRecapsTable(sql), record: (record: Parameters<typeof recordGeneration>[0]) => recordGeneration(record, sql) },
			groupId: config.sendblueGroupId,
			leagueId: config.sleeperLeagueId,
			readThreadMessages: async (since?: Date): Promise<MastraDBMessage[]> => {
				try {
					const store = await mastra.getStorage()?.getStore('memory');
					if (!store)
						return [];
					const { messages } = await store.listMessages({
						threadId: `fantasy-group-${config.sendblueGroupId}`,
						perPage: 200,
						filter: since ? { dateRange: { start: since, startExclusive: true } } : undefined,
						orderBy: { field: 'createdAt', direction: 'DESC' },
					});
					return messages;
				}
				catch (error) {
					console.error('[fantasy-recap] could not read chat context; proceeding with none:', error);
					return [];
				}
			},
			send,
			now: () => new Date(),
		};

		let facts: WeekFacts | null = null;
		if (week != null) {
			try {
				facts = await factsForWeek(config, league, managers, bracket, week);
			}
			catch (error) {
				// Missing Sleeper facts block posting and alert the operator (one DM per trigger).
				const message = error instanceof Error ? error.message.slice(0, 200) : 'unknown Sleeper failure';
				try {
					await send.directMessage(`[fantasy-recap] recap blocked: Sleeper facts unavailable (${message}).`);
				}
				catch { /* alerting must never mask the underlying failure */ }
				return { outcome: 'error', week: null, error: message };
			}
		}

		const model = DEFAULT_RECAP_MODEL;
		const agent = mastra.getAgent('fantasy');
		const generate = async (factsNow: WeekFacts, context: ChatContextMessage[]): Promise<RecapShaping> => {
			const result = await agent.generate(buildRecapPrompt(factsNow, context), {
				structuredOutput: { schema: recapShapingSchema },
				// The prompt carries raw group chat and the output carries recap prose;
				// neither may reach ClickHouse (AC: traces without chat/phone/recap text).
				tracingOptions: { hideInput: true, hideOutput: true },
			});
			if (!result.object)
				throw new ShapingValidationError('the model returned no structured recap output');
			return validateShaping(result.object, context, factsNow);
		};
		return await runWeeklyRecap({ config, week, facts, managers, model, generate }, deps);
	}
	catch (error) {
		// Sleeper endpoints down or shape-starved: operator DM, no run row.
		const message = error instanceof Error ? error.message.slice(0, 200) : 'unknown Sleeper failure';
		try {
			await send.directMessage(`[fantasy-recap] recap blocked: Sleeper facts unavailable (${message}).`);
		}
		catch { /* alerting must never mask the underlying failure */ }
		return { outcome: 'error', week: null, error: message };
	}
}

/** All week-N matchup rows + (regular season) week N+1 for the upcoming slate. */
async function factsForWeek(
	config: FantasyConfig,
	league: ReturnType<typeof withBracketRounds>,
	managers: SleeperManager[],
	bracket: Awaited<ReturnType<typeof getWinnersBracket>>,
	week: number,
): Promise<WeekFacts> {
	const scoresByWeek = new Map<number, Awaited<ReturnType<typeof getScores>>>();
	for (let w = 1; w <= week; w += 1) {
		scoresByWeek.set(w, await getScores(config.sleeperLeagueId, w));
	}
	const nextWeekScores = week + 1 < league.playoffWeekStart ? await getScores(config.sleeperLeagueId, week + 1) : undefined;
	return buildWeekFacts({ league, week, managers, bracket, scoresByWeek, nextWeekScores });
}
