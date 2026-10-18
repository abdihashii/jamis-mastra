import type { WeekFactsInput } from '../analysis';

import type { BracketGame, SleeperLeague, SleeperManager, SleeperPlayer, SleeperScore } from '../sleeper';
import { describe, expect, it } from 'bun:test';
import { buildWeekFacts, buildWeekSnapshot } from '../analysis';
import { SleeperDataError } from '../sleeper';

const managers: SleeperManager[] = [
	{ rosterId: 1, userId: 'u1', displayName: 'alpha' },
	{ rosterId: 2, userId: 'u2', displayName: 'bravo' },
	{ rosterId: 3, userId: 'u3', displayName: 'charlie' },
	{ rosterId: 4, userId: 'u4', displayName: 'delta' },
];

const league: SleeperLeague = {
	id: 'league-test',
	name: 'Test League',
	season: '2026',
	status: 'in_season',
	totalRosters: 4,
	playoffWeekStart: 3,
	playoffRounds: 2,
	rosterPositions: ['QB', 'RB', 'WR', 'FLEX', 'BN'],
};

const bracket: BracketGame[] = [
	{ matchupId: 1, round: 1, placement: null, team1: 1, team2: 4, winner: 1, loser: 4, team1From: null, team2From: null },
	{ matchupId: 2, round: 1, placement: null, team1: 2, team2: 3, winner: 2, loser: 3, team1From: null, team2From: null },
	{
		matchupId: 3,
		round: 2,
		placement: 1,
		team1: 1,
		team2: 2,
		winner: null,
		loser: null,
		team1From: { source: 'winner', matchupId: 1 },
		team2From: { source: 'winner', matchupId: 2 },
	},
	{
		matchupId: 4,
		round: 2,
		placement: 3,
		team1: 4,
		team2: 3,
		winner: null,
		loser: null,
		team1From: { source: 'loser', matchupId: 1 },
		team2From: { source: 'loser', matchupId: 2 },
	},
];

function score(
	rosterId: number,
	matchupId: number | null,
	points: number,
	lineup: Partial<Pick<SleeperScore, 'starters' | 'players' | 'playerPoints'>> = {},
): SleeperScore {
	return { rosterId, matchupId, points, starters: [], players: [], playerPoints: {}, ...lineup };
}

const week1 = [
	score(1, 10, 100),
	score(2, 10, 90),
	score(3, 11, 120),
	score(4, 11, 80),
];
const week2 = [
	score(1, 10, 110),
	score(3, 10, 70),
	score(2, 11, 95),
	score(4, 11, 100),
];
/** Playoff week 3 (semifinal round 1): consolation scores exist but stay excluded. */
const week3 = [
	score(1, 10, 130),
	score(4, 10, 60),
	score(2, 11, 85.5),
	score(3, 11, 85.5),
];
/** Championship week 4 (round 2): game 3 on the winner path, game 4 is the placement game. */
const week4 = [
	score(1, 10, 140),
	score(2, 10, 139),
	score(4, 11, 100),
	score(3, 11, 90),
];

function input(overrides: Partial<WeekFactsInput> & { week: number }): WeekFactsInput {
	return {
		league,
		managers,
		bracket,
		scoresByWeek: new Map([[1, week1], [2, week2], [3, week3], [4, week4]]),
		...overrides,
	};
}

describe('buildWeekSnapshot', () => {
	it('preserves current results when history is unavailable without weakening the legacy full-facts gate', () => {
		const full = buildWeekFacts(input({ week: 2 }));
		const partial = input({ week: 2, scoresByWeek: new Map([[2, week2]]) });
		const { standings: _standings, movement: _movement, upcoming: _upcoming, ...current } = full;
		expect(buildWeekSnapshot(partial)).toEqual(current);
		expect(() => buildWeekFacts(partial)).toThrow('No matchup rows supplied for week 1');
	});
});

describe('buildWeekFacts — regular season', () => {
	it('derives results, extremes, closest, blowout', () => {
		const facts = buildWeekFacts(input({ week: 1 }));
		expect(facts.results).toHaveLength(2);
		expect(facts.high).toEqual({ teams: [expect.objectContaining({ displayName: 'charlie' })], points: 120 });
		expect(facts.low).toEqual({ teams: [expect.objectContaining({ displayName: 'delta' })], points: 80 });
		expect(facts.closest!.margin).toBe(10);
		expect(facts.blowout!.margin).toBe(40);
	});

	it('ranks by wins then total points, with movement from the prior week', () => {
		const facts = buildWeekFacts(input({ week: 2 }));
		expect(facts.standings!.map(row => `${row.rank}:${row.team.displayName}`)).toEqual([
			'1:alpha',
			'2:charlie',
			'3:delta',
			'4:bravo',
		]);
		expect(facts.movement).toEqual([
			{ team: expect.objectContaining({ displayName: 'alpha' }), fromRank: 2, toRank: 1 },
			{ team: expect.objectContaining({ displayName: 'charlie' }), fromRank: 1, toRank: 2 },
			{ team: expect.objectContaining({ displayName: 'delta' }), fromRank: 4, toRank: 3 },
			{ team: expect.objectContaining({ displayName: 'bravo' }), fromRank: 3, toRank: 4 },
		]);
	});

	it('has no movement on the first completed week', () => {
		expect(buildWeekFacts(input({ week: 1 })).movement).toEqual([]);
	});

	it('keeps an exact tie as a tie: no invented winner or loser', () => {
		const tied = [
			score(1, 10, 100),
			score(2, 10, 100),
			score(3, 11, 120),
			score(4, 11, 80),
		];
		const facts = buildWeekFacts(input({ week: 1, scoresByWeek: new Map([[1, tied]]) }));
		const tiedResult = facts.results.find(r => r.margin === 0)!;
		expect(tiedResult.winner).toBeNull();
		expect(tiedResult.loser).toBeNull();
		// records stay honest: the tie is a tie, not a loss
		for (const name of ['alpha', 'bravo']) {
			const row = facts.standings!.find(s => s.team.displayName === name)!;
			expect([row.wins, row.losses, row.ties]).toEqual([0, 0, 1]);
		}
	});

	it('keeps tied weekly honors as a list instead of picking one', () => {
		const tiedHigh = [
			score(1, 10, 115),
			score(2, 10, 90),
			score(3, 11, 115),
			score(4, 11, 80),
		];
		const facts = buildWeekFacts(input({ week: 1, scoresByWeek: new Map([[1, tiedHigh]]) }));
		expect(facts.high!.teams.map(t => t.displayName).sort()).toEqual(['alpha', 'charlie']);
	});

	it('excludes bye-week rows from results but counts their points toward totals', () => {
		// Byes need an odd roster count: charlie sits out week 1 with a null matchup row.
		const threeManagers = managers.slice(0, 3);
		const byeWeek = [
			score(1, 10, 100),
			score(2, 10, 90),
			score(3, null, 113),
		];
		const facts = buildWeekFacts(input({
			week: 1,
			managers: threeManagers,
			league: { ...league, totalRosters: 3 },
			scoresByWeek: new Map([[1, byeWeek]]),
		}));
		expect(facts.results).toHaveLength(1);
		const charlieRow = facts.standings!.find(row => row.team.displayName === 'charlie')!;
		expect(charlieRow.wins).toBe(0);
		expect(charlieRow.pointsFor).toBe(113);
	});

	it('refuses matchups with more than two teams', () => {
		const triple = [
			score(1, 10, 100),
			score(2, 10, 90),
			score(3, 10, 120),
		];
		expect(() => buildWeekFacts(input({ week: 1, scoresByWeek: new Map([[1, triple]]) }))).toThrow(SleeperDataError);
	});

	it('lists next regular-season matchups from next week rows', () => {
		const facts = buildWeekFacts(input({ week: 1, nextWeekScores: week2 }));
		expect(facts.upcoming!.map(u => `${u.a.displayName} vs ${u.b.displayName}`).sort()).toEqual([
			'alpha vs charlie',
			'bravo vs delta',
		]);
	});

	it('curates three top starters and only match-flipping same-position bench players', () => {
		const players: SleeperPlayer[] = [
			{ id: 'q1', name: 'Quarterback One', position: 'QB' },
			{ id: 'q2', name: 'Quarterback Two', position: 'QB' },
			{ id: 'q3', name: 'Quarterback Three', position: 'QB' },
			{ id: 'q4', name: 'Quarterback Four', position: 'QB' },
			{ id: 'rb-low', name: 'Started Runner', position: 'RB' },
			{ id: 'rb-bench', name: 'Benched Runner', position: 'RB' },
			{ id: 'wr-low', name: 'Started Receiver', position: 'WR' },
			{ id: 'wr-bench', name: 'Benched Receiver', position: 'WR' },
		];
		const scores = [
			score(1, 10, 100, {
				starters: ['q1', 'rb-low'],
				players: ['q1', 'rb-low', 'rb-bench'],
				playerPoints: { 'q1': 30, 'rb-low': 5, 'rb-bench': 16 },
			}),
			score(2, 10, 110, {
				starters: ['q2'],
				players: ['q2'],
				playerPoints: { q2: 40 },
			}),
			score(3, 11, 120, {
				starters: ['q3'],
				players: ['q3'],
				playerPoints: { q3: 45 },
			}),
			score(4, 11, 80, {
				starters: ['q4', 'wr-low'],
				players: ['q4', 'wr-low', 'wr-bench'],
				playerPoints: { 'q4': 40, 'wr-low': 20, 'wr-bench': 60 },
			}),
		];
		const facts = buildWeekFacts(input({
			week: 1,
			players,
			scoresByWeek: new Map([[1, scores]]),
		}));

		expect(facts.playerStoryCandidates).toEqual([
			{
				kind: 'top-starter',
				team: expect.objectContaining({ displayName: 'charlie' }),
				player: players[2],
				points: 45,
			},
			{
				kind: 'top-starter',
				team: expect.objectContaining({ displayName: 'bravo' }),
				player: players[1],
				points: 40,
			},
			{
				kind: 'top-starter',
				team: expect.objectContaining({ displayName: 'delta' }),
				player: players[3],
				points: 40,
			},
			{
				kind: 'bench-flip',
				team: expect.objectContaining({ displayName: 'alpha' }),
				opponent: expect.objectContaining({ displayName: 'bravo' }),
				benchedPlayer: players[5],
				benchedPoints: 16,
				startedPlayer: players[4],
				startedPoints: 5,
				pointSwing: 11,
				lossMargin: 10,
			},
		]);
	});
});

describe('buildWeekFacts — playoffs', () => {
	it('covers only the winner path; ties in a semifinal stay tied', () => {
		const facts = buildWeekFacts(input({ week: 3 }));
		expect(facts.isPlayoffWeek).toBe(true);
		expect(facts.results).toHaveLength(2);
		expect(facts.results[0].winner!.displayName).toBe('alpha');
		// bravo 85.5 vs charlie 85.5: exact tie, no invented winner
		expect(facts.results[1].winner).toBeNull();
		// consolation-ish rows never influence extremes
		expect(facts.high!.points).toBe(130);
		expect(facts.low!.points).toBe(60);
		// standings freeze once playoffs start
		expect(facts.standings).toBeNull();
		expect(facts.movement).toEqual([]);
	});

	it('fails when bracket scores are missing for a playoff week', () => {
		const missing = input({ week: 3 });
		missing.scoresByWeek.set(3, [score(1, 10, 130), score(4, 10, 60)]);
		expect(() => buildWeekFacts(missing)).toThrow(/missing scores/);
	});

	it('derives the championship week with no upcoming matchup', () => {
		const facts = buildWeekFacts(input({ week: 4 }));
		expect(facts.isChampionshipWeek).toBe(true);
		expect(facts.results).toHaveLength(1);
		expect(facts.results[0].margin).toBe(1);
		expect(facts.upcoming).toBeNull();
	});

	it('lists resolved winner-path pairings as playoff-week upcoming', () => {
		const facts = buildWeekFacts(input({ week: 3 }));
		// game 3 (championship) is resolved to alpha vs bravo in the fixture
		expect(facts.upcoming).toEqual([
			{
				a: expect.objectContaining({ displayName: 'alpha' }),
				b: expect.objectContaining({ displayName: 'bravo' }),
			},
		]);
	});

	it('never fabricates upcoming when playoff teams are unresolved', () => {
		const unresolved = bracket.map(g => (g.round === 2 && g.placement === 1 ? { ...g, team1: null, team2: null } : g));
		const facts = buildWeekFacts(input({ week: 3, bracket: unresolved }));
		expect(facts.upcoming).toEqual([]);
	});
});

describe('buildWeekFacts — bounds', () => {
	it('rejects weeks outside the league calendar', () => {
		expect(() => buildWeekFacts(input({ week: 0 }))).toThrow(SleeperDataError);
		expect(() => buildWeekFacts(input({ week: 5 }))).toThrow(SleeperDataError);
	});

	it('refuses to proceed on a week with no score rows', () => {
		expect(() => buildWeekFacts(input({ week: 1, scoresByWeek: new Map() }))).toThrow(/No matchup rows/);
	});
});
