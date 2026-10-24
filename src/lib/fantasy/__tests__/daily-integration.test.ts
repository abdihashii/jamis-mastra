import type { Mastra } from '@mastra/core/mastra';
import type { DailyOverrides } from '../daily';
import type { NflSourceResult } from '../nfl-sources.types';
import { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createFantasyEditorialProcedure } from '../../../mastra/workflows/prepare-fantasy-recap';
import { runDailyRecap } from '../daily';
import { claimRun, ensureFantasyRunsTable, markDeliveryUnknown, recordAttemptText } from '../runs';
import { dispatchSavedReport } from '../saved-report-delivery';
import { editorialFixtureRuntime, passingEditorialReview } from './fixtures/editorial-runtime.fixture';
import { editorialFixtureConfig as config, editorialFixtureNow, editorialFixtureSleeper, frozenEditorialFixture, validEditorialDraft } from './fixtures/editorial.fixture';
import { reportingWindowFixture } from './fixtures/reporting-window.fixture';

const databaseUrl = process.env.JAMIS_TEST_DATABASE_URL;
if (databaseUrl) {
	const url = new URL(databaseUrl);
	if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '15458' || url.pathname !== '/jamis_sessions_test' || url.search || url.hash)
		throw new Error('Disposable loopback database required');
}

describe.skipIf(!databaseUrl)('daily native entrypoint with queried reporting windows', () => {
	const schema = `daily_pipeline_${randomUUID().replaceAll('-', '')}`;
	let root: SQL;
	let sql: SQL;
	let guard: ReturnType<typeof spyOn>;
	let options: DailyOverrides;
	let calendarCalls: number;
	let writerCalls: number;
	let sends: string[];
	let notices: string[];
	let pending: boolean;
	let expectedFetches: number;
	const queriedWindow = { startAtUtc: '2026-09-03T00:00:00.000Z', endAtUtc: '2026-09-10T00:00:00.000Z' };

	beforeAll(async () => {
		root = new SQL(databaseUrl!);
		await root.unsafe(`CREATE SCHEMA "${schema}"`);
		sql = new SQL(databaseUrl!, { connection: { search_path: schema, statement_timeout: '15s', lock_timeout: '5s' } });
	});
	beforeEach(async () => {
		guard = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => {
			throw new Error('External requests forbidden');
		}, { preconnect: () => {
			throw new Error('External preconnect forbidden');
		} }));
		await sql.unsafe('DROP TABLE IF EXISTS fantasy_recap_generations, fantasy_recap_runs, fantasy_recap_unmapped_alerts CASCADE');
		calendarCalls = 0;
		writerCalls = 0;
		sends = [];
		notices = [];
		pending = false;
		expectedFetches = 0;
		const packet = await frozenEditorialFixture();
		const source = {
			...editorialFixtureSleeper,
			getNflSchedule: async () => {
				calendarCalls++;
				return { season: '2026', phase: 'regular' as const, retrievedAtUtc: editorialFixtureNow().toISOString(), games: [
					{ id: '202610101', week: 1, date: '2026-09-03', status: 'complete', home: 'NE', away: 'BUF' },
					{ id: '202610102', week: 1, date: '2026-09-08', status: pending ? 'pre_game' : 'complete', home: 'KC', away: 'DEN' },
					{ id: '202610201', week: 2, date: '2026-09-10', status: 'pre_game', home: 'NE', away: 'KC' },
				] };
			},
		};
		const emptyNfl: NflSourceResult = { status: 'empty', trust: 'untrusted-source-data', requestId: 'fixture-read', catalogueRequestId: 'fixture-catalogue', quotedCredits: 5, credits: 5, chargeIdPresent: false, adminActionUrl: null, gaps: [], source: null, records: [] };
		options = {
			sql,
			sleeper: source,
			now: () => new Date('2026-09-11T00:00:00.000Z'),
			readWindow: async (season, week, _now, signal, getSchedule) => {
				await getSchedule!(season, week <= 18 ? 'regular' : 'post', signal);
				return pending ? { status: 'blocked', reason: 'calendar_games_unclosed' } : reportingWindowFixture(queriedWindow, Number(season), week);
			},
			memory: {
				getThreadById: async () => ({ id: `fantasy-group-${config.sendblueGroupId}`, resourceId: `fantasy-group-${config.sendblueGroupId}`, title: 'fixture', createdAt: new Date(), updatedAt: new Date() }),
				listMessages: async () => ({ messages: packet.chat!.sources.map(message => ({
					id: message.id,
					role: 'user' as const,
					createdAt: new Date('2026-09-06T01:00:00Z'),
					threadId: `fantasy-group-${config.sendblueGroupId}`,
					resourceId: `fantasy-group-${config.sendblueGroupId}`,
					content: { format: 2 as const, parts: [{ type: 'text' as const, text: message.text }], metadata: { channel: 'sendblue', groupId: config.sendblueGroupId, senderNumber: '+15550000001', sentAt: '2026-09-06T01:00:00Z' } },
				})), total: 1, page: 0, perPage: 1000, hasMore: false }),
			},
			readNfl: async () => structuredClone(emptyNfl),
			send: { sendToGroup: async () => {
				throw new Error('Legacy sender forbidden');
			}, directMessage: async (text) => { notices.push(text); } },
			prepare: async (collected, signal, observer) => {
				const fixture = editorialFixtureRuntime(async ({ role, data }) => {
					if (role === 'writer') {
						writerCalls++;
						return { case: 'completed', result: validEditorialDraft(collected) };
					}
					return passingEditorialReview(data);
				});
				return createFantasyEditorialProcedure(fixture.runtime)(collected, signal, observer);
			},
			publish: async (ref, token, signal) => ({ receipt: await dispatchSavedReport(ref, token, sql, async (group, text) => {
				expect(group).toBe(config.sendblueGroupId);
				sends.push(text);
				return { kind: 'sent', handle: 'fixture-handle' };
			}, signal) }),
		};
	});
	afterEach(() => {
		try {
			expect(guard).toHaveBeenCalledTimes(expectedFetches);
		} finally {
			guard.mockRestore();
		}
	});
	afterAll(async () => {
		try {
			await sql?.close();
		} finally {
			try {
				await root?.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
			} finally {
				await root?.close();
			}
		}
	});

	test('uses a fixed queried period instead of collection time, then saves and publishes exact reviewed bytes', async () => {
		const result = await runDailyRecap(config, {} as Mastra, options);
		expect(result).toMatchObject({ outcome: 'sent', week: 1, generatorVersion: 'fantasy-recap-v13' });
		expect(calendarCalls).toBe(1);
		expect(writerCalls).toBe(1);
		expect(sends).toHaveLength(1);
		const [row] = await sql`SELECT editorial_attempt, saved_report FROM fantasy_recap_runs`;
		expect(row.editorial_attempt.current.window).toEqual(queriedWindow);
		expect(row.editorial_attempt.current.calendarProof).toEqual(reportingWindowFixture(queriedWindow).source);
		expect(row.saved_report.parts).toEqual(sends);
		expect(notices).toEqual([]);
	});
	test('does not close a week with a postponed Tuesday game just because Sleeper advanced its week label', async () => {
		pending = true;
		expect(await runDailyRecap(config, {} as Mastra, options)).toMatchObject({ outcome: 'noop-no-completed-week' });
		expect(calendarCalls).toBe(1);
		expect(writerCalls).toBe(0);
		expect(sends).toEqual([]);
		const [row] = await sql`SELECT count(*)::int AS count FROM fantasy_recap_runs`;
		expect(row.count).toBe(0);
	});
	test('saved completion bypasses calendar, archive, NFL research and writing on the next wake-up', async () => {
		expect((await runDailyRecap(config, {} as Mastra, options)).outcome).toBe('sent');
		const calls = { writers: writerCalls, calendar: calendarCalls, sends: sends.length };
		options.sleeper!.getNflSchedule = async () => {
			throw new Error('Saved retry cannot read calendar');
		};
		options.prepare = async () => {
			throw new Error('Saved retry cannot write');
		};
		options.readNfl = async () => {
			throw new Error('Saved retry cannot research');
		};
		expect((await runDailyRecap(config, {} as Mastra, options)).outcome).toBe('noop-already-sent');
		expect({ writers: writerCalls, calendar: calendarCalls, sends: sends.length }).toEqual(calls);
	});
	test('week 18 daily wiring queries the adjacent postseason calendar before collection', async () => {
		const phases: string[] = [];
		const captured = JSON.parse(readFileSync(new URL('./fixtures/nfl-calendar.fixture.json', import.meta.url), 'utf8')).transition;
		expectedFetches = 3;
		guard.mockImplementation(Object.assign(async (input: RequestInfo | URL) => {
			const url = String(input);
			return Response.json(url.includes('/scoreboard?') ? captured.scoreboard : url.includes('/types/2/weeks/18?') ? captured.current : captured.next);
		}, { preconnect: () => { throw new Error('Unexpected preconnect'); } }));
		options.readWindow = undefined;
		options.now = () => new Date('2026-01-20T00:00:00.000Z');
		options.sleeper = {
			...editorialFixtureSleeper,
			getNflState: async () => ({ season: '2025', week: 19, seasonType: 'regular' }),
			getLeague: async () => ({ ...await editorialFixtureSleeper.getLeague(config.sleeperLeagueId), season: '2025', status: 'complete', playoffWeekStart: 18 }),
			getWinnersBracket: async () => (await editorialFixtureSleeper.getWinnersBracket(config.sleeperLeagueId)).map(game => ({ ...game, winner: 1, loser: 2 })),
			getNflSchedule: async (season, phase) => {
				phases.push(phase);
				return structuredClone(captured.sleeper);
			},
		};
		options.memory!.listMessages = async () => ({ messages: [], total: 0, page: 0, perPage: 1000, hasMore: false });
		let observed: unknown;
		options.prepare = async (packet) => {
			observed = packet.scope.chatWindow;
			return { status: 'blocked', evidenceId: packet.id, candidateId: null, reason: 'fixture_stop', counts: { drafts: 0, reviews: 0 }, issues: [] };
		};
		expect(await runDailyRecap(config, {} as Mastra, options)).toMatchObject({ outcome: 'failed', reason: 'editorial_blocked', week: 18 });
		expect(phases).toEqual(['regular']);
		expect(observed).toEqual({ startAtUtc: new Date(captured.current.startDate).toISOString(), endAtUtc: new Date(captured.next.startDate).toISOString() });
		expect(sends).toEqual([]);
	});

	test('legacy uncertain delivery keeps its Operator-recovery outcome through the actual daily adapter', async () => {
		await ensureFantasyRunsTable(sql);
		expect((await claimRun(config.sleeperLeagueId, 1, 'legacy', new Date(Date.now() + 60_000), null, sql)).claimed).toBe(true);
		expect(await recordAttemptText(config.sleeperLeagueId, 1, 'legacy', 'saved legacy bytes', sql)).toBe(true);
		await markDeliveryUnknown(config.sleeperLeagueId, 1, 'legacy', 'fixture uncertain', sql);
		expect(await runDailyRecap(config, {} as Mastra, options)).toMatchObject({ outcome: 'blocked-delivery-unknown', week: 1 });
		expect(calendarCalls).toBe(0);
		expect(writerCalls).toBe(0);
		expect(sends).toEqual([]);
	});
	test('manual restart refuses a stale week before calendar or paid work', async () => {
		options.restart = { week: 2, attemptId: randomUUID() };
		expect(await runDailyRecap(config, {} as Mastra, options)).toMatchObject({ outcome: 'failed', reason: 'restart_not_latest_completed_week' });
		expect(calendarCalls).toBe(0);
		expect(writerCalls).toBe(0);
		expect(sends).toEqual([]);
	});
});
