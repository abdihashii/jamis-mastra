import { SQL } from 'bun';
import process from 'node:process';
import { z } from 'zod';

import type { FantasyConfig } from '../src/lib/fantasy/config';
import type { RecapEvidencePacket } from '../src/lib/fantasy/recap-evidence';
import type { RecapGenerationRecord } from '../src/lib/fantasy/recaps';
import type { SavedReportRecoveryRequest } from '../src/lib/fantasy/saved-report-recovery';
import type { SleeperManager } from '../src/lib/fantasy/sleeper';
import type { WeekFacts } from '../src/lib/fantasy/week-facts';

import { parseFantasyConfig } from '../src/lib/fantasy/config';
import { renderResult } from '../src/lib/fantasy/render';
import { parseSavedReportRecovery, runSavedReportRecovery, unavailableSavedReportRecovery } from '../src/lib/fantasy/saved-report-recovery';
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
import { buildWeekFacts } from '../src/lib/fantasy/week-facts';

const usage = [
	'bun run fantasy:recap <command>',
	'  inspect --week <number> [--allow-incomplete]   print deterministic facts only',
	'  evidence --week <1..22> [--nfl]   queried reporting window, frozen read-only evidence, no model/send',
	'    --nfl explicitly enables one free catalogue and up to three reads quoted at 5 credits each.',
	'  preview-candidate --week <1..22> [--nfl]   queried reporting window, Astra writer/reviewer, never send',
	'  preview --week <1..22> [--nfl]   alias of preview-candidate',
	'    Evidence/preview: optional paired --since <UTC instant> --until <UTC instant> assert queried bounds only; never choose a cutoff.',
	'  run                                            normal daily job: newest completed week only, no flags',
	'  restart --week <1..22> --attempt-id <UUID>       restart the exact blocked generation attempt',
	'  debug-export --week <1..22> --attempt-id <UUID>   private 0600 debug file, never stdout payloads',
	'  retry --week <number> [--operator-verified-absent]   legacy saved message only',
	'  confirm-sent --week <number>                   legacy operator-observed message',
	'  retry --week <1..22> --report-id <report-64hex> [--operator-verified-absent --part <1..3> --attempt-id <UUID>]',
	'  confirm-sent --week <1..22> --report-id <report-64hex> --part <1..3> --attempt-id <UUID>',
	'    Saved reports: confirm records only; retry explicitly resumes the exact unaccepted tail. JSON output.',
].join('\n');

async function main() {
	const [requestedCommand, ...flags] = process.argv.slice(2);
	const command = requestedCommand === 'preview' ? 'preview-candidate' : requestedCommand;
	if (!command || !['inspect', 'evidence', 'preview-candidate', 'run', 'restart', 'retry', 'confirm-sent', 'debug-export'].includes(command))
		fail(usage, 1);

	if (command === 'run' || command === 'restart') {
		let restart: { week: number; attemptId: string } | undefined;
		if (command === 'run' && flags.length > 0)
			fail('Invalid run arguments.', 1);
		if (command === 'restart') {
			const values = new Map<string, string>();
			for (let i = 0; i < flags.length; i += 2) {
				if (!['--week', '--attempt-id'].includes(flags[i]) || values.has(flags[i]) || !flags[i + 1])
					fail('Invalid restart arguments.', 1);
				values.set(flags[i], flags[i + 1]);
			}
			if (values.size !== 2 || !/^(?:[1-9]|1\d|2[0-2])$/.test(values.get('--week') ?? '')
				|| !z.uuid().safeParse(values.get('--attempt-id')).success) {
				fail('Invalid restart arguments.', 1);
			}
			restart = { week: Number(values.get('--week')), attemptId: values.get('--attempt-id')! };
		}
		let result: {
			outcome: string;
			week: number | null;
			reason?: string;
			attemptId?: string;
			reportId?: string;
			counts?: { nfl: number; drafts: number; reviews: number };
		} = { outcome: 'error', week: restart?.week ?? null, reason: 'recap_run_unavailable' };
		let client: SQL | undefined;
		try {
			const config = parseFantasyConfig(process.env, () => {});
			const databaseUrl = process.env.DATABASE_URL;
			if (!config || !databaseUrl || !['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol))
				throw new Error('recap_run_unavailable');
			client = new SQL(databaseUrl, { connectionTimeout: 5, connection: { statement_timeout: '15s', lock_timeout: '5s' } });
			const [{ Mastra }, { noopLogger }, { openAICodexGateway }, { runDailyRecap }] = await Promise.all([
				import('@mastra/core/mastra'),
				import('@mastra/core/logger'),
				import('../src/mastra/gateways/openai-codex-gateway.js'),
				import('../src/lib/fantasy/daily'),
			]);
			const parent = new Mastra({ logger: noopLogger, gateways: { 'openai-codex': openAICodexGateway } });
			const completed: typeof result = await runDailyRecap(config, parent, {
				sql: client,
				databaseUrl,
				...(restart ? { restart } : {}),
			});
			const { outcome, week, reason, attemptId, reportId, counts } = completed;
			result = {
				outcome,
				week,
				reason,
				attemptId,
				reportId,
				counts: counts ? { nfl: counts.nfl, drafts: counts.drafts, reviews: counts.reviews } : undefined,
			};
		} catch { /* No source errors, credentials or raw provider data reach the CLI receipt. */ } finally {
			try {
				await client?.close();
			} catch { /* Cleanup cannot erase an authoritative receipt. */ }
		}
		console.log(JSON.stringify(result));
		if (['failed', 'delivery_unknown', 'error'].includes(result.outcome) || result.outcome.startsWith('blocked'))
			process.exitCode = 1;
		return;
	}

	if (command === 'evidence' || command === 'preview-candidate') {
		const seen = new Set<string>();
		for (let i = 0; i < flags.length; i++) {
			const flag = flags[i];
			if (seen.has(flag) || !['--week', '--since', '--until', '--nfl'].includes(flag))
				fail(usage, 1);
			seen.add(flag);
			if (flag !== '--nfl' && (!flags[++i] || flags[i].startsWith('--')))
				fail(usage, 1);
		}
		if (!seen.has('--week') || !/^(?:[1-9]|1\d|2[0-2])$/.test(flags[flags.indexOf('--week') + 1])
			|| seen.has('--since') !== seen.has('--until')) {
			fail(usage, 1);
		}
	}

	if (command === 'debug-export') {
		const values = new Map<string, string>();
		for (let i = 0; i < flags.length; i += 2) {
			if (!['--week', '--attempt-id'].includes(flags[i]) || values.has(flags[i]) || !flags[i + 1])
				fail('Invalid debug export arguments.', 1);
			values.set(flags[i], flags[i + 1]);
		}
		if (values.size !== 2 || !/^(?:[1-9]|1\d|2[0-2])$/.test(values.get('--week') ?? '')
			|| !z.uuid().safeParse(values.get('--attempt-id')).success) {
			fail('Invalid debug export arguments.', 1);
		}
		const config = parseFantasyConfig();
		let client: SQL | undefined;
		let result: { status: string; reason?: string; attemptId?: string; expiresAtUtc?: string; path?: string } = { status: 'blocked', reason: 'generation_debug_export_unavailable' };
		try {
			if (!config || !process.env.DATABASE_URL)
				throw new Error('generation_debug_export_unavailable');
			client = new SQL(process.env.DATABASE_URL, { connectionTimeout: 5, connection: { statement_timeout: '15s', lock_timeout: '5s', default_transaction_read_only: 'on' } });
			const [mode] = await client`SHOW default_transaction_read_only`;
			if (mode.default_transaction_read_only !== 'on')
				throw new Error('generation_debug_export_unavailable');
			const { findGenerationReference } = await import('../src/lib/fantasy/generation-runs');
			const ref = await findGenerationReference(config.sleeperLeagueId, Number(values.get('--week')), config.sendblueGroupId, values.get('--attempt-id')!, client);
			if (!ref)
				throw new Error('generation_debug_export_unavailable');
			const { exportGenerationDebug } = await import('../src/lib/fantasy/generation-debug');
			result = { status: 'exported', ...await exportGenerationDebug(ref, client, 'data/fantasy-debug') };
		} catch { /* No private bundle, source error, credential or connection string reaches stdout. */ } finally {
			try {
				await client?.close();
			} catch { /* The private file receipt remains authoritative. */ }
		}
		console.log(JSON.stringify(result));
		if (result.status !== 'exported')
			process.exitCode = 1;
		return;
	}

	let recovery: SavedReportRecoveryRequest | null;
	try {
		recovery = parseSavedReportRecovery(command, flags);
	} catch {
		fail(`Invalid saved-report recovery arguments.\n${usage}`, 1);
	}
	const config = parseFantasyConfig();
	if (!config)
		fail('Fantasy configuration is missing or incomplete; fix the FANTASY_* env vars first.', 1);

	if (recovery) {
		let result = unavailableSavedReportRecovery(recovery);
		let client: SQL | undefined;
		try {
			const databaseUrl = process.env.DATABASE_URL;
			if (!databaseUrl)
				throw new Error('recovery_database_unavailable');
			const sql = client = new SQL(databaseUrl, {
				connectionTimeout: 5,
				connection: { statement_timeout: '15s', lock_timeout: '5s' },
			});
			result = await runSavedReportRecovery(recovery, {
				leagueId: config.sleeperLeagueId,
				groupId: config.sendblueGroupId,
				sql,
				publish: recovery.command === 'retry'
					? async (reference, claimToken) => {
						// Only a live retry claim reaches model/transport composition. No app roots or storage.
						const [core, { noopLogger }, gateway, publication, delivery] = await Promise.all([
							import('@mastra/core/mastra'),
							import('@mastra/core/logger'),
							import('../src/mastra/gateways/openai-codex-gateway.js'),
							import('../src/mastra/workflows/publish-fantasy-recap'),
							import('../src/lib/fantasy/deliver'),
						]);
						const parent = new core.Mastra({
							logger: noopLogger,
							gateways: { 'openai-codex': gateway.openAICodexGateway },
						});
						return publication.createFantasyPublicationProcedure(parent, {
							leagueId: config.sleeperLeagueId,
							groupId: config.sendblueGroupId,
							sql,
							sendExact: (groupId, text) => delivery.sendblueSendClient.sendExactToGroup(groupId, text),
						})(reference, claimToken);
					}
					: undefined,
			});
		} catch { /* Initialization failures must not expose connection strings or raw errors. */ } finally {
			try {
				await client?.close();
			} catch { /* Cleanup cannot erase an authoritative delivery receipt. */ }
		}
		console.log(JSON.stringify(result));
		if (result.status !== 'sent' && result.status !== 'confirmed')
			process.exitCode = 1;
		return;
	}

	// TODO: remove --allow-incomplete once the bot is live in the actual group chat.
	// Debug flag: bypasses the completed-week gate to preview mid-week facts.
	const allowIncomplete = flags.includes('--allow-incomplete');

	const weekFlag = flags.indexOf('--week');
	const week = Number(flags[weekFlag + 1]);
	if (weekFlag === -1 || !Number.isInteger(week))
		fail(usage, 1);

	if (command === 'retry' || command === 'confirm-sent') {
		const { confirmSent, retryWeek } = await import('../src/lib/fantasy/coordinator');
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

	if (command === 'evidence' || command === 'preview-candidate') {
		const since = flags.indexOf('--since');
		const until = flags.indexOf('--until');
		const apiKey = flags.includes('--nfl') ? process.env.FIRECRAWL_API_KEY : undefined;
		if (flags.includes('--nfl') && !apiKey?.trim())
			fail('FIRECRAWL_API_KEY is required for explicitly requested NFL reads.', 1);
		const request = {
			config,
			week,
			...(since >= 0 ? { window: { startAtUtc: flags[since + 1], endAtUtc: flags[until + 1] } } : {}),
			databaseUrl: process.env.DATABASE_URL ?? '',
			firecrawlApiKey: apiKey,
		};
		if (command === 'preview-candidate') {
			const { previewRecapCandidate } = await import('../src/lib/fantasy/preview');
			const result = await previewRecapCandidate(request);
			console.log(`Candidate preview: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
			if (result.packet) {
				const packet = result.packet;
				console.log(`Evidence: ${packet.id}; season ${packet.scope.season}, week ${packet.scope.week}.`);
				printReportingWindow(packet);
				console.log(`Sources: ${packet.chat?.sources.length ?? 0} chat; ${packet.nfl.length} NFL reads.`);
				console.log(`Gaps: ${packet.gaps.map(gap => `${gap.source}:${gap.code}`).join(', ') || 'none'}`);
			}
			if (result.outcome?.status === 'approved') {
				const { candidate } = result.outcome;
				for (const part of candidate.parts) console.log(`\n${part}`);
				console.log(`\n${candidate.version}; ${candidate.id}; ${candidate.parts.length} ordered part(s).`);
				console.log(`Part lengths (UTF-16 units): ${candidate.parts.map(part => part.length).join(', ')}.`);
			}
			const database = result.databaseUnchanged
				? 'verified unchanged'
				: result.reason === 'recap_state_changed_during_preview' ? 'changed during preview' : 'not verified';
			console.log(`Database state: ${database}; writer calls: ${result.counts.drafts}; reviewer calls: ${result.counts.reviews}; sends: 0.`);
			if (result.status === 'blocked')
				process.exitCode = 1;
			return;
		}
		const { previewRecapEvidence } = await import('../src/lib/fantasy/evidence-preview');
		const result = await previewRecapEvidence(request);
		console.log(`Evidence preview: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
		if (result.packet) {
			const packet = result.packet;
			console.log(`${packet.version}, season ${packet.scope.season ?? 'unknown'}, week ${week}`);
			printReportingWindow(packet);
			console.log(`Matches: ${packet.facts?.results.length ?? 0}; chat sources: ${packet.chat?.sources.length ?? 0}; completed transactions: ${packet.transactions.completed.length}`);
			console.log(`NFL reads: ${packet.nfl.length}; gaps: ${packet.gaps.map(gap => `${gap.source}:${gap.code}`).join(', ') || 'none'}`);
		}
		const database = result.databaseUnchanged
			? 'verified unchanged'
			: result.reason === 'recap_state_changed_during_preview' ? 'changed during preview' : 'not verified';
		console.log(`Database state: ${database}; model calls: 0; sends: 0.`);
		if (result.status === 'blocked')
			process.exitCode = 1;
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
	print(facts, !completed);
}

function printReportingWindow(packet: RecapEvidencePacket) {
	const window = packet.scope.calendarProof ? packet.scope.chatWindow : null;
	console.log(window
		? `Reporting window: [${window.startAtUtc}, ${window.endAtUtc}) (queried calendar UTC; end exclusive).`
		: 'Reporting window: unverified.');
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

async function coordinatorDeps(config: FantasyConfig) {
	// Dynamic imports: inspect/evidence/preview must not load operational send/storage owners.
	const { sendblueSendClient } = await import('../src/lib/fantasy/deliver');
	const { ensureFantasyRecapsTable, getFantasySql, recordClaimedGeneration } = await import('../src/lib/fantasy/recaps');
	const { createRunsStore } = await import('../src/lib/fantasy/runs');
	const sql = getFantasySql();
	return {
		runs: createRunsStore(config.sleeperLeagueId, sql),
		recaps: { ensureSchema: () => ensureFantasyRecapsTable(sql), record: (record: RecapGenerationRecord, claimToken: string) => recordClaimedGeneration(record, claimToken, sql) },
		groupId: config.sendblueGroupId,
		leagueId: config.sleeperLeagueId,
		// Legacy recovery sends only saved bytes; it never reads chat or regenerates.
		readThreadMessages: async () => [],
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

function fail(message: string, code: number): never {
	console.error(message);
	process.exit(code);
}

main().catch((error) => {
	if (error instanceof SleeperDataError)
		fail(error.message, 1);
	throw error;
});
