import type { Mastra } from '@mastra/core/mastra';
import type { TracingContext } from '@mastra/core/observability';
import type { MemoryStorage } from '@mastra/core/storage';
import type { FantasyConfig } from './config';
import type { CoordinatorDeps } from './coordinator';
import type { SendClient } from './deliver';
import type { PipelineDeps, PipelineResult } from './pipeline';
import type { EvidenceOptions } from './recap-evidence';
import type { SqlLike } from './recaps';
import process from 'node:process';
import { openRecapArchive } from './archive';
import { resolveSleeperChatWindow } from './chat-window';
import { retryWeek } from './coordinator';
import { createNflSourceTask } from './nfl-sources-task';
import { runRecapPipeline } from './pipeline';
import { ensureFantasyRecapsTable, getFantasySql, recordClaimedGeneration } from './recaps';
import { createRunsStore } from './runs';
import { getLeague, getNflSchedule, getNflState, getWinnersBracket, latestCompletedWeek, withBracketRounds } from './sleeper';

export type DailyOutcome = Omit<PipelineResult, 'outcome'> & { outcome: PipelineResult['outcome'] | 'skipped-unconfigured' | 'error' };
export interface DailyOverrides {
	send?: SendClient & { sendExactToGroup?: (groupId: string, text: string) => ReturnType<SendClient['sendToGroup']> };
	traceId?: string;
	tracingContext?: TracingContext;
	sql?: SqlLike;
	databaseUrl?: string;
	memory?: Pick<MemoryStorage, 'getThreadById' | 'listMessages'>;
	sleeper?: EvidenceOptions['sleeper'] & { getNflSchedule: typeof getNflSchedule };
	prepare?: PipelineDeps['prepare'];
	publish?: PipelineDeps['publish'];
	readNfl?: EvidenceOptions['readNfl'];
	now?: () => Date;
	abortSignal?: AbortSignal;
	restart?: { week: number; attemptId: string };
}

/** The single production entrypoint. Private preparation/publication are composed only after durable eligibility. */
export async function runDailyRecap(config: FantasyConfig | null, mastra: Mastra, overrides: DailyOverrides = {}): Promise<DailyOutcome> {
	if (!config)
		return { outcome: 'skipped-unconfigured', week: null };
	let archive: ReturnType<typeof openRecapArchive> | undefined;
	let send: DailyOverrides['send'];
	try {
		overrides.abortSignal?.throwIfAborted();
		send = overrides.send ?? (await import('./deliver')).sendblueSendClient;
		const source = overrides.sleeper ?? { getNflState, getLeague, getWinnersBracket, getNflSchedule };
		const deadline = () => AbortSignal.any([AbortSignal.timeout(20_000), ...(overrides.abortSignal ? [overrides.abortSignal] : [])]);
		const [state, rawLeague, bracket] = await Promise.all([
			source.getNflState(deadline()),
			source.getLeague(config.sleeperLeagueId, deadline()),
			source.getWinnersBracket(config.sleeperLeagueId, deadline()),
		]);
		if (rawLeague.id !== config.sleeperLeagueId || !/^\d{4}$/.test(rawLeague.season))
			throw new Error('sleeper_scope_unavailable');
		const league = withBracketRounds(rawLeague, bracket);
		const week = latestCompletedWeek(state, league, bracket);
		if (week === null)
			return { outcome: 'noop-no-completed-week', week: null };
		if (overrides.restart && overrides.restart.week !== week)
			return { outcome: 'failed', week: overrides.restart.week, reason: 'restart_not_latest_completed_week' };
		const sql = overrides.sql ?? getFantasySql();
		const now = overrides.now ?? (() => new Date());
		async function window() {
			const [schedule, postseason] = await Promise.all([
				source.getNflSchedule(league.season, week! <= 18 ? 'regular' : 'post', deadline()),
				week === 18 ? source.getNflSchedule(league.season, 'post', deadline()) : undefined,
			]);
			const result = resolveSleeperChatWindow(schedule, week!, now(), postseason);
			if (result.status === 'ready')
				return result.window;
			if (result.reason === 'schedule_week_unclosed')
				return null;
			throw new Error('archive_window_unavailable');
		}
		// Restart retains the exact old coverage window, but never bypasses a newly delayed NFL game.
		if (overrides.restart && !await window())
			return { outcome: 'noop-no-completed-week', week: null };
		const memory = overrides.memory ?? {
			getThreadById: async (input: Parameters<MemoryStorage['getThreadById']>[0]) => {
				archive ??= openRecapArchive(overrides.databaseUrl ?? process.env.DATABASE_URL ?? '');
				return (await archive).memory.getThreadById(input);
			},
			listMessages: async (input: Parameters<MemoryStorage['listMessages']>[0]) => {
				archive ??= openRecapArchive(overrides.databaseUrl ?? process.env.DATABASE_URL ?? '');
				return (await archive).memory.listMessages(input);
			},
		};
		let task: ReturnType<typeof createNflSourceTask> | undefined;
		const apiKey = process.env.FIRECRAWL_API_KEY;
		const legacy: CoordinatorDeps = {
			runs: createRunsStore(config.sleeperLeagueId, sql),
			recaps: { ensureSchema: () => ensureFantasyRecapsTable(sql), record: (record, token) => recordClaimedGeneration(record, token, sql) },
			groupId: config.sendblueGroupId,
			leagueId: config.sleeperLeagueId,
			readThreadMessages: async () => { throw new Error('saved_retry_cannot_read_archive'); },
			send,
			now,
		};
		return await runRecapPipeline({ config, season: Number(league.season), week, window, traceId: overrides.traceId, restartAttemptId: overrides.restart?.attemptId }, {
			sql,
			memory,
			sleeper: overrides.sleeper,
			now,
			signal: overrides.abortSignal,
			notify: text => send!.directMessage(text),
			legacyRetry: async (storedWeek) => {
				const result = await retryWeek(storedWeek, false, legacy);
				return result.ok ? { outcome: result.outcome, week: storedWeek } : { outcome: 'blocked-active-claim', week: storedWeek, reason: 'legacy_retry_blocked' };
			},
			readNfl: overrides.readNfl ?? (apiKey?.trim()
				? async (input, currentSeason) => {
					task ??= createNflSourceTask({ apiKey, currentSeason });
					return task(input);
				}
				: undefined),
			prepare: overrides.prepare ?? (async (packet, signal, observer) => {
				const { createFantasyEditorialProcedure } = await import('../../mastra/workflows/prepare-fantasy-recap');
				return createFantasyEditorialProcedure(mastra)(packet, signal, observer);
			}),
			publish: overrides.publish ?? (async (reference, token, signal) => {
				if (!send?.sendExactToGroup)
					throw new Error('exact_transport_unavailable');
				const { createFantasyPublicationProcedure } = await import('../../mastra/workflows/publish-fantasy-recap');
				return createFantasyPublicationProcedure(mastra, { leagueId: config.sleeperLeagueId, groupId: config.sendblueGroupId, sql, sendExact: (group, text) => send!.sendExactToGroup!(group, text) })(reference, token, signal);
			}),
		});
	} catch {
		try {
			await send?.directMessage('[fantasy-recap] recap blocked: source or application state unavailable. No new generation was authorized.');
		} catch { /* Never expose raw source errors or let alerting start another recap. */ }
		return { outcome: 'error', week: null, error: 'recap_scope_unavailable' };
	} finally {
		try {
			await (await archive)?.close();
		} catch { /* Cleanup cannot retract a recorded delivery receipt. */ }
	}
}
