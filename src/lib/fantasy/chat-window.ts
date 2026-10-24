import type { ChatWindow } from './chat-archive';
import type { SleeperScheduleSnapshot } from './sleeper';
import { sleeperScheduleSchema } from './sleeper';

/**
 * Conservative stored-archive coverage by schedule calendar dates, NOT official kickoff/final-whistle timestamps.
 * Includes post-game reaction through collection, capped before the next week's actual game dates, not send time.
 */
export function resolveSleeperChatWindow(
	snapshot: SleeperScheduleSnapshot,
	fantasyWeek: number,
	now: Date,
	nextPhase?: SleeperScheduleSnapshot,
): { status: 'ready'; window: ChatWindow } | { status: 'blocked'; reason: string } {
	if (!Number.isInteger(fantasyWeek) || fantasyWeek < 1 || fantasyWeek > 22 || !Number.isFinite(now.getTime()))
		return { status: 'blocked', reason: 'schedule_scope_invalid' };
	const parsed = sleeperScheduleSchema.safeParse(snapshot);
	if (!parsed.success)
		return { status: 'blocked', reason: 'schedule_source_invalid' };
	const phase = fantasyWeek <= 18 ? 'regular' : 'post';
	const week = phase === 'regular' ? fantasyWeek : fantasyWeek - 18;
	if (parsed.data.phase !== phase)
		return { status: 'blocked', reason: 'schedule_phase_mismatch' };

	const games = parsed.data.games.filter(game => !(game.status === 'canceled' && (game.home === 'TBD' || game.away === 'TBD')));
	const target = games.filter(game => game.week === week);
	if (target.length === 0)
		return { status: 'blocked', reason: 'schedule_week_missing' };
	const nowUtc = now.toISOString();
	if (target.some(game => game.status !== 'complete' || game.date > nowUtc.slice(0, 10)))
		return { status: 'blocked', reason: 'schedule_week_unclosed' };
	if (target.some(game => game.home === 'TBD' || game.away === 'TBD'))
		return { status: 'blocked', reason: 'schedule_window_ambiguous' };

	const dates = target.map(game => `${game.date}T00:00:00.000Z`).sort();
	let nextGames = games.filter(game => game.week === week + 1);
	if (fantasyWeek === 18) {
		const parsedNext = sleeperScheduleSchema.safeParse(nextPhase);
		if (!parsedNext.success)
			return { status: 'blocked', reason: 'schedule_source_invalid' };
		if (parsedNext.data.season !== parsed.data.season)
			return { status: 'blocked', reason: 'schedule_scope_invalid' };
		if (parsedNext.data.phase !== 'post')
			return { status: 'blocked', reason: 'schedule_phase_mismatch' };
		nextGames = parsedNext.data.games.filter(game => game.week === 1 && !(game.status === 'canceled' && (game.home === 'TBD' || game.away === 'TBD')));
		if (nextGames.length === 0)
			return { status: 'blocked', reason: 'schedule_week_missing' };
		if (nextGames.some(game => game.home === 'TBD' || game.away === 'TBD'))
			return { status: 'blocked', reason: 'schedule_window_ambiguous' };
	}
	const nextDate = nextGames.map(game => game.date).sort()[0];
	const nextStart = nextDate ? `${nextDate}T00:00:00.000Z` : null;
	const endAtUtc = nextStart && nextStart <= nowUtc ? nextStart : nowUtc;
	// Two UTC days avoid claiming exact final-whistle coverage on adjacent/overlapping calendar game dates.
	if (nextStart === endAtUtc && Date.parse(dates[dates.length - 1]) + 2 * 86_400_000 > Date.parse(nextStart))
		return { status: 'blocked', reason: 'schedule_window_ambiguous' };
	if (dates[0] >= endAtUtc)
		return { status: 'blocked', reason: 'schedule_window_ambiguous' };
	return { status: 'ready', window: { startAtUtc: dates[0], endAtUtc } };
}
