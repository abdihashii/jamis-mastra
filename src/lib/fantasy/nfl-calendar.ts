import { z } from 'zod';

import type { ChatWindow } from './chat-archive';
import type { SleeperScheduleSnapshot } from './sleeper';

import { nflTeamCode } from './nfl-sources';
import { sleeperScheduleSchema } from './sleeper';

const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const minute = z.iso.datetime({ precision: -1 });
const periodSchema = z.object({ $ref: z.url(), number: z.number().int(), startDate: minute, endDate: minute, text: z.string().max(100) });
const seasonSchema = z.object({ year: z.number().int(), type: z.number().int() });
const weekSchema = z.object({ number: z.number().int() });
const statusSchema = z.object({ type: z.object({ name: z.string().max(80), state: z.enum(['pre', 'in', 'post']), completed: z.boolean() }) });
const eventSchema = z.object({
	id: z.string().regex(/^\d{1,30}$/),
	date: minute,
	season: seasonSchema,
	week: weekSchema,
	status: statusSchema,
	competitions: z.array(z.object({
		id: z.string(),
		date: minute,
		status: statusSchema,
		competitors: z.array(z.object({ homeAway: z.enum(['home', 'away']), team: z.object({ abbreviation: z.string().max(4) }) })).length(2),
	})).length(1),
});
const scoreboardSchema = z.object({
	leagues: z.array(z.object({ id: z.literal('28'), slug: z.literal('nfl') })).length(1),
	season: seasonSchema,
	week: weekSchema,
	events: z.array(eventSchema).min(1).max(20),
});
type BlockReason = 'calendar_scope_invalid' | 'calendar_source_invalid' | 'calendar_source_unavailable'
	| 'calendar_next_period_unavailable' | 'calendar_boundary_conflict' | 'calendar_period_unclosed'
	| 'calendar_games_unclosed' | 'calendar_schedule_mismatch' | 'calendar_games_outside_window' | 'calendar_read_canceled';
class CalendarFailure extends Error {
	constructor(readonly reason: BlockReason) { super(reason); }
}
function requireValue(value: unknown, reason: BlockReason): asserts value {
	if (!value)
		throw new CalendarFailure(reason);
}
interface Scope { season: number; type: number; week: number }
interface Period { url: string; providerWeek: number; label: string; startAtUtc: string; lastMinuteAtUtc: string }
export interface NflCalendarProof {
	provider: 'espn';
	retrievedAtUtc: string;
	current: Period;
	next: Period;
	games: Array<{ id: string; kickoffAtUtc: string; home: string; away: string; final: true }>;
}
export type NflReportingWindow = { status: 'ready'; window: ChatWindow; source: NflCalendarProof }
	| { status: 'blocked'; reason: BlockReason };

const calendarUrl = (scope: Scope) => `${CORE}/seasons/${scope.season}/types/${scope.type}/weeks/${scope.week}?lang=en&region=us`;
const proofInstant = z.iso.datetime({ precision: 3 }).refine(value => new Date(value).toISOString() === value);
const proofPeriod = z.object({
	url: z.url().max(2048),
	providerWeek: z.number().int(),
	label: z.string().max(100),
	startAtUtc: proofInstant,
	lastMinuteAtUtc: proofInstant,
}).strict();
export const nflCalendarProofSchema: z.ZodType<NflCalendarProof> = z.object({
	provider: z.literal('espn'),
	retrievedAtUtc: proofInstant,
	current: proofPeriod,
	next: proofPeriod,
	games: z.array(z.object({
		id: z.string().regex(/^\d{1,30}$/),
		kickoffAtUtc: proofInstant,
		home: z.string().refine(value => nflTeamCode(value) === value),
		away: z.string().refine(value => nflTeamCode(value) === value),
		final: z.literal(true),
	}).strict()).min(1).max(20),
}).strict();

/** Historical proof parsing grants no execution authority and never re-queries or changes its timestamps. */
export function parseNflCalendarProof(value: unknown, season: number, fantasyWeek: number, window: ChatWindow): NflCalendarProof {
	try {
		const source = nflCalendarProofSchema.parse(value);
		const regular = season >= 2021 ? 18 : 17;
		requireValue(Number.isInteger(season) && season >= 1920 && season <= 2100
			&& Number.isInteger(fantasyWeek) && fantasyWeek > 0 && fantasyWeek <= regular + 4, 'calendar_scope_invalid');
		const type = fantasyWeek <= regular ? 2 : 3;
		const local = type === 2 ? fantasyWeek : fantasyWeek - regular;
		const current: Scope = { season, type, week: type === 3 && local === 4 ? 5 : local };
		const next: Scope = type === 2 && local === regular ? { season, type: 3, week: 1 } : { ...current, week: current.week + 1 };
		for (const [actual, expected] of [[source.current, current], [source.next, next]] as const) {
			const label = expected.type === 2
				? `Week ${expected.week}`
				: ({ 1: 'Wild Card', 2: 'Divisional Round', 3: 'Conference Championship', 4: 'Pro Bowl', 5: 'Super Bowl' } as Record<number, string>)[expected.week];
			requireValue(actual.url === calendarUrl(expected) && actual.providerWeek === expected.week && actual.label === label
				&& actual.startAtUtc < actual.lastMinuteAtUtc
				&& [actual.startAtUtc, actual.lastMinuteAtUtc].every(date => date.endsWith(':00.000Z')
					&& [season, season + 1].includes(Number(date.slice(0, 4)))), 'calendar_source_invalid');
		}
		requireValue(source.current.startAtUtc === window.startAtUtc && source.next.startAtUtc === window.endAtUtc
			&& Date.parse(source.current.lastMinuteAtUtc) + 60_000 === Date.parse(source.next.startAtUtc), 'calendar_boundary_conflict');
		requireValue(new Set(source.games.map(game => game.id)).size === source.games.length
			&& new Set(source.games.map(game => `${game.home}:${game.away}`)).size === source.games.length
			&& source.games.every(game => game.home !== game.away && game.kickoffAtUtc >= window.startAtUtc
				&& game.kickoffAtUtc < window.endAtUtc), 'calendar_schedule_mismatch');
		return source;
	} catch {
		throw new Error('invalid_reporting_calendar');
	}
}

async function readJson(url: string, signal: AbortSignal, next = false): Promise<unknown> {
	signal.throwIfAborted();
	const response = await fetch(url, { signal, redirect: 'error', headers: { 'accept': 'application/json', 'user-agent': 'jamis-mastra/1.0' } });
	requireValue(response.ok, next && response.status === 404 ? 'calendar_next_period_unavailable' : 'calendar_source_unavailable');
	requireValue(response.body, 'calendar_source_invalid');
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			signal.throwIfAborted();
			if (chunk.done)
				break;
			size += chunk.value.byteLength;
			requireValue(size <= MAX_BODY_BYTES, 'calendar_source_invalid');
			chunks.push(chunk.value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		try {
			return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		} catch {
			throw new CalendarFailure('calendar_source_invalid');
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

function period(raw: unknown, scope: Scope): Period {
	const parsed = periodSchema.safeParse(raw);
	requireValue(parsed.success, 'calendar_source_invalid');
	const value = parsed.data;
	const ref = new URL(value.$ref);
	const expected = new URL(calendarUrl(scope));
	const label = scope.type === 2
		? `Week ${scope.week}`
		: ({ 1: 'Wild Card', 2: 'Divisional Round', 3: 'Conference Championship', 4: 'Pro Bowl', 5: 'Super Bowl' } as Record<number, string>)[scope.week];
	requireValue(['http:', 'https:'].includes(ref.protocol) && ref.host === expected.host && ref.pathname === expected.pathname
		&& !ref.username && !ref.password && !ref.hash && value.number === scope.week && value.text === label, 'calendar_source_invalid');
	const startAtUtc = new Date(value.startDate).toISOString();
	const lastMinuteAtUtc = new Date(value.endDate).toISOString();
	requireValue(startAtUtc < lastMinuteAtUtc && [startAtUtc, lastMinuteAtUtc].every(date =>
		[scope.season, scope.season + 1].includes(Number(date.slice(0, 4)))), 'calendar_source_invalid');
	return { url: calendarUrl(scope), providerWeek: value.number, label: value.text, startAtUtc, lastMinuteAtUtc };
}

function gamesInWindow(raw: unknown, scope: Scope, snapshot: SleeperScheduleSnapshot, week: number, window: ChatWindow, now: Date): NflCalendarProof['games'] {
	const parsed = scoreboardSchema.safeParse(raw);
	requireValue(parsed.success, 'calendar_source_invalid');
	const value = parsed.data;
	requireValue(value.season.year === scope.season && value.season.type === scope.type && value.week.number === scope.week, 'calendar_source_invalid');
	const target = snapshot.games.filter(game => game.week === week && !(game.status === 'canceled' && (game.home === 'TBD' || game.away === 'TBD')));
	requireValue(target.length > 0 && target.every(game => game.status === 'complete' && game.home !== 'TBD' && game.away !== 'TBD'), 'calendar_games_unclosed');
	const byPair = new Map(target.map(game => [`${game.home}:${game.away}`, game]));
	requireValue(byPair.size === target.length && value.events.length === target.length
		&& new Set(value.events.map(game => game.id)).size === value.events.length, 'calendar_schedule_mismatch');
	const used = new Set<string>();
	return value.events.map((event) => {
		const competition = event.competitions[0]!;
		requireValue(event.season.year === scope.season && event.season.type === scope.type && event.week.number === scope.week
			&& competition.id === event.id && competition.date === event.date
			&& JSON.stringify(competition.status) === JSON.stringify(event.status), 'calendar_source_invalid');
		requireValue(event.status.type.completed && event.status.type.state === 'post' && event.status.type.name === 'STATUS_FINAL', 'calendar_games_unclosed');
		const home = nflTeamCode(competition.competitors.find(team => team.homeAway === 'home')?.team.abbreviation ?? '');
		const away = nflTeamCode(competition.competitors.find(team => team.homeAway === 'away')?.team.abbreviation ?? '');
		const key = `${home}:${away}`;
		const sleeperGame = byPair.get(key);
		requireValue(home && away && home !== away && sleeperGame && !used.has(key), 'calendar_schedule_mismatch');
		used.add(key);
		const kickoffAtUtc = new Date(event.date).toISOString();
		const dayAfter = new Date(Date.parse(`${sleeperGame.date}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
		// Sleeper's NFL game date may precede a late US kickoff's UTC date; it is not an exact time.
		requireValue([sleeperGame.date, dayAfter].includes(kickoffAtUtc.slice(0, 10)), 'calendar_schedule_mismatch');
		requireValue(kickoffAtUtc >= window.startAtUtc && kickoffAtUtc < window.endAtUtc && kickoffAtUtc <= now.toISOString(), 'calendar_games_outside_window');
		return { id: event.id, kickoffAtUtc, home, away, final: true };
	});
}

/** Queried calendar periods, not final-whistle timestamps. Week is local to the supplied Sleeper phase. */
export async function readNflReportingWindow(snapshot: SleeperScheduleSnapshot, week: number, now: Date, signal?: AbortSignal): Promise<NflReportingWindow> {
	const parsed = sleeperScheduleSchema.safeParse(snapshot);
	const year = parsed.success ? Number(parsed.data.season) : Number.NaN;
	const regularWeeks = year >= 2021 ? 18 : 17;
	if (!parsed.success || year < 1920 || year > 2100 || !Number.isSafeInteger(week) || week < 1
		|| week > (snapshot.phase === 'regular' ? regularWeeks : 4) || !Number.isFinite(now.getTime())) {
		return { status: 'blocked', reason: 'calendar_scope_invalid' };
	}
	if (signal?.aborted)
		return { status: 'blocked', reason: 'calendar_read_canceled' };
	// ESPN's fourth postseason period is Pro Bowl; Sleeper's fourth game week is Super Bowl.
	const currentScope = { season: year, type: snapshot.phase === 'regular' ? 2 : 3, week: snapshot.phase === 'post' && week === 4 ? 5 : week };
	const transition = currentScope.type === 2 && week === regularWeeks;
	const nextScope = { season: year, type: transition ? 3 : currentScope.type, week: transition ? 1 : currentScope.week + 1 };
	const controller = new AbortController();
	const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
	try {
		const [currentRaw, nextRaw, scoreboard] = await Promise.all([
			readJson(calendarUrl(currentScope), deadline),
			readJson(calendarUrl(nextScope), deadline, true),
			readJson(`${SITE}?dates=${year}&seasontype=${currentScope.type}&week=${currentScope.week}&limit=1000`, deadline),
		]);
		deadline.throwIfAborted();
		const current = period(currentRaw, currentScope);
		const next = period(nextRaw, nextScope);
		// ESPN reports the last included minute; the queried next start supplies the exact exclusive bound.
		requireValue(Date.parse(current.lastMinuteAtUtc) + 60_000 === Date.parse(next.startAtUtc), 'calendar_boundary_conflict');
		requireValue(now.toISOString() >= next.startAtUtc, 'calendar_period_unclosed');
		const window = { startAtUtc: current.startAtUtc, endAtUtc: next.startAtUtc };
		const games = gamesInWindow(scoreboard, currentScope, parsed.data, week, window, now);
		return { status: 'ready', window, source: { provider: 'espn', retrievedAtUtc: new Date().toISOString(), current, next, games } };
	} catch (error) {
		return { status: 'blocked', reason: signal?.aborted
			? 'calendar_read_canceled'
			: error instanceof CalendarFailure ? error.reason : 'calendar_source_unavailable' };
	} finally {
		controller.abort();
	}
}
