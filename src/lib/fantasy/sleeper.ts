import { z } from 'zod';

import { fetchJson } from '../fetch/fetch';
import { nflTeamCode } from './nfl-sources';

/** Thrown for leagues outside V1's supported shape or incomplete Sleeper data. */
export class SleeperDataError extends Error {}

const BASE = 'https://api.sleeper.app/v1';

export interface SleeperState {
	week: number;
	season: string;
	seasonType: string;
	seasonStartDate?: string | null;
}

const scheduleScopeSchema = z.object({
	season: z.string().regex(/^\d{4}$/).refine(value => Number(value) >= 1 && Number(value) <= 9998),
	phase: z.enum(['regular', 'post']),
});
const scheduleTeam = z.string().max(3).refine(value => value === 'TBD' || nflTeamCode(value) === value);
const scheduleGameSchema = z.object({
	id: z.string().regex(/^\d{5,32}$/),
	week: z.number().int().min(1).max(18),
	date: z.iso.date(),
	status: z.string().regex(/^[a-z][a-z_]{0,31}$/),
	home: scheduleTeam,
	away: scheduleTeam,
});
export const sleeperScheduleSchema = scheduleScopeSchema.extend({
	retrievedAtUtc: z.iso.datetime({ precision: 3 }),
	games: z.array(scheduleGameSchema).max(400),
}).refine(snapshot => new Set(snapshot.games.map(game => game.id)).size === snapshot.games.length
	&& snapshot.games.every(game => game.id.startsWith(snapshot.season)
		&& game.week <= (snapshot.phase === 'regular' ? 18 : 4)
		&& [Number(snapshot.season), Number(snapshot.season) + 1].includes(Number(game.date.slice(0, 4)))));

export type SleeperGame = z.infer<typeof scheduleGameSchema>;
export type SleeperScheduleSnapshot = z.infer<typeof sleeperScheduleSchema>;

const scheduleRowsSchema = z.array(scheduleGameSchema.omit({ id: true, home: true, away: true }).extend({
	game_id: z.string(),
	home: z.string().max(80),
	away: z.string().max(80),
})).max(400);

function normalizeScheduleTeam(value: string, status: string): string | null {
	const club = nflTeamCode(value);
	if (club || value === 'TBD')
		return club ?? 'TBD';
	// These named canceled bracket placeholders occur in the captured postseason payload.
	return status === 'canceled'
		&& ['NFC Divisional (win)', 'AFC Championship (win)', 'NFC Championship (win)'].includes(value)
		? 'TBD'
		: null;
}

/** Public, undocumented schedule endpoint, intentionally outside /v1; no timestamps are inferred. */
export async function getNflSchedule(
	season: string,
	phase: 'regular' | 'post',
	signal?: AbortSignal,
): Promise<SleeperScheduleSnapshot> {
	if (!scheduleScopeSchema.safeParse({ season, phase }).success)
		throw new SleeperDataError('Sleeper NFL schedule scope is invalid');
	try {
		const timeout = AbortSignal.timeout(20_000);
		const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		requestSignal.throwIfAborted();
		const { ok, json } = await fetchJson(`https://api.sleeper.app/schedule/nfl/${phase}/${season}`, requestSignal, undefined, false);
		requestSignal.throwIfAborted();
		if (!ok || !Array.isArray(json) || json.length > 400)
			throw new SleeperDataError();
		const rows = scheduleRowsSchema.parse(json);
		return sleeperScheduleSchema.parse({
			season,
			phase,
			retrievedAtUtc: new Date().toISOString(),
			games: rows.map(({ game_id, home, away, ...game }) => ({
				id: game_id,
				...game,
				home: normalizeScheduleTeam(home, game.status),
				away: normalizeScheduleTeam(away, game.status),
			})),
		});
	} catch {
		throw new SleeperDataError('Sleeper NFL schedule could not be retrieved');
	}
}

export interface SleeperLeague {
	id: string;
	name: string;
	season: string;
	status: string;
	totalRosters: number;
	playoffWeekStart: number;
	/** Counted from the winners bracket; V1 supports one-week rounds only. */
	playoffRounds: number;
	rosterPositions: string[];
	scoringSettings?: Record<string, number> | null;
}

export interface SleeperManager {
	rosterId: number;
	userId: string;
	displayName: string;
}

export interface SleeperScore {
	rosterId: number;
	matchupId: number | null;
	points: number | null;
	starters: string[];
	players: string[];
	playerPoints: Record<string, number>;
}

export interface SleeperPlayer {
	id: string;
	name: string;
	position: string;
}

export interface SleeperPlayerDetails extends SleeperPlayer {
	team: string | null;
	fantasyPositions: string[];
	gsisId: string | null;
}

export interface SleeperTransaction {
	id: string;
	type: string;
	status: string;
	week: number;
	rosterIds: number[];
	createdAtUtc: string | null;
	statusUpdatedAtUtc: string | null;
	adds: Array<{ playerId: string; rosterId: number }>;
	drops: Array<{ playerId: string; rosterId: number }>;
	waiverBid: number | null;
	draftPicks: Array<{ season: string; round: number; rosterId: number; previousOwnerId: number; ownerId: number }>;
	faabTransfers: Array<{ sender: number; receiver: number; amount: number }>;
}

export interface BracketFeeder {
	source: 'winner' | 'loser';
	matchupId: number;
}

export interface BracketGame {
	matchupId: number;
	round: number;
	placement: number | null;
	team1: number | null;
	team2: number | null;
	winner: number | null;
	loser: number | null;
	team1From: BracketFeeder | null;
	team2From: BracketFeeder | null;
}

const stateSchema = z.looseObject({
	week: z.number(),
	season: z.string(),
	season_type: z.string(),
	season_start_date: z.iso.date().nullable().catch(null).optional(),
});

const leagueSchema = z.looseObject({
	league_id: z.string(),
	name: z.string().min(1),
	season: z.string(),
	status: z.string(),
	total_rosters: z.number().int().positive(),
	roster_positions: z.array(z.string().min(1)),
	scoring_settings: z.record(z.string(), z.number().finite()).nullable().catch(null).optional(),
	settings: z.looseObject({
		playoff_week_start: z.number().int().positive(),
		playoff_round_type: z.number().int(),
		playoff_teams: z.number().int().positive(),
	}),
});

const userSchema = z.looseObject({ user_id: z.string(), display_name: z.string().min(1) });

const rosterSchema = z.looseObject({ roster_id: z.number().int().positive(), owner_id: z.string().nullable() });

const scoreSchema = z.looseObject({
	roster_id: z.number().int().positive(),
	matchup_id: z.number().int().nullable(),
	points: z.number().nullable(),
	starters: z.array(z.string()).nullable(),
	players: z.array(z.string()),
	players_points: z.record(z.string(), z.number().nullable()),
});

const playerSchema = z.looseObject({
	player_id: z.string().min(1),
	full_name: z.string().min(1).nullish().catch(null),
	first_name: z.string().min(1).nullish().catch(null),
	last_name: z.string().min(1).nullish().catch(null),
	position: z.string().min(1),
	team: z.string().min(1).nullable().catch(null).optional(),
	fantasy_positions: z.array(z.string().min(1)).catch([]).optional(),
	gsis_id: z.string().regex(/^\d{2}-\d{7}$/).nullable().catch(null).optional(),
}).refine(p => !!p.full_name || !!(p.first_name && p.last_name));

const PLAYER_CACHE_MS = 24 * 60 * 60 * 1_000;
let playerCache: {
	expiresAt: number;
	retrievedAtUtc: string;
	byId: Map<string, SleeperPlayerDetails | null>;
} | null = null;

const transactionRosterId = z.number().int().positive();
const transactionSchema = z.looseObject({
	transaction_id: z.string().min(1),
	type: z.string().min(1),
	status: z.string().min(1),
	leg: z.number().int().positive(),
	league_id: z.string().optional(),
	roster_ids: z.array(transactionRosterId).min(1).refine(ids => new Set(ids).size === ids.length),
	created: z.unknown().optional(),
	status_updated: z.unknown().optional(),
	adds: z.record(z.string().min(1), transactionRosterId).nullish(),
	drops: z.record(z.string().min(1), transactionRosterId).nullish(),
	settings: z.looseObject({ waiver_bid: z.number().finite().nonnegative().nullish() }).nullish(),
	draft_picks: z.array(z.looseObject({
		season: z.string().regex(/^\d{4}$/),
		round: z.number().int().positive(),
		roster_id: transactionRosterId,
		previous_owner_id: transactionRosterId,
		owner_id: transactionRosterId,
	})).nullish(),
	waiver_budget: z.array(z.looseObject({
		sender: transactionRosterId,
		receiver: transactionRosterId,
		amount: z.number().finite().nonnegative(),
	})).nullish(),
});

const feederSchema = z.object({ w: z.number().int().optional(), l: z.number().int().optional() });

const bracketGameSchema = z.looseObject({
	m: z.number().int().positive(),
	r: z.number().int().positive(),
	p: z.number().int().nullish(),
	t1: z.number().int().nullable(),
	t2: z.number().int().nullable(),
	w: z.number().int().nullable(),
	l: z.number().int().nullable(),
	t1_from: feederSchema.nullish(),
	t2_from: feederSchema.nullish(),
});

async function getJson<const S extends z.ZodType>(
	path: string,
	schema: S,
	what: string,
	signal?: AbortSignal,
): Promise<z.output<S>> {
	const { ok, status, json } = await fetchJson(`${BASE}/${path}`, signal, undefined, false);
	if (!ok)
		throw new SleeperDataError(`Sleeper ${what} responded ${status}`);
	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		throw new SleeperDataError(`Sleeper ${what} did not match its expected shape`);
	}
	return parsed.data;
}

export async function getNflState(signal?: AbortSignal): Promise<SleeperState> {
	const s = await getJson('state/nfl', stateSchema, 'NFL state', signal);
	return {
		week: s.week,
		season: s.season,
		seasonType: s.season_type,
		...('season_start_date' in s ? { seasonStartDate: s.season_start_date ?? null } : {}),
	};
}

export async function getLeague(leagueId: string, signal?: AbortSignal): Promise<SleeperLeague> {
	const l = await getJson(`league/${leagueId}`, leagueSchema, 'league', signal);
	if (l.settings.playoff_round_type !== 0) {
		throw new SleeperDataError('Multi-week playoff rounds are not supported in V1');
	}
	return {
		id: l.league_id,
		name: l.name,
		season: l.season,
		status: l.status,
		totalRosters: l.total_rosters,
		playoffWeekStart: l.settings.playoff_week_start,
		playoffRounds: 0, // filled by withBracketRounds once the bracket is known
		rosterPositions: l.roster_positions,
		...('scoring_settings' in l ? { scoringSettings: l.scoring_settings ?? null } : {}),
	};
}

export function withBracketRounds(league: SleeperLeague, games: BracketGame[]): SleeperLeague {
	const playoffRounds = Math.max(0, ...games.map(g => g.round));
	return { ...league, playoffRounds };
}

/** Joins rosters and users; a roster without an owner is unusable for recaps. */
export async function getManagers(leagueId: string, signal?: AbortSignal): Promise<SleeperManager[]> {
	const [users, rosters] = await Promise.all([
		getJson(`league/${leagueId}/users`, z.array(userSchema), 'league users', signal),
		getJson(`league/${leagueId}/rosters`, z.array(rosterSchema), 'league rosters', signal),
	]);
	const displayNameByUser = new Map(users.map(u => [u.user_id, u.display_name]));
	return rosters.map((roster) => {
		if (!roster.owner_id)
			throw new SleeperDataError(`Roster ${roster.roster_id} has no owner`);
		const displayName = displayNameByUser.get(roster.owner_id);
		if (!displayName) {
			throw new SleeperDataError(`Roster ${roster.roster_id} owner has no league user`);
		}
		return { rosterId: roster.roster_id, userId: roster.owner_id, displayName };
	});
}

export async function getScores(leagueId: string, week: number, signal?: AbortSignal): Promise<SleeperScore[]> {
	const entries = await getJson(`league/${leagueId}/matchups/${week}`, z.array(scoreSchema), `week ${week} matchups`, signal);
	if (entries.length === 0) {
		throw new SleeperDataError(`Sleeper returned no matchups for week ${week}`);
	}
	return entries.map(e => ({
		rosterId: e.roster_id,
		matchupId: e.matchup_id,
		// Sleeper points are 2-decimal; snap at read so sums never carry float dust.
		points: e.points == null ? null : Math.round(e.points * 100) / 100,
		starters: e.starters ?? [],
		players: e.players,
		playerPoints: Object.fromEntries(
			Object.entries(e.players_points)
				.filter((entry): entry is [string, number] => entry[1] != null)
				.map(([id, points]) => [id, Math.round(points * 100) / 100]),
		),
	}));
}

/** Legacy projection deliberately excludes identity detail from recap facts/history. */
export async function getPlayers(playerIds: Iterable<string>, signal?: AbortSignal): Promise<SleeperPlayer[]> {
	const { players } = await getPlayerSnapshot(playerIds, signal);
	return players.map(({ id, name, position }) => ({ id, name, position }));
}

/** Retains only requested catalog entries, including misses, for 24 hours. */
export async function getPlayerSnapshot(playerIds: Iterable<string>, signal?: AbortSignal): Promise<{
	players: SleeperPlayerDetails[];
	retrievedAtUtc: string | null;
	missingIds: string[];
}> {
	const ids = [...new Set(playerIds)];
	if (ids.length === 0)
		return { players: [], retrievedAtUtc: null, missingIds: [] };
	const now = Date.now();
	if (!playerCache || playerCache.expiresAt <= now || !ids.every(id => playerCache!.byId.has(id))) {
		const { ok, status, json } = await fetchJson(`${BASE}/players/nfl`, signal, undefined, false);
		if (!ok)
			throw new SleeperDataError(`Sleeper player catalog responded ${status}`);
		if (!json || typeof json !== 'object' || Array.isArray(json))
			throw new SleeperDataError('Sleeper player catalog did not match its expected shape');

		const catalog = json as Record<string, unknown>;
		const byId = new Map<string, SleeperPlayerDetails | null>();
		for (const id of ids) {
			const parsed = playerSchema.safeParse(Object.hasOwn(catalog, id) ? catalog[id] : undefined);
			const p = parsed.success ? parsed.data : null;
			byId.set(id, p?.player_id === id
				? {
						id: p.player_id,
						name: p.full_name ?? `${p.first_name} ${p.last_name}`,
						position: p.position,
						team: p.team ?? null,
						fantasyPositions: p.fantasy_positions ?? [],
						gsisId: p.gsis_id ?? null,
					}
				: null);
		}
		playerCache = { expiresAt: now + PLAYER_CACHE_MS, retrievedAtUtc: new Date().toISOString(), byId };
	}
	return {
		players: ids.flatMap(id => playerCache!.byId.get(id) ?? []),
		retrievedAtUtc: playerCache.retrievedAtUtc,
		missingIds: ids.filter(id => playerCache!.byId.get(id) == null),
	};
}

function epochMsToUtc(value: unknown): string | null {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function getTransactions(leagueId: string, week: number, signal?: AbortSignal): Promise<{
	transactions: SleeperTransaction[];
	malformedCount: number;
	retrievedAtUtc: string;
}> {
	if (typeof leagueId !== 'string' || !/^[\w-]+$/.test(leagueId) || !Number.isSafeInteger(week) || week < 1)
		throw new SleeperDataError('Sleeper transactions require a league ID and positive integer week');
	let rows: unknown[];
	try {
		rows = await getJson(`league/${leagueId}/transactions/${week}`, z.array(z.unknown()), 'transactions', signal);
	} catch {
		throw new SleeperDataError('Sleeper transactions could not be retrieved');
	}
	const retrievedAtUtc = new Date().toISOString();
	const idCounts = new Map<string, number>();
	for (const row of rows) {
		if (row && typeof row === 'object' && 'transaction_id' in row && typeof row.transaction_id === 'string') {
			idCounts.set(row.transaction_id, (idCounts.get(row.transaction_id) ?? 0) + 1);
		}
	}
	const transactions: SleeperTransaction[] = [];
	let malformedCount = 0;
	for (const row of rows) {
		const parsed = transactionSchema.safeParse(row);
		const t = parsed.success ? parsed.data : null;
		// Every duplicate row is unusable; never pick a winner from conflicting source IDs.
		if (!t || idCounts.get(t.transaction_id) !== 1 || t.leg !== week
			|| (t.league_id !== undefined && t.league_id !== leagueId)
			|| [...Object.values(t.adds ?? {}), ...Object.values(t.drops ?? {})].some(id => !t.roster_ids.includes(id))) {
			malformedCount += 1;
			continue;
		}
		transactions.push({
			id: t.transaction_id,
			type: t.type,
			status: t.status,
			week: t.leg,
			rosterIds: t.roster_ids,
			createdAtUtc: epochMsToUtc(t.created),
			statusUpdatedAtUtc: epochMsToUtc(t.status_updated),
			adds: Object.entries(t.adds ?? {}).map(([playerId, rosterId]) => ({ playerId, rosterId })),
			drops: Object.entries(t.drops ?? {}).map(([playerId, rosterId]) => ({ playerId, rosterId })),
			waiverBid: t.settings?.waiver_bid ?? null,
			draftPicks: (t.draft_picks ?? []).map(p => ({
				season: p.season,
				round: p.round,
				rosterId: p.roster_id,
				previousOwnerId: p.previous_owner_id,
				ownerId: p.owner_id,
			})),
			faabTransfers: (t.waiver_budget ?? []).map(({ sender, receiver, amount }) => ({ sender, receiver, amount })),
		});
	}
	return { transactions, malformedCount, retrievedAtUtc };
}

export async function getWinnersBracket(leagueId: string, signal?: AbortSignal): Promise<BracketGame[]> {
	const games = await getJson(`league/${leagueId}/winners_bracket`, z.array(bracketGameSchema), 'winners bracket', signal);
	if (games.length === 0)
		throw new SleeperDataError('Sleeper returned an empty winners bracket');
	return games.map(g => ({
		matchupId: g.m,
		round: g.r,
		placement: g.p ?? null,
		team1: g.t1,
		team2: g.t2,
		winner: g.w,
		loser: g.l,
		team1From: feeder(g.t1_from),
		team2From: feeder(g.t2_from),
	}));
}

function feeder(f: z.output<typeof feederSchema> | null | undefined): BracketFeeder | null {
	if (!f)
		return null;
	if (f.w != null)
		return { source: 'winner', matchupId: f.w };
	if (f.l != null)
		return { source: 'loser', matchupId: f.l };
	throw new SleeperDataError('Bracket feeder names no source matchup');
}

// --- Bracket structure -------------------------------------------------

export function playoffWeek(league: SleeperLeague, round: number): number {
	return league.playoffWeekStart + round - 1;
}

export function championshipWeek(league: SleeperLeague): number {
	return playoffWeek(league, league.playoffRounds);
}

/**
 * The path that leads to the championship: games reachable from the
 * `p: 1` game following winner feeders only. Loser-fed consolation and
 * placement games visible inside the winners-bracket listing stay out.
 */
export function winnerPathGameIds(games: BracketGame[]): Set<number> {
	const byId = new Map(games.map(g => [g.matchupId, g]));
	const championship = games.find(g => g.placement === 1);
	if (!championship)
		throw new SleeperDataError('Bracket has no championship game (no p: 1 entry)');

	const ids = new Set<number>();
	const stack = [championship];
	while (stack.length > 0) {
		const game = stack.pop()!;
		ids.add(game.matchupId);
		for (const from of [game.team1From, game.team2From]) {
			if (from?.source === 'winner') {
				const feederGame = byId.get(from.matchupId);
				if (!feederGame)
					throw new SleeperDataError(`Bracket feeder references unknown game ${from.matchupId}`);
				stack.push(feederGame);
			}
		}
	}
	return ids;
}

// --- Completion semantics ------------------------------------------------
// A non-final week is complete only once Sleeper's NFL state advances past it.
// The championship week is complete only when the league is marked complete
// and the p:1 game has a winner. display_week is deliberately never read.

export function isWeekComplete(
	week: number,
	state: SleeperState,
	league: SleeperLeague,
	games: BracketGame[],
): boolean {
	const finalWeek = championshipWeek(league);
	if (week > finalWeek)
		return false;
	if (week === finalWeek) {
		if (league.status !== 'complete')
			return false;
		const championship = games.find(g => g.placement === 1);
		return !!championship && championship.winner != null;
	}
	// If the NFL state has rolled into a newer season than the league's, every
	// non-final week is behind us regardless of the fresh low week number.
	const stateSeason = Number(state.season);
	const leagueSeason = Number(league.season);
	if (stateSeason !== leagueSeason)
		return stateSeason > leagueSeason;
	return state.week > week;
}

export function latestCompletedWeek(
	state: SleeperState,
	league: SleeperLeague,
	games: BracketGame[],
): number | null {
	const finalWeek = championshipWeek(league);
	// The championship can resolve without state.week having advanced past it.
	if (isWeekComplete(finalWeek, state, league, games))
		return finalWeek;
	const stateSeason = Number(state.season);
	const leagueSeason = Number(league.season);
	// Rolled into the next season: every non-final week is behind us.
	if (stateSeason > leagueSeason)
		return finalWeek - 1;
	if (stateSeason < leagueSeason)
		return null;
	// Non-final completion is monotone: state.week > W rules in every W.
	const newest = Math.min(state.week - 1, finalWeek - 1);
	return newest >= 1 ? newest : null;
}
