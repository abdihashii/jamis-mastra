import type { BracketGame, SleeperLeague, SleeperManager, SleeperPlayer, SleeperScore } from './sleeper';
import { championshipWeek, SleeperDataError, winnerPathGameIds } from './sleeper';

export interface TeamRef {
	rosterId: number;
	userId: string;
	displayName: string;
}

export interface MatchupResult {
	a: TeamRef;
	b: TeamRef;
	aPoints: number;
	bPoints: number;
	margin: number;
	/** null on an exact tie — tied honors stay tied, no invented winner. */
	winner: TeamRef | null;
	loser: TeamRef | null;
}

export interface ScoringExtreme {
	teams: TeamRef[];
	points: number;
}

export interface StandingRow {
	rank: number;
	team: TeamRef;
	wins: number;
	losses: number;
	ties: number;
	pointsFor: number;
}

export interface StandingMove {
	team: TeamRef;
	fromRank: number;
	toRank: number;
}

export interface UpcomingMatchup {
	a: TeamRef;
	b: TeamRef;
}

export type PlayerStoryCandidate
	= | { kind: 'top-starter'; team: TeamRef; player: SleeperPlayer; points: number }
		| {
			kind: 'bench-flip';
			team: TeamRef;
			opponent: TeamRef;
			benchedPlayer: SleeperPlayer;
			benchedPoints: number;
			startedPlayer: SleeperPlayer;
			startedPoints: number;
			pointSwing: number;
			lossMargin: number;
		};

type TopStarterCandidate = Extract<PlayerStoryCandidate, { kind: 'top-starter' }>;
type BenchFlipCandidate = Extract<PlayerStoryCandidate, { kind: 'bench-flip' }>;

export interface WeekFacts {
	leagueId: string;
	leagueName: string;
	season: string;
	week: number;
	isPlayoffWeek: boolean;
	isChampionshipWeek: boolean;
	results: MatchupResult[];
	high: ScoringExtreme | null;
	low: ScoringExtreme | null;
	closest: MatchupResult | null;
	blowout: MatchupResult | null;
	/** Regular season only; null for playoff weeks (standings freeze). */
	standings: StandingRow[] | null;
	/** Empty when there is no prior completed snapshot to compare with. */
	movement: StandingMove[];
	/** null on the championship week; [] when nothing is resolvable yet. */
	upcoming: UpcomingMatchup[] | null;
	playerStoryCandidates: PlayerStoryCandidate[];
}

export interface WeekFactsInput {
	league: SleeperLeague;
	week: number;
	managers: SleeperManager[];
	bracket: BracketGame[];
	/** Normalized matchup rows keyed by week, covering weeks 1..week. */
	scoresByWeek: Map<number, SleeperScore[]>;
	/** Matchup rows for week+1, regular season only. Omitted next to/inside playoffs. */
	nextWeekScores?: SleeperScore[];
	/** Missing catalog data simply removes player candidates, not matchup facts. */
	players?: SleeperPlayer[];
}

export function buildWeekFacts(input: WeekFactsInput): WeekFacts {
	const { league, week } = input;
	const champWeek = championshipWeek(league);
	if (week < 1 || week > champWeek) {
		throw new SleeperDataError(`Week ${week} is outside supported weeks 1..${champWeek}`);
	}
	const isPlayoffWeek = week >= league.playoffWeekStart;
	const isChampionshipWeek = week === champWeek;

	const teams = new Map(input.managers.map(m => [m.rosterId, m as TeamRef]));
	const results = isPlayoffWeek
		? playoffResults(input, league, week, teams)
		: regularResults(input.league, week, currentWeekScores(input, week), teams);

	const high = scoringExtreme(results, (a, b) => a > b);
	const low = scoringExtreme(results, (a, b) => a < b);
	const closest = matchupExtreme(results, (a, b) => a.margin < b.margin);
	const blowout = matchupExtreme(results, (a, b) => a.margin > b.margin);

	const standings = isPlayoffWeek ? null : buildStandings(input, week, teams);
	const movement = computeMovement(input, week, standings, teams);

	const upcoming = isChampionshipWeek ? null : computeUpcoming(input, teams);
	const playerStoryCandidates = buildPlayerStoryCandidates(currentWeekScores(input, week), results, teams, input.players ?? []);

	return {
		leagueId: league.id,
		leagueName: league.name,
		season: league.season,
		week,
		isPlayoffWeek,
		isChampionshipWeek,
		results,
		high,
		low,
		closest,
		blowout,
		standings,
		movement,
		upcoming,
		playerStoryCandidates,
	};
}

function buildPlayerStoryCandidates(
	scores: SleeperScore[],
	results: MatchupResult[],
	teams: Map<number, TeamRef>,
	players: SleeperPlayer[],
): PlayerStoryCandidate[] {
	const playerById = new Map(players.map(player => [player.id, player]));
	const topStarters = scores.flatMap((score) => {
		const team = teams.get(score.rosterId);
		if (!team)
			return [];
		return score.starters.flatMap((id): TopStarterCandidate[] => {
			const player = playerById.get(id);
			const points = score.playerPoints[id];
			return player && points != null ? [{ kind: 'top-starter', team, player, points }] : [];
		});
	})
		.sort((a, b) => b.points - a.points || a.player.id.localeCompare(b.player.id))
		.slice(0, 3);

	const scoreByRoster = new Map(scores.map(score => [score.rosterId, score]));
	const benchFlips = results.flatMap((result): BenchFlipCandidate[] => {
		if (!result.loser || !result.winner)
			return [];
		const score = scoreByRoster.get(result.loser.rosterId);
		if (!score)
			return [];
		const starterIds = new Set(score.starters);
		const options = score.players
			.filter(id => !starterIds.has(id))
			.flatMap((benchId) => {
				const benchedPlayer = playerById.get(benchId);
				const benchedPoints = score.playerPoints[benchId];
				if (!benchedPlayer || benchedPoints == null)
					return [];
				return score.starters.flatMap((starterId) => {
					const startedPlayer = playerById.get(starterId);
					const startedPoints = score.playerPoints[starterId];
					if (!startedPlayer || startedPoints == null || startedPlayer.position !== benchedPlayer.position)
						return [];
					const pointSwing = Math.round((benchedPoints - startedPoints) * 100) / 100;
					return pointSwing > result.margin
						? [{ benchedPlayer, benchedPoints, startedPlayer, startedPoints, pointSwing }]
						: [];
				});
			})
			.sort((a, b) => b.pointSwing - a.pointSwing
				|| a.benchedPlayer.id.localeCompare(b.benchedPlayer.id)
				|| a.startedPlayer.id.localeCompare(b.startedPlayer.id));
		const pick = options[0];
		return pick
			? [{ kind: 'bench-flip', team: result.loser, opponent: result.winner, ...pick, lossMargin: result.margin }]
			: [];
	});

	benchFlips.sort((a, b) => b.benchedPoints - a.benchedPoints || a.benchedPlayer.id.localeCompare(b.benchedPlayer.id));
	return [...topStarters, ...benchFlips];
}

function currentWeekScores(input: WeekFactsInput, week: number): SleeperScore[] {
	const scores = input.scoresByWeek.get(week);
	if (!scores)
		throw new SleeperDataError(`No matchup rows supplied for week ${week}`);
	return scores;
}

/** Groups rows into 2-team matchup pairs, skipping unpaired (bye) rows. */
function groupMatchupPairs(leagueName: string, week: number, scores: SleeperScore[]): Array<[SleeperScore, SleeperScore]> {
	const byMatchup = new Map<number, SleeperScore[]>();
	for (const score of scores) {
		if (score.matchupId == null)
			continue; // bye week: no opponent, still counts toward totals
		byMatchup.set(score.matchupId, [...(byMatchup.get(score.matchupId) ?? []), score]);
	}
	return [...byMatchup.values()].map((pair) => {
		if (pair.length !== 2) {
			throw new SleeperDataError(`League ${leagueName} week ${week}: ${pair.length}-team matchups are unsupported`);
		}
		return [pair[0], pair[1]];
	});
}

function pairUp(
	leagueName: string,
	week: number,
	scores: SleeperScore[],
	teams: Map<number, TeamRef>,
): MatchupResult[] {
	return groupMatchupPairs(leagueName, week, scores).map(([a, b]) => toResult(a, b, leagueName, week, teams));
}

function toResult(
	a: SleeperScore,
	b: SleeperScore,
	leagueName: string,
	week: number,
	teams: Map<number, TeamRef>,
): MatchupResult {
	if (a.points == null || b.points == null) {
		throw new SleeperDataError(`League ${leagueName} week ${week}: matchup has no points`);
	}
	const teamA = teams.get(a.rosterId);
	const teamB = teams.get(b.rosterId);
	if (!teamA || !teamB)
		throw new SleeperDataError(`League ${leagueName} week ${week}: unknown roster in matchup`);
	const margin = Math.round(Math.abs(a.points - b.points) * 100) / 100;
	const tied = a.points === b.points;
	return {
		a: teamA,
		b: teamB,
		aPoints: a.points,
		bPoints: b.points,
		margin,
		winner: tied ? null : a.points > b.points ? teamA : teamB,
		loser: tied ? null : a.points > b.points ? teamB : teamA,
	};
}

function regularResults(
	league: SleeperLeague,
	week: number,
	scores: SleeperScore[],
	teams: Map<number, TeamRef>,
): MatchupResult[] {
	return pairUp(league.name, week, scores, teams);
}

/** Winner-path bracket games for the playoff week, scored from that week's rows. */
function playoffResults(
	input: WeekFactsInput,
	league: SleeperLeague,
	week: number,
	teams: Map<number, TeamRef>,
): MatchupResult[] {
	const scores = currentWeekScores(input, week);
	const scoreByRoster = new Map(scores.map(s => [s.rosterId, s]));
	const pathIds = winnerPathGameIds(input.bracket);
	const round = week - league.playoffWeekStart + 1;
	const games = input.bracket.filter(g => g.round === round && pathIds.has(g.matchupId));
	if (games.length === 0) {
		throw new SleeperDataError(`No championship-path games found for playoff week ${week}`);
	}
	return games.map((game) => {
		if (game.team1 == null || game.team2 == null) {
			throw new SleeperDataError(`Playoff week ${week}: bracket game ${game.matchupId} lacks both teams`);
		}
		const a = scoreByRoster.get(game.team1);
		const b = scoreByRoster.get(game.team2);
		if (!a || !b) {
			throw new SleeperDataError(`Playoff week ${week}: missing scores for bracket game ${game.matchupId}`);
		}
		return toResult(a, b, league.name, week, teams);
	});
}

function scoringExtreme(
	results: MatchupResult[],
	better: (a: number, b: number) => boolean,
): ScoringExtreme | null {
	if (results.length === 0)
		return null;
	const sides = results.flatMap(r => [
		{ team: r.a, points: r.aPoints },
		{ team: r.b, points: r.bPoints },
	]);
	let best = sides[0].points;
	for (const side of sides) {
		if (better(side.points, best))
			best = side.points;
	}
	return { teams: sides.filter(s => s.points === best).map(s => s.team), points: best };
}

function matchupExtreme(
	results: MatchupResult[],
	better: (a: MatchupResult, b: MatchupResult) => boolean,
): MatchupResult | null {
	if (results.length === 0)
		return null;
	return results.reduce((pick, current) => (better(current, pick) ? current : pick));
}

function buildStandings(input: WeekFactsInput, throughWeek: number, teams: Map<number, TeamRef>): StandingRow[] {
	const wins = new Map<number, number>();
	const losses = new Map<number, number>();
	const ties = new Map<number, number>();
	const pointsFor = new Map<number, number>();
	for (const manager of input.managers) {
		wins.set(manager.rosterId, 0);
		losses.set(manager.rosterId, 0);
		ties.set(manager.rosterId, 0);
		pointsFor.set(manager.rosterId, 0);
	}
	for (let week = 1; week <= throughWeek; week += 1) {
		const scores = currentWeekScores(input, week);
		const outcomes = pairUp(input.league.name, week, scores, teams);
		for (const score of scores) {
			pointsFor.set(score.rosterId, (pointsFor.get(score.rosterId) ?? 0) + (score.points ?? 0));
		}
		for (const result of outcomes) {
			if (!result.winner) {
				// Tied matchup: neither side takes a loss it did not earn.
				ties.set(result.a.rosterId, (ties.get(result.a.rosterId) ?? 0) + 1);
				ties.set(result.b.rosterId, (ties.get(result.b.rosterId) ?? 0) + 1);
				continue;
			}
			wins.set(result.winner.rosterId, (wins.get(result.winner.rosterId) ?? 0) + 1);
			losses.set(result.loser!.rosterId, (losses.get(result.loser!.rosterId) ?? 0) + 1);
		}
	}
	const rows = input.managers.map(manager => ({
		team: manager as TeamRef,
		wins: wins.get(manager.rosterId) ?? 0,
		losses: losses.get(manager.rosterId) ?? 0,
		ties: ties.get(manager.rosterId) ?? 0,
		pointsFor: Math.round((pointsFor.get(manager.rosterId) ?? 0) * 100) / 100,
	}));
	// Wins, then total points. Equal neighbors rank deterministically by roster id.
	rows.sort((x, y) => y.wins - x.wins || y.pointsFor - x.pointsFor || x.team.rosterId - y.team.rosterId);
	return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

function computeMovement(
	input: WeekFactsInput,
	week: number,
	standings: StandingRow[] | null,
	teams: Map<number, TeamRef>,
): StandingMove[] {
	if (!standings || week <= 1)
		return [];
	const previous = buildStandings(input, week - 1, teams);
	const previousRank = new Map(previous.map(row => [row.team.rosterId, row.rank]));
	const movement: StandingMove[] = [];
	for (const row of standings) {
		const fromRank = previousRank.get(row.team.rosterId);
		if (fromRank != null && fromRank !== row.rank) {
			movement.push({ team: row.team, fromRank, toRank: row.rank });
		}
	}
	return movement;
}

function computeUpcoming(input: WeekFactsInput, teams: Map<number, TeamRef>): UpcomingMatchup[] {
	const nextWeek = input.week + 1;
	if (nextWeek < input.league.playoffWeekStart) {
		const scores = input.nextWeekScores;
		if (!scores || scores.length === 0)
			return [];
		return groupMatchupPairs(input.league.name, nextWeek, scores).map(([scoreA, scoreB]) => {
			const a = teams.get(scoreA.rosterId);
			const b = teams.get(scoreB.rosterId);
			if (!a || !b)
				throw new SleeperDataError(`Week ${nextWeek} matchups reference an unknown roster`);
			return { a, b };
		});
	}

	const pathIds = winnerPathGameIds(input.bracket);
	const nextRound = nextWeek - input.league.playoffWeekStart + 1;
	return input.bracket
		.filter(g => g.round === nextRound && pathIds.has(g.matchupId) && g.team1 != null && g.team2 != null)
		.map((game) => {
			const a = teams.get(game.team1!);
			const b = teams.get(game.team2!);
			if (!a || !b)
				throw new SleeperDataError(`Bracket game ${game.matchupId} references an unknown roster`);
			return { a, b };
		});
}
