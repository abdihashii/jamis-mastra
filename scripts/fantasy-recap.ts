import type { MatchupResult, WeekFacts } from '../src/fantasy/analysis';
import type { SleeperManager } from '../src/fantasy/sleeper';

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { Mastra } from '@mastra/core/mastra';
import { PostgresStore } from '@mastra/pg';
import { buildWeekFacts } from '../src/fantasy/analysis';
import { parseFantasyConfig } from '../src/fantasy/config';
import {
	buildRecapPrompt,
	createFantasyAgent,
	FANTASY_GENERATOR_VERSION,
	recapShapingSchema,
	ShapingValidationError,
	toChatContext,
	validateShaping,
} from '../src/fantasy/generate';
import { ensureFantasyRecapsTable, recordGeneration } from '../src/fantasy/recaps';
import { RECAP_MAX_LENGTH, renderWeekRecap } from '../src/fantasy/render';
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
import { openAICodexGateway } from '../src/mastra/gateways/openai-codex-gateway.js';

const usage = 'bun run fantasy:recap <inspect|preview> --week <number> [--allow-incomplete] [--model <id>] [--chat <file.json>]';

// TODO(ponytail): --model and FANTASY_RECAP_MODEL exist for the A/B voice window.
// Once a winner ships, hardcode the winner here and delete the override machinery.
const DEFAULT_RECAP_MODEL = 'neuralwatt/kimi-k3';

async function main() {
	const [command, ...flags] = process.argv.slice(2);
	if (command !== 'inspect' && command !== 'preview')
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

	const facts = buildWeekFacts({ league, week, managers, bracket, scoresByWeek, nextWeekScores });
	if (command === 'inspect') {
		print(facts, !completed);
		return;
	}

	const modelFlag = flags.indexOf('--model');
	const modelFlagValue = flags[modelFlag + 1];
	const model = (modelFlag >= 0 && modelFlagValue && !modelFlagValue.startsWith('--') ? modelFlagValue : undefined)
		?? config.recapModel
		?? DEFAULT_RECAP_MODEL;

	const chatFlag = flags.indexOf('--chat');
	const chatPath = chatFlag >= 0 ? flags[chatFlag + 1] : undefined;
	if (chatFlag >= 0 && (!chatPath || chatPath.startsWith('--')))
		fail(usage, 1);
	const context = chatPath
		? await loadChatFixture(chatPath, managers)
		: toChatContext(await readThreadMessages(config.sendblueGroupId), config, managers);

	// A bare Mastra instance only so custom gateways (openai-codex/*) resolve.
	const mastra = new Mastra({
		gateways: { 'openai-codex': openAICodexGateway },
		agents: { fantasy: createFantasyAgent(model) },
	});
	const result = await mastra.getAgent('fantasy').generate(buildRecapPrompt(facts, context), {
		structuredOutput: { schema: recapShapingSchema },
	});
	if (!result.object)
		fail('The model returned no structured recap output.', 1);
	const shaping = validateShaping(result.object, context, facts);
	const text = renderWeekRecap(facts, shaping, context);

	console.log(text);
	console.log(`\n(${FANTASY_GENERATOR_VERSION} / ${model} — ${text.length}/${RECAP_MAX_LENGTH} chars, ${shaping.callbacks.length} callbacks)`);

	try {
		await ensureFantasyRecapsTable();
		await recordGeneration({
			leagueId: league.id,
			fantasyWeek: week,
			generatorVersion: FANTASY_GENERATOR_VERSION,
			model,
			finalText: text,
			facts,
		});
		console.log('(recorded in fantasy_recap_generations)');
	}
	catch (error) {
		console.error('[fantasy-recap] generation not recorded:', error);
	}
}

interface ChatFixtureEntry {
	id: string;
	senderNumber: string;
	text: string;
}

/** Debug helper: load a synthetic banter file so voice tests use shared chat input. */
async function loadChatFixture(path: string, managers: SleeperManager[]) {
	let raw: string;
	try {
		raw = await readFile(path, 'utf8');
	}
	catch {
		throw new SleeperDataError(`--chat file is unreadable: ${path}`);
	}
	let entries: ChatFixtureEntry[];
	try {
		entries = JSON.parse(raw) as ChatFixtureEntry[];
	}
	catch {
		throw new SleeperDataError(`--chat file is not valid JSON: ${path}`);
	}
	const displayNameByUserId = new Map(managers.map(m => [m.userId, m.displayName]));
	const config = parseFantasyConfig();
	return entries.map(entry => ({
		id: entry.id,
		text: entry.text,
		sender: (config && displayNameByUserId.get(config.managerMap[entry.senderNumber])) || 'unknown sender',
	}));
}

/** Reads the archived fantasy thread newest-first; anything odd reads as an empty week. */
async function readThreadMessages(groupId: string) {
	try {
		const store = await new PostgresStore({ url: process.env.DATABASE_URL! }).getStore('memory');
		if (!store)
			throw new Error('no memory store');
		const { messages } = await store.listMessages({
			threadId: `fantasy-group-${groupId}`,
			perPage: 40,
			orderBy: { field: 'createdAt', direction: 'DESC' },
		});
		return messages;
	}
	catch (error) {
		console.error('[fantasy-recap] could not read chat context; proceeding with none:', error);
		return [];
	}
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
	if (error instanceof SleeperDataError || error instanceof ShapingValidationError)
		fail(error.message, 1);
	throw error;
});
