import type { MatchupResult, WeekFacts } from '../src/lib/fantasy/analysis';
import type { FantasyConfig } from '../src/lib/fantasy/config';
import type { ChatContextMessage, RecapGenerator } from '../src/lib/fantasy/generate';
import type { RecapGenerationRecord } from '../src/lib/fantasy/recaps';

import type { SleeperManager } from '../src/lib/fantasy/sleeper';
import { SQL } from 'bun';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { Mastra } from '@mastra/core/mastra';
import { PostgresStore } from '@mastra/pg';
import { buildWeekFacts } from '../src/lib/fantasy/analysis';
import { parseFantasyConfig } from '../src/lib/fantasy/config';
import { confirmSent, retryWeek } from '../src/lib/fantasy/coordinator';
import { runDailyRecap } from '../src/lib/fantasy/daily';
import {
	buildRecapPrompt,
	DEFAULT_RECAP_MODEL,
	FANTASY_GENERATOR_VERSION,
	generateWithRepair,
	recapShapingSchema,
	ShapingValidationError,
	toChatContext,
} from '../src/lib/fantasy/generate';

import { ensureFantasyRecapsTable, getFantasySql, recordClaimedGeneration } from '../src/lib/fantasy/recaps';
import { RECAP_MAX_LENGTH, renderWeekRecap } from '../src/lib/fantasy/render';
import { createRunsStore } from '../src/lib/fantasy/runs';
import {
	championshipWeek,
	getLeague,
	getManagers,
	getNflState,
	getPlayers,
	getScores,
	getWinnersBracket,
	isWeekComplete,
	SleeperDataError,
	withBracketRounds,
} from '../src/lib/fantasy/sleeper';
import { createFantasyFootballPundit } from '../src/mastra/agents/fantasy-football-pundit';
import { openAICodexGateway } from '../src/mastra/gateways/openai-codex-gateway.js';

const usage = [
	'bun run fantasy:recap <command>',
	'  inspect --week <number> [--allow-incomplete]   print deterministic facts only',
	'  preview --week <number> [--chat <file.json>] [--allow-incomplete]   generate, never send',
	'  run                                            normal daily job: newest completed week only',
	'  retry --week <number> [--operator-verified-absent]',
	'  confirm-sent --week <number>                   operator observed the message in the group',
].join('\n');

async function main() {
	const [command, ...flags] = process.argv.slice(2);
	if (!command || !['inspect', 'preview', 'run', 'retry', 'confirm-sent'].includes(command))
		fail(usage, 1);

	const config = parseFantasyConfig();
	if (!config)
		fail('Fantasy configuration is missing or incomplete; fix the FANTASY_* env vars first.', 1);

	// TODO: remove --allow-incomplete once the bot is live in the actual group chat.
	// Debug flag: bypasses the completed-week gate to preview mid-week facts.
	const allowIncomplete = flags.includes('--allow-incomplete');

	if (command === 'run') {
		// Same flow the scheduled workflow runs; the local shim only adds gateways/storage.
		const shim = new Mastra({
			gateways: { 'openai-codex': openAICodexGateway },
			agents: { 'fantasy-football-pundit': createFantasyFootballPundit(DEFAULT_RECAP_MODEL) },
			storage: new PostgresStore({ id: 'fantasy-cli-storage', connectionString: process.env.DATABASE_URL! }),
		});
		const result = await runDailyRecap(config, shim);
		console.log(`run: ${result.outcome}${result.week != null ? ` (week ${result.week})` : ''}`);
		if (result.outcome === 'failed' || result.outcome === 'delivery_unknown' || result.outcome === 'error')
			process.exitCode = 1;
		return;
	}

	const weekFlag = flags.indexOf('--week');
	const week = Number(flags[weekFlag + 1]);
	if (weekFlag === -1 || !Number.isInteger(week))
		fail(usage, 1);

	if (command === 'retry' || command === 'confirm-sent') {
		const deps = await coordinatorDeps(config);
		if (command === 'retry') {
			const result = await retryWeek(week, flags.includes('--operator-verified-absent'), deps);
			if (!result.ok)
				fail(`not retried: ${result.reason}`, 1);
			console.log(`week ${result.week}: resend outcome ${result.outcome}`);
			if (result.outcome === 'failed' || result.outcome === 'delivery_unknown')
				process.exitCode = 1;
			return;
		}
		const confirmed = await confirmSent(week, deps);
		if (!confirmed)
			fail(`week ${week} is not delivery_unknown; nothing to confirm`, 1);
		console.log(`week ${week}: recorded sent (source: operator, effective time: original send attempt)`);
		return;
	}

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

	const facts = await factsFor(config, league, managers, bracket, week);
	if (command === 'inspect') {
		print(facts, !completed);
		return;
	}

	const model = DEFAULT_RECAP_MODEL;

	const chatFlag = flags.indexOf('--chat');
	const chatPath = chatFlag >= 0 ? flags[chatFlag + 1] : undefined;
	if (chatFlag >= 0 && (!chatPath || chatPath.startsWith('--')))
		fail(usage, 1);
	const previewSql = chatPath ? null : new SQL(readOnlyDatabaseUrl());
	const before = previewSql ? await recapRowCounts(previewSql, config.sleeperLeagueId) : null;
	const context = chatPath
		? await loadChatFixture(chatPath, managers)
		: toChatContext(await readThreadMessages(config.sendblueGroupId), config, managers);

	const shaping = await generateWithRepair(shapingGenerator(model), facts, context);
	const text = renderWeekRecap(facts, shaping, context);
	const after = previewSql ? await recapRowCounts(previewSql, config.sleeperLeagueId) : null;
	if (before && after && (before.generations !== after.generations || before.runs !== after.runs))
		throw new Error('Preview changed fantasy recap row counts');

	console.log(text);
	const callbacks = shaping.editorial.flatMap(story => story.sentences).filter(sentence => sentence.callbackMessageId != null).length;
	console.log(`\n(${FANTASY_GENERATOR_VERSION} / ${model}: ${text.length}/${RECAP_MAX_LENGTH} chars, ${callbacks} callbacks)`);
	console.log(chatSummary(context));
	if (before)
		console.log(`Database rows unchanged: ${before.generations} generations, ${before.runs} runs.`);
}

interface ChatFixtureEntry {
	id: string;
	senderNumber: string;
	text: string;
	createdAt: string;
}

/** Debug helper: load a synthetic banter file so voice tests use shared chat input. */
async function loadChatFixture(path: string, managers: SleeperManager[]) {
	let raw: string;
	try {
		raw = await readFile(path, 'utf8');
	} catch {
		throw new SleeperDataError(`--chat file is unreadable: ${path}`);
	}
	let entries: ChatFixtureEntry[];
	try {
		entries = JSON.parse(raw) as ChatFixtureEntry[];
	} catch {
		throw new SleeperDataError(`--chat file is not valid JSON: ${path}`);
	}
	const displayNameByUserId = new Map(managers.map(m => [m.userId, m.displayName]));
	const config = parseFantasyConfig();
	const context = entries.flatMap((entry): ChatContextMessage[] => {
		const sender = config && displayNameByUserId.get(config.managerMap[entry.senderNumber]);
		const timestamp = Date.parse(entry.createdAt);
		if (!Number.isFinite(timestamp) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(entry.createdAt))
			throw new SleeperDataError(`--chat entry ${entry.id} has an invalid createdAt`);
		return sender ? [{ id: entry.id, text: entry.text, sender, createdAt: new Date(timestamp).toISOString() }] : [];
	});
	return context.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Reads the archived fantasy thread newest-first. Preview failures stay visible. */
async function readThreadMessages(groupId: string, since?: Date) {
	try {
		const store = await new PostgresStore({
			id: 'fantasy-preview-storage',
			connectionString: readOnlyDatabaseUrl(),
			disableInit: true,
		}).getStore('memory');
		if (!store)
			throw new Error('no memory store');
		const { messages } = await store.listMessages({
			threadId: `fantasy-group-${groupId}`,
			perPage: 200,
			filter: since ? { dateRange: { start: since, startExclusive: true } } : undefined,
			orderBy: { field: 'createdAt', direction: 'DESC' },
		});
		return messages;
	} catch {
		throw new Error('Archived chat could not be read in preview mode');
	}
}

function readOnlyDatabaseUrl(): string {
	const value = process.env.DATABASE_URL;
	if (!value)
		throw new Error('DATABASE_URL is required for archived-chat preview');
	const url = new URL(value);
	const setting = '-c default_transaction_read_only=on';
	const options = url.searchParams.get('options');
	url.searchParams.set('options', options ? `${options} ${setting}` : setting);
	return url.toString();
}

async function recapRowCounts(sql: SQL, leagueId: string): Promise<{ generations: number; runs: number }> {
	const [setting] = await sql`SHOW default_transaction_read_only` as Array<{ default_transaction_read_only: string }>;
	if (setting?.default_transaction_read_only !== 'on')
		throw new Error('Preview database connection is not read-only');
	const [row] = await sql`
		SELECT
			(
				SELECT
					count(*)::int
				FROM
					fantasy_recap_generations
				WHERE
					league_id = ${leagueId}
			) AS generations,
			(
				SELECT
					count(*)::int
				FROM
					fantasy_recap_runs
				WHERE
					league_id = ${leagueId}
			) AS runs
	` as Array<{ generations: number; runs: number }>;
	if (!row)
		throw new Error('Preview database row counts unavailable');
	return row;
}

function chatSummary(context: ChatContextMessage[]): string {
	if (context.length === 0)
		return 'Archived chat: 0 mapped messages.';
	const timestamps = context.map(message => message.createdAt).sort();
	return `Archived chat: ${context.length} mapped messages, ${timestamps[0]} to ${timestamps.at(-1)} UTC.`;
}

/** All week-N matchup rows + (regular season) week N+1 for the upcoming slate. */
async function factsFor(
	config: FantasyConfig,
	league: ReturnType<typeof withBracketRounds>,
	managers: SleeperManager[],
	bracket: Awaited<ReturnType<typeof getWinnersBracket>>,
	week: number,
): Promise<WeekFacts> {
	const scoresByWeek = new Map<number, Awaited<ReturnType<typeof getScores>>>();
	for (let w = 1; w <= week; w += 1) {
		scoresByWeek.set(w, await getScores(config.sleeperLeagueId, w));
	}
	// Upcoming regular-season pairings come from the next week's matchup rows;
	// playoff pairings come from the resolved winners bracket instead.
	const nextWeekScores = week + 1 < league.playoffWeekStart ? await getScores(config.sleeperLeagueId, week + 1) : undefined;
	let players: Awaited<ReturnType<typeof getPlayers>> = [];
	try {
		const scores = scoresByWeek.get(week) ?? [];
		players = await getPlayers(scores.flatMap(score => [...score.players, ...score.starters]));
	} catch (error) {
		console.warn('[fantasy-recap] player catalog unavailable; continuing without player stories:', error);
	}
	return buildWeekFacts({ league, week, managers, bracket, scoresByWeek, nextWeekScores, players });
}

/** Structured-output generation for one model id; the one call shape both run and preview share. */
function shapingGenerator(model: string): RecapGenerator {
	// A bare Mastra instance only so custom gateways (openai-codex/*) resolve.
	const mastra = new Mastra({
		gateways: { 'openai-codex': openAICodexGateway },
		agents: { 'fantasy-football-pundit': createFantasyFootballPundit(model) },
	});
	return async (facts, context, correction) => {
		const result = await mastra.getAgent('fantasy-football-pundit').generate(buildRecapPrompt(facts, context, correction), {
			structuredOutput: { schema: recapShapingSchema },
			tracingOptions: { hideInput: true, hideOutput: true },
		});
		if (!result.object)
			throw new ShapingValidationError('the model returned no structured recap output');
		return result.object;
	};
}

async function coordinatorDeps(config: FantasyConfig) {
	// Dynamic import: inspect/preview must never require Sendblue env vars.
	const { sendblueSendClient } = await import('../src/lib/fantasy/deliver');
	const sql = getFantasySql();
	return {
		runs: createRunsStore(config.sleeperLeagueId, sql),
		recaps: { ensureSchema: () => ensureFantasyRecapsTable(sql), record: (record: RecapGenerationRecord, claimToken: string) => recordClaimedGeneration(record, claimToken, sql) },
		groupId: config.sendblueGroupId,
		leagueId: config.sleeperLeagueId,
		readThreadMessages: (since?: Date) => readThreadMessages(config.sendblueGroupId, since),
		send: sendblueSendClient,
		now: () => new Date(),
	};
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
	if (facts.playerStoryCandidates.length > 0) {
		console.log('\nPlayer story candidates:');
		for (const candidate of facts.playerStoryCandidates) {
			if (candidate.kind === 'top-starter') {
				console.log(`  Top starter: ${candidate.player.name} (${candidate.player.position}) scored ${candidate.points} for ${candidate.team.displayName}`);
			} else {
				console.log(`  Bench flip: ${candidate.benchedPlayer.name} (${candidate.benchedPoints}) over ${candidate.startedPlayer.name} (${candidate.startedPoints}) would add ${candidate.pointSwing} for ${candidate.team.displayName}, above the ${candidate.lossMargin}-point loss to ${candidate.opponent.displayName}`);
			}
		}
	}

	if (facts.upcoming === null) {
		console.log('\nUpcoming: none — the championship is decided.');
	} else if (facts.upcoming.length === 0) {
		console.log('\nUpcoming: no resolvable matchups yet.');
	} else {
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
