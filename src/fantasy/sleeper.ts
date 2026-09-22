import { z } from 'zod';

import { fetchJson } from '../lib/fetch';

/** Thrown for leagues outside V1's supported shape or incomplete Sleeper data. */
export class SleeperDataError extends Error {}

const BASE = 'https://api.sleeper.app/v1';

export interface SleeperState {
	week: number;
	season: string;
	seasonType: string;
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
});

const leagueSchema = z.looseObject({
	league_id: z.string(),
	name: z.string().min(1),
	season: z.string(),
	status: z.string(),
	total_rosters: z.number().int().positive(),
	roster_positions: z.array(z.string().min(1)),
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
	player_id: z.string(),
	full_name: z.string().min(1),
	position: z.string().min(1),
});

const PLAYER_CACHE_MS = 24 * 60 * 60 * 1_000;
let playerCache: { expiresAt: number; byId: Map<string, SleeperPlayer | null> } | null = null;

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
	const { ok, status, json } = await fetchJson(`${BASE}/${path}`, signal);
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
	return { week: s.week, season: s.season, seasonType: s.season_type };
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
	};
}

export function withBracketRounds(league: SleeperLeague, games: BracketGame[]): SleeperLeague {
	const playoffRounds = Math.max(0, ...games.map(g => g.round));
	return { ...league, playoffRounds };
}

/** Joins rosters and users; a roster without an owner is unusable for recaps. */
export async function getManagers(leagueId: string): Promise<SleeperManager[]> {
	const [users, rosters] = await Promise.all([
		getJson(`league/${leagueId}/users`, z.array(userSchema), 'league users'),
		getJson(`league/${leagueId}/rosters`, z.array(rosterSchema), 'league rosters'),
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

export async function getScores(leagueId: string, week: number): Promise<SleeperScore[]> {
	const entries = await getJson(`league/${leagueId}/matchups/${week}`, z.array(scoreSchema), `week ${week} matchups`);
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

/** Fetches the public player catalog but retains only fields needed by recap analysis. */
export async function getPlayers(playerIds: Iterable<string>): Promise<SleeperPlayer[]> {
	const ids = [...new Set(playerIds)];
	if (ids.length === 0)
		return [];
	const now = Date.now();
	if (playerCache && playerCache.expiresAt > now && ids.every(id => playerCache!.byId.has(id))) {
		return ids.flatMap(id => playerCache!.byId.get(id) ?? []);
	}

	const { ok, status, json } = await fetchJson(`${BASE}/players/nfl`);
	if (!ok)
		throw new SleeperDataError(`Sleeper player catalog responded ${status}`);
	if (!json || typeof json !== 'object' || Array.isArray(json))
		throw new SleeperDataError('Sleeper player catalog did not match its expected shape');

	const catalog = json as Record<string, unknown>;
	const byId = new Map<string, SleeperPlayer | null>();
	for (const id of ids) {
		const parsed = playerSchema.safeParse(catalog[id]);
		byId.set(id, parsed.success
			? { id: parsed.data.player_id, name: parsed.data.full_name, position: parsed.data.position }
			: null);
	}
	playerCache = { expiresAt: now + PLAYER_CACHE_MS, byId };
	return ids.flatMap(id => byId.get(id) ?? []);
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
	return Number(state.season) > Number(league.season) || state.week > week;
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
	// Rolled into the next season: every non-final week is behind us.
	if (Number(state.season) > Number(league.season))
		return finalWeek - 1;
	// Non-final completion is monotone: state.week > W rules in every W.
	const newest = Math.min(state.week - 1, finalWeek - 1);
	return newest >= 1 ? newest : null;
}
