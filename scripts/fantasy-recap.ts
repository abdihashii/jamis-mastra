import type { MatchupResult, WeekFacts } from '../src/fantasy/analysis';

import process from 'node:process';
import { buildWeekFacts } from '../src/fantasy/analysis';
import { parseFantasyConfig } from '../src/fantasy/config';
import {
	championshipWeek,
	getLeague,
	getManagers,
	getNflState,
	getScores,
	getWinnersBracket,
	isWeekComplete,
	SleeperDataError,
	withBracketRounds,
} from '../src/fantasy/sleeper';

const usage = 'bun run fantasy:recap inspect --week <number> [--allow-incomplete]';

async function main() {
	const [command, ...flags] = process.argv.slice(2);
	if (command !== 'inspect')
		fail(usage, 1);

	const weekFlag = flags.indexOf('--week');
	const week = Number(flags[weekFlag + 1]);
	if (weekFlag === -1 || !Number.isInteger(week))
		fail(usage, 1);
	// TODO: remove --allow-incomplete once the bot is live in the actual group chat.
	// Debug flag: bypasses the completed-week gate to preview mid-week facts.
	const allowIncomplete = flags.includes('--allow-incomplete');

	const config = parseFantasyConfig();
	if (!config)
		fail('Fantasy configuration is missing or incomplete; fix the FANTASY_* env vars first.', 1);

	const [state, rawLeague, managers, bracket] = await Promise.all([
		getNflState(),
		getLeague(config.sleeperLeagueId),
		getManagers(config.sleeperLeagueId),
		getWinnersBracket(config.sleeperLeagueId),
	]);
	const league = withBracketRounds(rawLeague, bracket);

	const completed = isWeekComplete(week, state, league, bracket);
	if (!allowIncomplete && !completed) {
		fail(
			`Week ${week} is not completed: Sleeper is on week ${state.week}, championship is week ${championshipWeek(league)}, league status is "${league.status}".`,
			1,
		);
	}

	const scoresByWeek = new Map<number, Awaited<ReturnType<typeof getScores>>>();
	for (let w = 1; w <= week; w += 1) {
		scoresByWeek.set(w, await getScores(config.sleeperLeagueId, w));
	}
	// Upcoming regular-season pairings come from the next week's matchup rows;
	// playoff pairings come from the resolved winners bracket instead.
	const needsNextMatchups = week + 1 < league.playoffWeekStart;
	const nextWeekScores = needsNextMatchups ? await getScores(config.sleeperLeagueId, week + 1) : undefined;

	print(buildWeekFacts({ league, week, managers, bracket, scoresByWeek, nextWeekScores }), !completed);
}

function print(facts: WeekFacts, provisional: boolean) {
	const kind = facts.isChampionshipWeek ? 'championship week' : facts.isPlayoffWeek ? 'playoff week' : 'regular season';
	console.log(`${facts.leagueName} (season ${facts.season}) — week ${facts.week} facts (${kind}${provisional ? ', in progress; facts are provisional' : ''})`);
	console.log('');

	console.log('Results:');
	for (const result of facts.results) console.log(`  ${renderResult(result)}`);

	if (facts.high)
		console.log(`\nHigh scorer: ${facts.high.points} — ${facts.high.teams.map(t => t.displayName).join(', ')}`);
	if (facts.low)
		console.log(`Low scorer: ${facts.low.points} — ${facts.low.teams.map(t => t.displayName).join(', ')}`);
	if (facts.closest)
		console.log(`Closest: ${renderResult(facts.closest)}`);
	if (facts.blowout)
		console.log(`Biggest blowout: ${renderResult(facts.blowout)}`);

	if (facts.standings) {
		console.log(`\nStandings after week ${facts.week}:`);
		for (const row of facts.standings) {
			const record = row.ties > 0 ? `${row.wins}-${row.losses}-${row.ties}` : `${row.wins}-${row.losses}`;
			console.log(`  ${row.rank}. ${row.team.displayName} (${record}, ${row.pointsFor} pts)`);
		}
	}
	if (facts.movement.length > 0) {
		console.log(`\nMovement: ${facts.movement.map(m => `${m.team.displayName} ${m.fromRank}→${m.toRank}`).join(', ')}`);
	}

	if (facts.upcoming === null) {
		console.log('\nUpcoming: none — the championship is decided.');
	}
	else if (facts.upcoming.length === 0) {
		console.log('\nUpcoming: no resolvable matchups yet.');
	}
	else {
		console.log(`\nUpcoming week ${facts.week + 1}:`);
		for (const pair of facts.upcoming) console.log(`  ${pair.a.displayName} vs ${pair.b.displayName}`);
	}
}

function renderResult(result: MatchupResult): string {
	const score = `${result.aPoints}–${result.bPoints}`;
	if (!result.winner)
		return `${result.a.displayName} ties ${result.b.displayName} (${score})`;
	return `${result.winner.displayName} def. ${result.loser!.displayName} (${score}, margin ${result.margin})`;
}

function fail(message: string, code: number): never {
	console.error(message);
	process.exit(code);
}

main().catch((error) => {
	if (error instanceof SleeperDataError)
		fail(error.message, 1);
	throw error;
});
