import type { BracketGame, SleeperLeague, SleeperState } from '../sleeper';

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {

	championshipWeek,
	getLeague,
	getManagers,
	getNflState,
	getScores,
	getWinnersBracket,
	isWeekComplete,
	latestCompletedWeek,
	SleeperDataError,

	winnerPathGameIds,
	withBracketRounds,
} from '../sleeper';

/** Mini anonymized league: 4 managers, playoffs weeks 3-4, one-week rounds. */
const league: SleeperLeague = {
	id: 'league-test',
	name: 'Test League',
	season: '2026',
	status: 'in_season',
	totalRosters: 4,
	playoffWeekStart: 3,
	playoffRounds: 2,
};

const bracket: BracketGame[] = [
	{ matchupId: 1, round: 1, placement: null, team1: 1, team2: 4, winner: null, loser: null, team1From: null, team2From: null },
	{ matchupId: 2, round: 1, placement: null, team1: 2, team2: 3, winner: null, loser: null, team1From: null, team2From: null },
	{
		matchupId: 3,
		round: 2,
		placement: 1,
		team1: null,
		team2: null,
		winner: null,
		loser: null,
		team1From: { source: 'winner', matchupId: 1 },
		team2From: { source: 'winner', matchupId: 2 },
	},
	{
		matchupId: 4,
		round: 2,
		placement: 3,
		team1: null,
		team2: null,
		winner: null,
		loser: null,
		team1From: { source: 'loser', matchupId: 1 },
		team2From: { source: 'loser', matchupId: 2 },
	},
];

function state(week: number, seasonType = 'regular'): SleeperState {
	return { week, season: '2026', seasonType };
}

let fetchSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
	fetchSpy?.mockRestore();
	fetchSpy = null;
});

/** Stubs the network behind fetchJson from a path->data map. */
function stubFetch(responses: Record<string, unknown>) {
	const stubbed = (async (input: RequestInfo | URL) => {
		const url = String(input);
		for (const [path, data] of Object.entries(responses)) {
			if (url.endsWith(path)) {
				return { ok: true, status: 200, json: async () => data } as Response;
			}
		}
		return { ok: false, status: 404, json: async () => null } as Response;
	}) as unknown as typeof fetch;
	fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(stubbed);
}

const leagueJson = {
	league_id: league.id,
	name: league.name,
	season: '2026',
	status: 'in_season',
	total_rosters: 4,
	settings: { playoff_week_start: 3, playoff_round_type: 0, playoff_teams: 4 },
};

describe('normalization', () => {
	it('parses NFL state', async () => {
		stubFetch({ 'state/nfl': { week: 10, season: '2026', season_type: 'regular' } });
		expect(await getNflState()).toEqual({ week: 10, season: '2026', seasonType: 'regular' });
	});

	it('rejects multi-week playoff rounds outright', async () => {
		stubFetch({ [`league/${league.id}`]: { ...leagueJson, settings: { ...leagueJson.settings, playoff_round_type: 1 } } });
		await expect(getLeague(league.id)).rejects.toThrow(SleeperDataError);
	});

	it('rejects a league body that deviates from the expected shape', async () => {
		stubFetch({ [`league/${league.id}`]: { league_id: league.id, settings: {} } });
		await expect(getLeague(league.id)).rejects.toThrow(SleeperDataError);
	});

	it('joins rosters and users into managers', async () => {
		stubFetch({
			[`league/${league.id}/users`]: [{ user_id: 'u1', display_name: 'gm-one' }],
			[`league/${league.id}/rosters`]: [{ roster_id: 1, owner_id: 'u1' }],
		});
		expect(await getManagers(league.id)).toEqual([{ rosterId: 1, userId: 'u1', displayName: 'gm-one' }]);
	});

	it('fails when a roster has no owner', async () => {
		stubFetch({
			[`league/${league.id}/users`]: [{ user_id: 'u1', display_name: 'gm-one' }],
			[`league/${league.id}/rosters`]: [{ roster_id: 1, owner_id: 'u1' }, { roster_id: 2, owner_id: null }],
		});
		await expect(getManagers(league.id)).rejects.toThrow('Roster 2 has no owner');
	});

	it('snaps points to two decimals and keeps matchup pairing', async () => {
		stubFetch({ [`league/${league.id}/matchups/2`]: [{ roster_id: 1, matchup_id: 10, points: 100.005 }] });
		expect(await getScores(league.id, 2)).toEqual([{ rosterId: 1, matchupId: 10, points: 100.01 }]);
	});

	it('rejects an empty matchup week', async () => {
		stubFetch({ [`league/${league.id}/matchups/2`]: [] });
		await expect(getScores(league.id, 2)).rejects.toThrow(SleeperDataError);
	});

	it('normalizes the winners bracket including loser feeders', async () => {
		// Real payloads always carry every key, unresolved values as null.
		stubFetch({
			[`league/${league.id}/winners_bracket`]: [
				{ m: 1, r: 1, t1: 1, t2: 4, w: null, l: null },
				{ m: 3, r: 2, p: 1, t1: null, t2: null, w: null, l: null, t1_from: { w: 1 }, t2_from: { w: 2 } },
				{ m: 4, r: 2, p: 3, t1: null, t2: null, w: null, l: null, t1_from: { l: 1 }, t2_from: { l: 2 } },
			],
		});
		const games = await getWinnersBracket(league.id);
		expect(games[2].team1From).toEqual({ source: 'loser', matchupId: 1 });
		expect(games[1].team1From).toEqual({ source: 'winner', matchupId: 1 });
		expect(games[0].team1).toBe(1);
	});

	it('rejects an empty bracket', async () => {
		stubFetch({ [`league/${league.id}/winners_bracket`]: [] });
		await expect(getWinnersBracket(league.id)).rejects.toThrow(SleeperDataError);
	});
});

describe('bracket structure', () => {
	it('maps the championship to the final playoff week', () => {
		expect(championshipWeek(league)).toBe(4);
	});

	it('walks the winner path back from the championship game only', () => {
		expect(winnerPathGameIds(bracket)).toEqual(new Set([1, 2, 3]));
	});

	it('handles a bye-seeded semifinal: direct team on one side, winner feeder on the other', () => {
		// The live league's real shape: later rounds mix direct t1/t2 with feeders.
		const withByeSemis: BracketGame[] = [
			{ matchupId: 1, round: 1, placement: null, team1: 1, team2: 4, winner: null, loser: null, team1From: null, team2From: null },
			{ matchupId: 2, round: 1, placement: null, team1: 2, team2: 3, winner: null, loser: null, team1From: null, team2From: null },
			{ matchupId: 3, round: 2, placement: null, team1: 5, team2: null, winner: null, loser: null, team1From: null, team2From: { source: 'winner', matchupId: 1 } },
			{ matchupId: 4, round: 2, placement: null, team1: 6, team2: null, winner: null, loser: null, team1From: null, team2From: { source: 'winner', matchupId: 2 } },
			{
				matchupId: 5,
				round: 3,
				placement: 1,
				team1: null,
				team2: null,
				winner: null,
				loser: null,
				team1From: { source: 'winner', matchupId: 3 },
				team2From: { source: 'winner', matchupId: 4 },
			},
		];
		expect(winnerPathGameIds(withByeSemis)).toEqual(new Set([1, 2, 3, 4, 5]));
	});

	it('fails when no championship game exists', () => {
		const broken = bracket.filter(g => g.placement !== 1);
		expect(() => winnerPathGameIds(broken)).toThrow(SleeperDataError);
	});
});

describe('week completion', () => {
	it('completes non-final weeks only after Sleeper advances', () => {
		expect(isWeekComplete(1, state(1), league, bracket)).toBe(false);
		expect(isWeekComplete(1, state(2), league, bracket)).toBe(true);
	});

	it('treats the championship separately: league complete plus a resolved winner', () => {
		expect(isWeekComplete(4, state(5), { ...league, status: 'in_season' }, bracket)).toBe(false);
		expect(isWeekComplete(4, state(5), { ...league, status: 'complete' }, bracket)).toBe(false);
		const resolved = bracket.map(g => (g.placement === 1 ? { ...g, winner: 1 } : g));
		expect(isWeekComplete(4, state(5), { ...league, status: 'complete' }, resolved)).toBe(true);
	});

	it('never completes weeks past the championship', () => {
		expect(isWeekComplete(5, state(6), { ...league, status: 'complete' }, bracket)).toBe(false);
	});

	it('reports the newest completed week, defaulting to state.week - 1', () => {
		expect(latestCompletedWeek(state(1), league, bracket)).toBeNull();
		expect(latestCompletedWeek(state(3), league, bracket)).toBe(2);
		// math.min keeps us inside supported weeks even when the NFL runs longer
		expect(latestCompletedWeek(state(10), league, bracket)).toBe(4 - 1);
	});

	it('returns the championship only when the league finished with a winner', () => {
		const resolved = bracket.map(g => (g.placement === 1 ? { ...g, winner: 1 } : g));
		expect(latestCompletedWeek(state(4), { ...league, status: 'complete' }, resolved)).toBe(4);
		expect(latestCompletedWeek(state(4), { ...league, status: 'complete' }, bracket)).toBe(3);
	});

	it('survives the NFL state rolling into the next season', () => {
		// state.week resets to 1 for 2027 while the 2026 league still exists: all
		// non-final weeks read as completed, and latest lands on the last playoff week.
		const rolled = { week: 1, season: '2027', seasonType: 'pre' };
		expect(isWeekComplete(2, rolled, league, bracket)).toBe(true);
		expect(latestCompletedWeek(rolled, league, bracket)).toBe(3);
	});
});

describe('withBracketRounds', () => {
	it('copies the bracket round count onto the league', () => {
		const withRounds = withBracketRounds({ ...league, playoffRounds: 0 }, bracket);
		expect(withRounds.playoffRounds).toBe(2);
	});
});
