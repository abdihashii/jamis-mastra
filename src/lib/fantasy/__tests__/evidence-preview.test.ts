import type { MemoryStorage } from '@mastra/core/storage';
import type { EvidenceOptions } from '../recap-evidence';
import type { SleeperScore } from '../sleeper';
import { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { noopLogger } from '@mastra/core/logger';
import { PostgresStore } from '@mastra/pg';
import { evidenceReadOnlyDatabaseUrl, previewRecapEvidence } from '../evidence-preview';
import { resolveChatSource } from '../recap-evidence';

const config = {
	sendblueGroupId: 'fixture-group',
	sleeperLeagueId: 'fixture-league',
	recapTimezone: 'UTC',
	managerMap: { '+15550000001': 'u1', '+15550000002': 'u2' },
};
const window = { startAtUtc: '2026-09-01T00:00:00.000Z', endAtUtc: '2026-09-08T00:00:00.000Z' };
const now = () => new Date('2026-09-09T00:00:00.000Z');
const sourceText = '  Exact original “banter”.\nNo trimming.  ';
const sleeper: NonNullable<EvidenceOptions['sleeper']> = {
	getNflState: async () => ({ season: '2026', week: 2, seasonType: 'regular' }),
	getLeague: async () => ({
		id: config.sleeperLeagueId,
		name: 'Fixture',
		season: '2026',
		status: 'in_season',
		totalRosters: 2,
		playoffWeekStart: 15,
		playoffRounds: 1,
		rosterPositions: ['QB', 'BN'],
		scoringSettings: { rec: 1 },
	}),
	getManagers: async () => [
		{ rosterId: 1, userId: 'u1', displayName: 'Alpha' },
		{ rosterId: 2, userId: 'u2', displayName: 'Bravo' },
	],
	getWinnersBracket: async () => [{
		matchupId: 1,
		round: 1,
		placement: 1,
		team1: 1,
		team2: 2,
		winner: null,
		loser: null,
		team1From: null,
		team2From: null,
	}],
	getScores: async (): Promise<SleeperScore[]> => [
		{ rosterId: 1, matchupId: 1, points: 20, players: ['p1'], starters: ['p1'], playerPoints: { p1: 20 } },
		{ rosterId: 2, matchupId: 1, points: 10, players: ['p2'], starters: ['p2'], playerPoints: { p2: 10 } },
	],
	getPlayerSnapshot: async () => ({
		players: ['p1', 'p2'].map(id => ({ id, name: id, position: 'QB', team: 'NE', fantasyPositions: ['QB'], gsisId: null })),
		retrievedAtUtc: now().toISOString(),
		missingIds: [],
	}),
	getTransactions: async () => ({ transactions: [], malformedCount: 0, retrievedAtUtc: now().toISOString() }),
};
let fetchGuard: ReturnType<typeof spyOn>;
beforeEach(() => {
	fetchGuard = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => {
		throw new Error('External network forbidden in preview fixture');
	}, { preconnect: () => { throw new Error('External preconnect forbidden in preview fixture'); } }));
});
afterEach(() => {
	expect(fetchGuard).not.toHaveBeenCalled();
	fetchGuard.mockRestore();
});

test('read-only URL appends last and preserves existing options without environment lookup', () => {
	const url = new URL(evidenceReadOnlyDatabaseUrl('postgresql://fixture:synthetic@localhost/jamis_sessions_test?options=-c%20statement_timeout%3D1000%20-c%20default_transaction_read_only%3Doff'));
	expect(url.searchParams.get('options')).toBe('-c statement_timeout=1000 -c default_transaction_read_only=off -c default_transaction_read_only=on');
	expect(() => evidenceReadOnlyDatabaseUrl('https://example.invalid')).toThrow('invalid_preview_database_url');
});

test('invalid scope/window blocks before database or paid/public source reads', async () => {
	for (const change of [{ week: 0 }, { window: null }, { window: { ...window, endAtUtc: '2027-01-01T00:00:00Z' } }, { config: { ...config, sleeperLeagueId: '' } }]) {
		const result = await previewRecapEvidence({ config, week: 1, window, databaseUrl: 'not-a-url', firecrawlApiKey: 'synthetic-only', ...change }, { sleeper, now });
		expect(result).toEqual({ status: 'blocked', packet: null, reason: 'invalid_preview_scope', databaseUnchanged: false });
	}
	const result = await previewRecapEvidence({ config, week: 1, window, databaseUrl: 'private-invalid-url' }, { sleeper, now });
	expect(result.reason).toBe('invalid_preview_database_url');
	expect(JSON.stringify(result)).not.toContain('private-invalid-url');
});

test('composition dependency files contain no local model, channel, send, or persistence imports', async () => {
	for (const name of [
		'evidence-preview',
		'recap-evidence',
		'chat-archive',
		'nfl-sources',
		'nfl-sources-task',
		'week-facts',
		'sleeper',
	]) {
		const source = await readFile(new URL(`../${name}.ts`, import.meta.url), 'utf8');
		expect(source).not.toMatch(/(?:from|import\()\s*['"][^'"]*(?:\/channels|\/agents|\/gateways|\.\/deliver|\.\/generate|\.\/recaps|\.\/runs)['"/]/);
		expect(source).not.toMatch(/\.(?:send|generate|saveMessages|saveThread)\(/);
	}
});

// Never fall back to DATABASE_URL or a non-disposable target.
const databaseUrl = process.env.JAMIS_TEST_DATABASE_URL;
let available = false;
if (databaseUrl) {
	const url = new URL(databaseUrl);
	if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)
		|| url.pathname !== '/jamis_sessions_test' || url.search) {
		throw new Error('Disposable loopback jamis_sessions_test URL required');
	}
	const probe = new SQL(databaseUrl, { connectionTimeout: 1 });
	try {
		await probe`SELECT 1`;
		available = true;
	} catch {
		// Parent owns fixture startup; unavailable fixtures are skipped, never replaced.
	} finally {
		await probe.close();
	}
}

describe.skipIf(!available)('real read-only PG evidence composition (disposable fixture only)', () => {
	const schema = `evidence_preview_${randomUUID().replaceAll('-', '')}`;
	let root: SQL;
	let sql: SQL;
	let writer: PostgresStore;
	let memory: MemoryStorage;
	const request = () => ({ config, week: 1, window, databaseUrl: databaseUrl! });
	const options = () => ({ sleeper, now, schemaName: schema });
	beforeAll(async () => {
		root = new SQL(databaseUrl!);
		await root.unsafe(`CREATE SCHEMA "${schema}"`);
		sql = new SQL(databaseUrl!, { connection: { search_path: schema } });
		writer = new PostgresStore({ id: schema, connectionString: databaseUrl!, schemaName: schema, disableInit: true });
		writer.__setLogger(noopLogger);
		memory = (await writer.getStore('memory'))!;
		memory.__setLogger(noopLogger);
		await memory.init();
		await sql`CREATE TABLE fantasy_recap_generations (id text PRIMARY KEY, league_id text, saved_text text, extra jsonb)`;
		await sql`CREATE TABLE fantasy_recap_runs (id text PRIMARY KEY, league_id text, status text, extra jsonb)`;
	}, 30000);
	beforeEach(async () => {
		await sql`TRUNCATE fantasy_recap_generations, fantasy_recap_runs, mastra_messages, mastra_threads`;
		await sql`INSERT INTO fantasy_recap_generations VALUES ('g1', ${config.sleeperLeagueId}, 'Saved recap must stay exact', '{"revision":1}')`;
		await sql`INSERT INTO fantasy_recap_runs VALUES ('r1', ${config.sleeperLeagueId}, 'sent', '{"revision":1}')`;
		const threadId = `fantasy-group-${config.sendblueGroupId}`;
		await memory.saveThread({ thread: { id: threadId, resourceId: threadId, title: 'Fixture', createdAt: now(), updatedAt: now() } });
		await memory.saveMessages({ messages: [{
			id: 'exact-source',
			threadId,
			resourceId: threadId,
			role: 'user',
			type: 'text',
			createdAt: new Date('2026-09-02T01:00:00Z'),
			content: {
				format: 2,
				parts: [{ type: 'text', text: sourceText }],
				metadata: { channel: 'sendblue', groupId: config.sendblueGroupId, senderNumber: '+15550000001', sentAt: '2026-09-02T01:00:00Z' },
			},
		}] });
	});
	afterAll(async () => {
		await writer?.close();
		await sql?.close();
		if (root) {
			await root.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
			await root.close();
		}
	});
	async function snapshot() {
		const generations = await sql`SELECT count(*)::int AS count, md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) AS hash FROM fantasy_recap_generations t`;
		const runs = await sql`SELECT count(*)::int AS count, md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) AS hash FROM fantasy_recap_runs t`;
		return { generations: [...generations], runs: [...runs] };
	}

	test('real archived exact sources, counts, hashes, and saved recap survive; no key means no NFL', async () => {
		const before = await snapshot();
		const result = await previewRecapEvidence(request(), options());
		expect(result.status).toBe('partial');
		expect(result.reason).toBeNull();
		expect(result.databaseUnchanged).toBe(true);
		expect(result.packet?.chat?.status).toBe('complete');
		expect(resolveChatSource(result.packet!, 'exact-source')?.text).toBe(sourceText);
		expect(resolveChatSource(result.packet!, 'invented-id')).toBeNull();
		expect(Object.isFrozen(result.packet!.chat!.sources[0])).toBe(true);
		expect(result.packet!.nfl).toEqual([]);
		expect(result.packet!.gaps).toContainEqual({ source: 'nfl', code: 'research_not_requested', blocking: false });
		expect(await snapshot()).toEqual(before);
		expect((await sql`SELECT saved_text FROM fantasy_recap_generations`)[0].saved_text).toBe('Saved recap must stay exact');
	});

	test('native archive pagination exposes a 1,001-message window as truncated, not complete', async () => {
		const threadId = `fantasy-group-${config.sendblueGroupId}`;
		await memory.saveMessages({ messages: Array.from({ length: 1_000 }, (_, i) => ({
			id: `bounded-${i}`,
			threadId,
			resourceId: threadId,
			role: 'user' as const,
			type: 'text' as const,
			createdAt: new Date('2026-09-03T01:00:00Z'),
			content: {
				format: 2 as const,
				parts: [{ type: 'text' as const, text: `Eligible banter ${i}` }],
				metadata: {
					channel: 'sendblue',
					groupId: config.sendblueGroupId,
					senderNumber: '+15550000001',
					sentAt: '2026-09-03T01:00:00Z',
				},
			},
		})) });
		const result = await previewRecapEvidence(request(), options());
		expect(result.status).toBe('blocked');
		expect(result.packet!.chat).toMatchObject({ status: 'truncated', readCount: 1_000 });
		expect(result.packet!.chat!.gaps).toContain('archive_message_limit');
		expect(result.databaseUnchanged).toBe(true);
	}, 15000);

	test('both actual clients reject writes and read-only initialization creates no schema', async () => {
		const readonlyUrl = evidenceReadOnlyDatabaseUrl(databaseUrl!);
		const readonlySql = new SQL(readonlyUrl);
		const readonlyStore = new PostgresStore({ id: 'readonly-fixture', connectionString: readonlyUrl, schemaName: `${schema}_absent`, disableInit: true });
		readonlyStore.__setLogger(noopLogger);
		try {
			expect((await readonlySql`SHOW default_transaction_read_only`)[0].default_transaction_read_only).toBe('on');
			expect((await readonlyStore.db.one('SHOW default_transaction_read_only')).default_transaction_read_only).toBe('on');
			await expect((async () => {
				await readonlySql.unsafe(`INSERT INTO "${schema}".fantasy_recap_runs VALUES ('bad', 'bad', 'bad', '{}')`);
			})()).rejects.toThrow('read-only transaction');
			await expect(readonlyStore.db.none(`UPDATE "${schema}".fantasy_recap_generations SET saved_text = 'bad'`))
				.rejects
				.toThrow('read-only transaction');
			await readonlyStore.getStore('memory');
			expect((await root`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = ${`${schema}_absent`}`)[0].n).toBe(0);
		} finally {
			await readonlyStore.close();
			await readonlySql.close();
		}
	});

	test('same-count whole-row changes in either recap table are detected without attribution', async () => {
		for (const table of ['fantasy_recap_generations', 'fantasy_recap_runs']) {
			const result = await previewRecapEvidence(request(), {
				...options(),
				sleeper: { ...sleeper, getTransactions: async () => {
					await sql.unsafe(`UPDATE ${table} SET extra = '{"revision":2}'`);
					return sleeper.getTransactions(config.sleeperLeagueId, 1);
				} },
			});
			expect(result).toEqual({ status: 'blocked', packet: null, reason: 'recap_state_changed_during_preview', databaseUnchanged: false });
			await sql.unsafe(`UPDATE ${table} SET extra = '{"revision":1}'`);
		}
	});

	test('another league changing does not invalidate this league snapshot', async () => {
		const result = await previewRecapEvidence(request(), {
			...options(),
			sleeper: { ...sleeper, getTransactions: async () => {
				await sql`INSERT INTO fantasy_recap_runs VALUES ('other-league', 'other', 'sent', '{}')`;
				return sleeper.getTransactions(config.sleeperLeagueId, 1);
			} },
		});
		expect(result.databaseUnchanged).toBe(true);
		expect(result.status).toBe('partial');
	});

	test('missing archive thread and archive read failure block safely', async () => {
		await sql`DELETE FROM mastra_threads`;
		const missing = await previewRecapEvidence(request(), options());
		expect(missing.status).toBe('blocked');
		expect(missing.reason).toBe('evidence_blocked');
		expect(missing.packet?.chat?.gaps).toContain('archive_thread_unavailable');
		await sql`ALTER TABLE mastra_threads RENAME TO fixture_hidden_threads`;
		try {
			const failed = await previewRecapEvidence(request(), options());
			expect(failed.status).toBe('blocked');
			expect(failed.databaseUnchanged).toBe(true);
			expect(failed.packet?.chat?.gaps).toContain('archive_unavailable');
			expect(JSON.stringify(failed)).not.toContain('fixture_hidden_threads');
		} finally {
			await sql`ALTER TABLE fixture_hidden_threads RENAME TO mastra_threads`;
		}
	});

	test('missing recap table fails closed before source reads or schema initialization', async () => {
		await sql`ALTER TABLE fantasy_recap_runs RENAME TO fixture_hidden_runs`;
		const publicRead = spyOn(sleeper, 'getNflState');
		try {
			const result = await previewRecapEvidence(request(), options());
			expect(result).toEqual({ status: 'blocked', packet: null, reason: 'preview_recap_state_unavailable', databaseUnchanged: false });
			expect(publicRead).not.toHaveBeenCalled();
			expect((await sql`SELECT to_regclass(${`${schema}.fantasy_recap_runs`}) AS name`)[0].name).toBeNull();
		} finally {
			publicRead.mockRestore();
			await sql`ALTER TABLE fixture_hidden_runs RENAME TO fantasy_recap_runs`;
		}
	});
});
