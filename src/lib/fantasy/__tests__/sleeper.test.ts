import type { BracketGame, SleeperLeague, SleeperState } from '../sleeper';

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { resolveSleeperChatWindow } from '../chat-window';
import {

	championshipWeek,
	getLeague,
	getManagers,
	getNflSchedule,
	getNflState,
	getPlayers,
	getPlayerSnapshot,
	getScores,
	getTransactions,
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
	rosterPositions: ['QB', 'RB', 'WR', 'FLEX', 'BN'],
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
	roster_positions: ['QB', 'RB', 'WR', 'FLEX', 'BN'],
	settings: { playoff_week_start: 3, playoff_round_type: 0, playoff_teams: 4 },
};

describe('normalization', () => {
	it('parses NFL state', async () => {
		stubFetch({ 'state/nfl': { week: 10, season: '2026', season_type: 'regular' } });
		expect(await getNflState()).toEqual({ week: 10, season: '2026', seasonType: 'regular' });
	});

	it('normalizes league roster positions without adding absent optional fields', async () => {
		stubFetch({ [`league/${league.id}`]: leagueJson });
		expect(await getLeague(league.id)).toEqual({ ...league, playoffRounds: 0 });
	});

	it.each(['2020-09-10', '2024-02-29'])('retains a valid date-only season start: %s', async (date) => {
		stubFetch({ 'state/nfl': { week: 2, season: '2020', season_type: 'regular', season_start_date: date } });
		expect((await getNflState()).seasonStartDate).toBe(date);
	});

	it.each([null, 20260910, 'bad', '2026-02-30', '2026-2-01', '2026-09-10T00:00:00Z'])(
		'keeps malformed optional season dates unknown: %s',
		async (date) => {
			stubFetch({ 'state/nfl': { week: 2, season: '2026', season_type: 'regular', season_start_date: date } });
			expect((await getNflState()).seasonStartDate).toBeNull();
		},
	);

	it('retains finite league scoring rules including zero and negative values', async () => {
		const scoring = { rec: 0.5, pass_int: -2, bonus: 0 };
		stubFetch({ [`league/${league.id}`]: { ...leagueJson, scoring_settings: scoring } });
		expect((await getLeague(league.id)).scoringSettings).toEqual(scoring);
	});

	it.each([null, [], 'ppr', { rec: '1' }, { rec: Number.NaN }, { rec: Number.POSITIVE_INFINITY }])(
		'keeps malformed optional scoring rules unknown: %j',
		async (scoring) => {
			stubFetch({ [`league/${league.id}`]: { ...leagueJson, scoring_settings: scoring } });
			expect((await getLeague(league.id)).scoringSettings).toBeNull();
		},
	);

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
		stubFetch({
			[`league/${league.id}/matchups/2`]: [{
				roster_id: 1,
				matchup_id: 10,
				points: 100.005,
				starters: ['p1'],
				players: ['p1', 'p2'],
				players_points: { p1: 20.005, p2: 10 },
			}],
		});
		expect(await getScores(league.id, 2)).toEqual([{
			rosterId: 1,
			matchupId: 10,
			points: 100.01,
			starters: ['p1'],
			players: ['p1', 'p2'],
			playerPoints: { p1: 20.01, p2: 10 },
		}]);
	});

	it('accepts an unset upcoming lineup', async () => {
		stubFetch({
			[`league/${league.id}/matchups/2`]: [{
				roster_id: 1,
				matchup_id: 10,
				points: 0,
				starters: null,
				players: ['p1'],
				players_points: { p1: 0 },
			}],
		});
		expect((await getScores(league.id, 2))[0]?.starters).toEqual([]);
	});

	it('loads only requested player fields and caches the catalog', async () => {
		stubFetch({
			'players/nfl': {
				p1: { player_id: 'p1', full_name: 'Player One', position: 'RB', extra: 'ignored' },
				p2: { player_id: 'p2', full_name: 'Player Two', position: 'WR' },
			},
		});
		expect(await getPlayers(['p1', 'missing'])).toEqual([
			{ id: 'p1', name: 'Player One', position: 'RB' },
		]);
		expect(await getPlayers(['p1', 'missing'])).toEqual([
			{ id: 'p1', name: 'Player One', position: 'RB' },
		]);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
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

describe('player snapshots', () => {
	it('uses the documented player payload and shares rich cached detail with the legacy reader', async () => {
		stubFetch({
			'players/nfl': {
				3086: {
					player_id: '3086',
					first_name: 'Tom',
					last_name: 'Brady',
					position: 'QB',
					fantasy_positions: ['QB'],
					team: 'NE',
					gsis_id: '00-0019596',
				},
			},
		});
		const before = Date.now();
		expect(await getPlayers(['3086', 'snapshot-missing'])).toEqual([{ id: '3086', name: 'Tom Brady', position: 'QB' }]);
		const snapshot = await getPlayerSnapshot(['3086', '3086', 'snapshot-missing']);
		expect(snapshot.players).toEqual([{
			id: '3086',
			name: 'Tom Brady',
			position: 'QB',
			team: 'NE',
			fantasyPositions: ['QB'],
			gsisId: '00-0019596',
		}]);
		expect(snapshot.missingIds).toEqual(['snapshot-missing']);
		expect(snapshot.retrievedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
		expect(Date.parse(snapshot.retrievedAtUtc!)).toBeGreaterThanOrEqual(before);
		expect(Date.parse(snapshot.retrievedAtUtc!)).toBeLessThanOrEqual(Date.now());
		expect(await getPlayerSnapshot(['3086', 'snapshot-missing'])).toEqual(snapshot);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('does not fetch for empty IDs even with a populated cache', async () => {
		stubFetch({});
		expect(await getPlayerSnapshot([])).toEqual({ players: [], retrievedAtUtc: null, missingIds: [] });
		expect(await getPlayers([])).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('preserves missing detail without guessing positions or GSIS IDs and rejects mismatched keys', async () => {
		stubFetch({
			'players/nfl': {
				'detail-absent': { player_id: 'detail-absent', full_name: 'Absent', position: 'WR' },
				'detail-invalid': {
					player_id: 'detail-invalid',
					full_name: 'Invalid',
					position: 'RB',
					team: 32,
					fantasy_positions: ['RB', 1],
					gsis_id: '123456789',
				},
				'detail-null': {
					player_id: 'detail-null',
					full_name: 'Null',
					position: 'TE',
					team: null,
					fantasy_positions: null,
					gsis_id: null,
				},
				'detail-mismatch': { player_id: 'another-id', full_name: 'Wrong Identity', position: 'QB' },
				'detail-broken': { player_id: 'detail-broken', full_name: 'No Position' },
			},
		});
		const snapshot = await getPlayerSnapshot(['detail-absent', 'detail-invalid', 'detail-null', 'detail-mismatch', 'detail-broken']);
		expect(snapshot.players).toEqual([
			{ id: 'detail-absent', name: 'Absent', position: 'WR', team: null, fantasyPositions: [], gsisId: null },
			{ id: 'detail-invalid', name: 'Invalid', position: 'RB', team: null, fantasyPositions: [], gsisId: null },
			{ id: 'detail-null', name: 'Null', position: 'TE', team: null, fantasyPositions: [], gsisId: null },
		]);
		expect(snapshot.missingIds).toEqual(['detail-mismatch', 'detail-broken']);
		expect(await getPlayers(['detail-absent'])).toEqual([{ id: 'detail-absent', name: 'Absent', position: 'WR' }]);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('refreshes after 24 hours or when requested IDs are not retained', async () => {
		const clock = spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
		try {
			stubFetch({ 'players/nfl': {
				'cache-one': { player_id: 'cache-one', full_name: 'One', position: 'RB', team: 'NE', fantasy_positions: ['RB', 'WR'] },
				'cache-two': { player_id: 'cache-two', full_name: 'Two', position: 'TE' },
			} });
			await getPlayerSnapshot(['cache-one', 'cache-missing']);
			clock.mockReturnValue(2_000_000_000_000 + 24 * 60 * 60 * 1000 - 1);
			expect((await getPlayerSnapshot(['cache-one', 'cache-missing'])).players[0]?.fantasyPositions).toEqual(['RB', 'WR']);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			clock.mockReturnValue(2_000_000_000_000 + 24 * 60 * 60 * 1000);
			await getPlayerSnapshot(['cache-one', 'cache-missing']);
			expect(fetchSpy).toHaveBeenCalledTimes(2);
			await getPlayerSnapshot(['cache-two']);
			expect(fetchSpy).toHaveBeenCalledTimes(3);
		} finally {
			clock.mockRestore();
		}
	});

	it.each([null, []])('rejects a malformed catalog envelope: %j', async (body) => {
		stubFetch({ 'players/nfl': body });
		await expect(getPlayerSnapshot(['catalog-error'])).rejects.toThrow(SleeperDataError);
	});
});

const transactionJson = {
	type: 'free_agent',
	transaction_id: '434890120798142464',
	status_updated: 1558048393967,
	status: 'complete',
	settings: null,
	roster_ids: [1],
	metadata: { notes: 'private free text' },
	leg: 1,
	drops: { 1736: 1 },
	draft_picks: [],
	creator: '160000000000000000',
	created: 1558048393967,
	consenter_ids: [1],
	adds: { 2315: 1 },
	waiver_budget: [],
};

function stubTransactions(rows: unknown) {
	stubFetch({ [`league/${league.id}/transactions/1`]: rows });
}

describe('transactions', () => {
	it('normalizes documented free-agent and trade payloads without exposing free text or creator', async () => {
		stubTransactions([transactionJson, {
			type: 'trade',
			transaction_id: '434852362033561600',
			status_updated: 1558039402803,
			status: 'complete',
			settings: null,
			roster_ids: [2, 1],
			metadata: null,
			leg: 1,
			drops: null,
			draft_picks: [
				{ season: '2019', round: 5, roster_id: 1, previous_owner_id: 1, owner_id: 2 },
				{ season: '2019', round: 3, roster_id: 2, previous_owner_id: 2, owner_id: 1 },
			],
			creator: '160000000000000000',
			created: 1558039391576,
			consenter_ids: [2, 1],
			adds: null,
			waiver_budget: [{ sender: 2, receiver: 3, amount: 55 }],
		}]);
		const result = await getTransactions(league.id, 1);
		expect(result.malformedCount).toBe(0);
		expect(result.retrievedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
		expect(result.transactions[0]).toEqual({
			id: transactionJson.transaction_id,
			type: 'free_agent',
			status: 'complete',
			week: 1,
			rosterIds: [1],
			createdAtUtc: new Date(transactionJson.created).toISOString(),
			statusUpdatedAtUtc: new Date(transactionJson.status_updated).toISOString(),
			adds: [{ playerId: '2315', rosterId: 1 }],
			drops: [{ playerId: '1736', rosterId: 1 }],
			waiverBid: null,
			draftPicks: [],
			faabTransfers: [],
		});
		expect(result.transactions[1]?.draftPicks).toEqual([
			{ season: '2019', round: 5, rosterId: 1, previousOwnerId: 1, ownerId: 2 },
			{ season: '2019', round: 3, rosterId: 2, previousOwnerId: 2, ownerId: 1 },
		]);
		expect(result.transactions[1]?.faabTransfers).toEqual([{ sender: 2, receiver: 3, amount: 55 }]);
		expect(JSON.stringify(result)).not.toContain('160000000000000000');
		expect(JSON.stringify(result)).not.toContain('private free text');
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('retains complete, pending, and failed statuses without inferring completion', async () => {
		stubTransactions(['complete', 'pending', 'failed'].map((status, index) => ({
			...transactionJson,
			transaction_id: `waiver-${index}`,
			type: 'waiver',
			status,
			settings: { waiver_bid: 44 },
			created: Date.parse('2026-09-09T19:20:00-04:00'),
			status_updated: Date.parse('2026-09-10T03:20:00+02:00'),
		})));
		const { transactions, malformedCount } = await getTransactions(league.id, 1);
		expect(malformedCount).toBe(0);
		expect(transactions.map(t => t.status)).toEqual(['complete', 'pending', 'failed']);
		for (const t of transactions) {
			expect(t.waiverBid).toBe(44);
			expect(t.createdAtUtc).toBe('2026-09-09T23:20:00.000Z');
			expect(t.statusUpdatedAtUtc).toBe('2026-09-10T01:20:00.000Z');
		}
	});

	it.each([null, undefined, '1558048393967', Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 8_640_000_000_000_001])(
		'keeps missing or invalid epoch-ms timestamps unknown: %s',
		async (timestamp) => {
			stubTransactions([{ ...transactionJson, created: timestamp, status_updated: timestamp }]);
			const { transactions, malformedCount } = await getTransactions(league.id, 1);
			expect(malformedCount).toBe(0);
			expect(transactions[0]?.createdAtUtc).toBeNull();
			expect(transactions[0]?.statusUpdatedAtUtc).toBeNull();
		},
	);

	it('normalizes absent optional details to empty collections and unknown bid/time, not now', async () => {
		stubTransactions([{
			transaction_id: 'minimal',
			type: 'waiver',
			status: 'pending',
			leg: 1,
			roster_ids: [1],
		}]);
		expect((await getTransactions(league.id, 1)).transactions).toEqual([{
			id: 'minimal',
			type: 'waiver',
			status: 'pending',
			week: 1,
			rosterIds: [1],
			createdAtUtc: null,
			statusUpdatedAtUtc: null,
			adds: [],
			drops: [],
			waiverBid: null,
			draftPicks: [],
			faabTransfers: [],
		}]);
	});

	it('contains malformed rows while preserving independent valid transactions', async () => {
		const malformed = [
			null,
			'private free text',
			{},
			{ ...transactionJson, leg: 2 },
			{ ...transactionJson, league_id: 'different-league' },
			{ ...transactionJson, roster_ids: [] },
			{ ...transactionJson, roster_ids: [1, 1] },
			{ ...transactionJson, adds: { 2315: 2 } },
			{ ...transactionJson, drops: { 1736: 2 } },
			{ ...transactionJson, adds: { 2315: Number.POSITIVE_INFINITY } },
			{ ...transactionJson, settings: { waiver_bid: Number.NaN } },
			{ ...transactionJson, draft_picks: [{ season: '2019', round: 0, roster_id: 1, previous_owner_id: 1, owner_id: 2 }] },
			{ ...transactionJson, waiver_budget: [{ sender: 1, receiver: 2, amount: Number.POSITIVE_INFINITY }] },
		].map((row, i) => row && typeof row === 'object' ? { ...row, transaction_id: `broken-${i}` } : row);
		stubTransactions([malformed[0], transactionJson, ...malformed.slice(1)]);
		const { transactions, malformedCount } = await getTransactions(league.id, 1);
		expect(transactions.map(t => t.id)).toEqual([transactionJson.transaction_id]);
		expect(malformedCount).toBe(malformed.length);
	});

	it('excludes every duplicate ID even when one conflicting row is malformed', async () => {
		const rows = [
			{ ...transactionJson, transaction_id: 'conflict' },
			{ ...transactionJson, transaction_id: 'conflict', adds: { 2315: 2 } },
			{ ...transactionJson, transaction_id: 'identical' },
			{ ...transactionJson, transaction_id: 'identical' },
			transactionJson,
		];
		for (const ordered of [rows, [...rows].reverse()]) {
			stubTransactions(ordered);
			const result = await getTransactions(league.id, 1);
			expect(result.transactions.map(t => t.id)).toEqual([transactionJson.transaction_id]);
			expect(result.malformedCount).toBe(4);
			fetchSpy?.mockRestore();
		}
	});

	it('accepts a successful empty response distinctly from malformed or failed reads', async () => {
		stubTransactions([]);
		expect(await getTransactions(league.id, 1)).toEqual({ transactions: [], malformedCount: 0, retrievedAtUtc: expect.any(String) });
	});

	it.each([null, {}, { transactions: [] }, 'private free text'])('rejects malformed envelopes safely: %j', async (body) => {
		stubTransactions(body);
		await expect(getTransactions(league.id, 1)).rejects.toThrow(new SleeperDataError('Sleeper transactions could not be retrieved'));
	});

	it('rejects HTTP errors safely', async () => {
		stubFetch({});
		await expect(getTransactions(league.id, 1)).rejects.toThrow(new SleeperDataError('Sleeper transactions could not be retrieved'));
	});

	it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])('rejects invalid rounds without fetching: %s', async (week) => {
		stubFetch({});
		await expect(getTransactions(league.id, week)).rejects.toThrow(SleeperDataError);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it.each(['', 'league/../../other', 'league?week=2', 'league#fragment'])('rejects unsafe league scope without fetching: %s', async (id) => {
		stubFetch({});
		await expect(getTransactions(id, 1)).rejects.toThrow(SleeperDataError);
		expect(fetchSpy).not.toHaveBeenCalled();
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

	it('does not compare week numbers across an older NFL season', () => {
		const older = { week: 18, season: '2025', seasonType: 'post' };
		expect(isWeekComplete(2, older, league, bracket)).toBe(false);
		expect(latestCompletedWeek(older, league, bracket)).toBeNull();
	});
});

// Full public payloads captured by the Operator; gzip keeps these offline fixtures inside the authorized test file.
const regularScheduleCapture = [
	'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',
].join('');
const postseasonScheduleCapture = 'H4sIAAAAAAAC/52TXUvDMBSG/8rIlUILSbrWsrt+zU1kDreBICJhDbbYL2i1iOy/myLY45rGmsuenvTJec/Tx09UN6x5q9ECHVlx5BmPkYFi1nBRoZg6JiYmoaKWlHlX2/uheGg5f0ULYqAXlvPnNP5uti1MMBavWcs+RGl1d0AnAyLKvMq4+PYQgXtE4N2rEXaPuBW9OojVWo1wesS1P5lAesKN96AkEDCEf1jqIDaRkkAJjCnQIWz/iImCmHbTZwA6bdd7NcFV6TRurCs3lg4RFBrb9U6dwpXrJEU4esZe9Ygw2igRBOv55Ep9khGgT//5s8EQu8hTIiys8Gl02dQGMyyDWZi+p3VaFiybXbRpcfmDtIZIC25fenjimPAScFcyJtyVCF2DAIOUEWCQQ+FGkqQmBjZ4IowgYXklwqiTtDrLcj6kzs+zlByfNOvviwAtZVCoZRfL6ekLcEbc49UGAAA=';

interface ScheduleRow { game_id: string; week: number; date: string; status: string; home: string; away: string }
const scheduleRow: ScheduleRow = {
	game_id: '202610105',
	week: 1,
	date: '2026-09-13',
	status: 'complete',
	home: 'CAR',
	away: 'CHI',
};
const scheduleFailure = new SleeperDataError('Sleeper NFL schedule could not be retrieved');

function capturedSchedule(encoded: string, sha256: string): ScheduleRow[] {
	const bytes = gunzipSync(Buffer.from(encoded, 'base64'));
	expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
	return JSON.parse(bytes.toString('utf8'));
}

function stubSchedule(rows: unknown) {
	stubFetch({ '/schedule/nfl/regular/2026': rows });
}

describe('NFL schedule', () => {
	it('replays all 272 captured rows with original IDs, dates and statuses, using the non-v1 endpoint', async () => {
		const raw = capturedSchedule(regularScheduleCapture, '64ed9b6a898d7c0e51ad1c8ce0759c5de5ccfb1d8dfd3a2c11ab1c4dbe853f9a');
		expect(raw).toHaveLength(272);
		expect(raw.filter(g => g.status === 'complete')).toHaveLength(93);
		expect(raw.filter(g => g.status === 'pre_game')).toHaveLength(179);
		stubSchedule(raw);
		const before = Date.now();
		const snapshot = await getNflSchedule('2026', 'regular');
		expect(fetchSpy?.mock.calls[0]?.[0]).toBe('https://api.sleeper.app/schedule/nfl/regular/2026');
		expect(snapshot.season).toBe('2026');
		expect(snapshot.phase).toBe('regular');
		expect(Date.parse(snapshot.retrievedAtUtc)).toBeGreaterThanOrEqual(before);
		expect(Date.parse(snapshot.retrievedAtUtc)).toBeLessThanOrEqual(Date.now());
		expect(snapshot.games).toEqual(raw.map(({ game_id, home, away, ...game }) => ({
			id: game_id,
			...game,
			home: home === 'ARI' ? 'AZ' : home,
			away: away === 'ARI' ? 'AZ' : away,
		})));
		expect(resolveSleeperChatWindow(snapshot, 6, new Date('2026-10-21T02:00:00Z'))).toEqual({
			status: 'ready',
			window: { startAtUtc: '2026-10-15T00:00:00.000Z', endAtUtc: '2026-10-21T02:00:00.000Z' },
		});
		expect(resolveSleeperChatWindow(snapshot, 7, new Date('2026-10-21T02:00:00Z')).status).toBe('blocked');
	});

	it('replays 17 postseason rows, retaining 4 canceled placeholders and all 13 completed actual games', async () => {
		const raw = capturedSchedule(postseasonScheduleCapture, '945a718d14272ddc9db1cd5b39e2fe5c64551bfe4dae88f0cd378b1cb6a509d5');
		expect(raw).toHaveLength(17);
		expect(raw.filter(g => g.status === 'complete')).toHaveLength(13);
		expect(raw.filter(g => g.status === 'canceled')).toHaveLength(4);
		stubFetch({ '/schedule/nfl/post/2025': raw });
		const snapshot = await getNflSchedule('2025', 'post');
		expect(fetchSpy?.mock.calls[0]?.[0]).toBe('https://api.sleeper.app/schedule/nfl/post/2025');
		expect(snapshot.games).toEqual(raw.map(({ game_id, home, away, ...game }) => ({
			id: game_id,
			...game,
			home: home.includes('(win)') ? 'TBD' : home,
			away: away.includes('(win)') ? 'TBD' : away,
		})));
		expect(resolveSleeperChatWindow(snapshot, 19, new Date('2026-02-10T12:00:00Z'))).toEqual({
			status: 'ready',
			window: { startAtUtc: '2026-01-10T00:00:00.000Z', endAtUtc: '2026-01-17T00:00:00.000Z' },
		});
		expect(resolveSleeperChatWindow(snapshot, 22, new Date('2026-02-10T12:00:00Z'))).toEqual({
			status: 'ready',
			window: { startAtUtc: '2026-02-08T00:00:00.000Z', endAtUtc: '2026-02-10T12:00:00.000Z' },
		});
	});

	it.each([null, {}, { games: [] }, 'private 雪', [null], [{}]])('rejects malformed source envelopes: %#', async (rows) => {
		stubSchedule(rows);
		await expect(getNflSchedule('2026', 'regular')).rejects.toThrow(scheduleFailure);
	});

	it.each([
		{ date: '2026-02-30' },
		{ date: '2026-9-13' },
		{ date: '2026-09-13T00:00:00Z' },
		{ date: '2025-09-13' },
		{ date: '2028-01-01' },
		{ date: '２０２６-09-13' },
		{ game_id: '202510105' },
		{ game_id: '2026/private 雪' },
		{ game_id: '' },
		{ game_id: '202610105\n' },
		{ week: 0 },
		{ week: 19 },
		{ week: 1.5 },
		{ week: '1' },
		{ status: '' },
		{ status: 'complete\nprivate 雪' },
		{ status: 'complete\n' },
		{ status: null },
		{ date: '2026-09-13\n' },
		{ home: 'private 雪' },
		{ away: 'UNKNOWN' },
		{ home: 'NFC Divisional (win)' },
	])('rejects malformed game rows without returning source text: %#', async (patch) => {
		stubSchedule([{ ...scheduleRow, ...patch }]);
		await expect(getNflSchedule('2026', 'regular')).rejects.toThrow(scheduleFailure);
	});

	it('accepts empty data distinctly, rejects duplicates and bounds the entire source at 400 rows', async () => {
		stubSchedule([]);
		expect((await getNflSchedule('2026', 'regular')).games).toEqual([]);
		fetchSpy?.mockRestore();
		stubSchedule([scheduleRow, { ...scheduleRow, status: 'pre_game' }]);
		await expect(getNflSchedule('2026', 'regular')).rejects.toThrow(scheduleFailure);
		fetchSpy?.mockRestore();
		const rows = Array.from({ length: 400 }, (_, i) => ({ ...scheduleRow, game_id: `2026${i}` }));
		stubSchedule(rows);
		expect((await getNflSchedule('2026', 'regular')).games).toHaveLength(400);
		fetchSpy?.mockRestore();
		stubSchedule([...rows, { ...scheduleRow, game_id: '2026400' }]);
		await expect(getNflSchedule('2026', 'regular')).rejects.toThrow(scheduleFailure);
	});

	it('preserves unknown safe statuses and maps known club aliases without completion inference', async () => {
		stubSchedule([{ ...scheduleRow, status: 'new_status', home: 'ARI', away: 'JAC', date: '2027-01-01' }]);
		expect((await getNflSchedule('2026', 'regular')).games).toEqual([{
			id: scheduleRow.game_id,
			week: 1,
			date: '2027-01-01',
			status: 'new_status',
			home: 'AZ',
			away: 'JAX',
		}]);
	});

	it.each([0, 5, 19])('rejects out-of-phase postseason week %s', async (week) => {
		stubFetch({ '/schedule/nfl/post/2026': [{ ...scheduleRow, week }] });
		await expect(getNflSchedule('2026', 'post')).rejects.toThrow(scheduleFailure);
	});

	it.each(['', '../2026', '２０２６', '2026\nprivate 雪', '2026\n', '0000', '9999'])('rejects unsafe seasons before fetching: %#', async (season) => {
		stubSchedule([]);
		await expect(getNflSchedule(season, 'regular')).rejects.toThrow('Sleeper NFL schedule scope is invalid');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('rejects invalid runtime phases before fetching', async () => {
		stubSchedule([]);
		await expect(getNflSchedule('2026', 'pre' as 'regular')).rejects.toThrow('Sleeper NFL schedule scope is invalid');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('uses a 20-second timeout and supports caller aborts without leaking the reason or logging', async () => {
		const timeout = spyOn(AbortSignal, 'timeout');
		const log = spyOn(console, 'error').mockImplementation(() => {});
		const controller = new AbortController();
		let received: AbortSignal | null | undefined;
		try {
			fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_input, init) => {
				received = init?.signal;
				return new Promise<Response>((_resolve, reject) => {
					received?.addEventListener('abort', () => reject(received?.reason), { once: true });
				});
			}) as typeof fetch);
			const pending = getNflSchedule('2026', 'regular', controller.signal);
			expect(timeout).toHaveBeenCalledWith(20_000);
			controller.abort(new Error('private 雪 token=secret'));
			await expect(pending).rejects.toThrow(scheduleFailure);
			expect(received?.aborted).toBe(true);
			expect(log).not.toHaveBeenCalled();
		} finally {
			timeout.mockRestore();
			log.mockRestore();
		}
	});

	it('rejects already-aborted and timed-out calls without fetching or returning Unicode reasons', async () => {
		stubSchedule([]);
		await expect(getNflSchedule('2026', 'regular', AbortSignal.abort('private 雪'))).rejects.toThrow(scheduleFailure);
		const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort('private 雪 timeout'));
		try {
			await expect(getNflSchedule('2026', 'regular')).rejects.toThrow(scheduleFailure);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			timeout.mockRestore();
		}
	});

	it('contains HTTP, JSON and transport failures with fixed safe errors and no raw log', async () => {
		const log = spyOn(console, 'error').mockImplementation(() => {});
		try {
			fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private 雪', { status: 503 }));
			await expect(getNflSchedule('2026', 'regular')).rejects.toThrow(scheduleFailure);
			fetchSpy.mockResolvedValue(new Response('private 雪'));
			await expect(getNflSchedule('2026', 'regular')).rejects.toThrow(scheduleFailure);
			fetchSpy.mockRejectedValue(new Error('private 雪 secret'));
			await expect(getNflSchedule('2026', 'regular')).rejects.toThrow(scheduleFailure);
			expect(log).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});
});

describe('withBracketRounds', () => {
	it('copies the bracket round count onto the league', () => {
		const withRounds = withBracketRounds({ ...league, playoffRounds: 0 }, bracket);
		expect(withRounds.playoffRounds).toBe(2);
	});
});
