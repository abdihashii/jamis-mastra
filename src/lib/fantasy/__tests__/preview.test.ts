import type { MemoryStorage } from '@mastra/core/storage';
import type { createFantasyEditorialProcedure as CreateProcedure } from '../../../mastra/workflows/prepare-fantasy-recap';
import type { EditorialOutcome } from '../editorial-loop';
import type { evidenceReadOnlyDatabaseUrl as ReadonlyUrl } from '../evidence-preview';
import type { previewRecapCandidate as PreviewCandidate } from '../preview';
import type { RecapEvidencePacket } from '../recap-evidence';
import type { EditorialModelInput } from './fixtures/editorial-runtime.fixture';
import { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { noopLogger } from '@mastra/core/logger';
import { PostgresStore } from '@mastra/pg';
import { Groups } from 'sendblue/resources/groups';
import { Messages } from 'sendblue/resources/messages';
import { buildEditorialCandidate } from '../editorial';
import { resolveChatSource } from '../recap-evidence';
import { editorialFixtureRuntime, passingEditorialReview } from './fixtures/editorial-runtime.fixture';
import {
	editorialFixtureConfig as config,
	editorialFixtureQuote,
	editorialFixtureNow as now,
	editorialFixtureSleeper as sleeper,
	validEditorialDraft,
	editorialFixtureWindow as window,
} from './fixtures/editorial.fixture';

let preview: typeof PreviewCandidate;
let createProcedure: typeof CreateProcedure;
let readonlyUrl: typeof ReadonlyUrl;
let group: ReturnType<typeof spyOn>;
let dm: ReturnType<typeof spyOn>;
let network: ReturnType<typeof spyOn>;
let preconnect: ReturnType<typeof spyOn>;
beforeAll(async () => {
	group = spyOn(Groups.prototype, 'sendMessage').mockImplementation(() => {
		throw new Error('Group send forbidden');
	});
	dm = spyOn(Messages.prototype, 'send').mockImplementation(() => {
		throw new Error('DM send forbidden');
	});
	network = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => {
		throw new Error('External network forbidden');
	}, { preconnect() { throw new Error('External preconnect forbidden'); } }));
	preconnect = spyOn(globalThis.fetch, 'preconnect');
	({ previewRecapCandidate: preview } = await import('../preview'));
	({ createFantasyEditorialProcedure: createProcedure } = await import('../../../mastra/workflows/prepare-fantasy-recap'));
	({ evidenceReadOnlyDatabaseUrl: readonlyUrl } = await import('../evidence-preview'));
});
afterEach(() => {
	for (const guard of [group, dm, network, preconnect]) expect(guard).not.toHaveBeenCalled();
});
afterAll(() => {
	preconnect.mockRestore();
	network.mockRestore();
	dm.mockRestore();
	group.mockRestore();
});

function unusedNativeProcedure() {
	const fixture = editorialFixtureRuntime(() => {
		throw new Error('Model must not run for blocked evidence');
	});
	return { ...fixture, prepare: createProcedure(fixture.runtime) };
}

test('invalid scope blocks before any native model call or database access', async () => {
	const fixture = unusedNativeProcedure();
	for (const change of [
		{ week: 0 },
		{ week: 23 },
		{ window: null },
		{ window: { ...window, endAtUtc: '2027-01-01T00:00:00.000Z' } },
		{ config: { ...config, sleeperLeagueId: '' } },
		{ config: { ...config, sendblueGroupId: '' } },
	]) {
		const result = await preview({ config, week: 1, window, databaseUrl: 'not-a-url', ...change }, { sleeper, now, prepare: fixture.prepare });
		expect(result).toEqual({ status: 'blocked', reason: 'invalid_preview_scope', packet: null, outcome: null, counts: { drafts: 0, reviews: 0 }, databaseUnchanged: false });
	}
	const result = await preview({ config, week: 1, window, databaseUrl: 'not-a-url' }, { sleeper, now, prepare: fixture.prepare, schemaName: 'invalid-schema' });
	expect(result.reason).toBe('invalid_preview_scope');
	expect(fixture.calls).toHaveLength(0);
	expect(fixture.resolved).toHaveLength(0);
});

test('invalid database URLs are redacted and never reach a model', async () => {
	const fixture = unusedNativeProcedure();
	for (const databaseUrl of ['PRIVATE_INVALID_DATABASE_URL', 'https://example.invalid/jamis_sessions_test']) {
		const result = await preview({ config, week: 1, window, databaseUrl }, { sleeper, now, prepare: fixture.prepare });
		expect(result).toEqual({ status: 'blocked', reason: 'invalid_preview_database_url', packet: null, outcome: null, counts: { drafts: 0, reviews: 0 }, databaseUnchanged: false });
		expect(JSON.stringify(result)).not.toContain(databaseUrl);
	}
	expect(fixture.calls).toHaveLength(0);
	expect(fixture.resolved).toHaveLength(0);
});

// Only the parent's disposable loopback fixture is allowed; never fall back to DATABASE_URL.
const databaseUrl = process.env.JAMIS_TEST_DATABASE_URL;
let available = false;
if (databaseUrl) {
	const url = new URL(databaseUrl);
	if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)
		|| url.pathname !== '/jamis_sessions_test' || url.search || url.hash) {
		throw new Error('Disposable loopback jamis_sessions_test URL required');
	}
	const probe = new SQL(databaseUrl, { connectionTimeout: 1 });
	try {
		await probe`SELECT 1`;
		available = true;
	} catch {
		// Parent owns fixture startup; an unavailable fixture is skipped, not replaced.
	} finally {
		await probe.close();
	}
}

describe.skipIf(!available)('candidate preview on disposable read-only PG', () => {
	const schema = `candidate_preview_${randomUUID().replaceAll('-', '')}`;
	const runtimeSchema = `${schema}_runtime`;
	let root: SQL;
	let sql: SQL;
	let writer: PostgresStore;
	let memory: MemoryStorage;
	let storage: PostgresStore;
	let snapshotGuards: Array<ReturnType<typeof spyOn>> = [];
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
		const workflows = (await writer.getStore('workflows'))!;
		workflows.__setLogger(noopLogger);
		await workflows.init();
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
			content: { format: 2, parts: [{ type: 'text', text: editorialFixtureQuote }], metadata: { channel: 'sendblue', groupId: config.sendblueGroupId, senderNumber: '+15550000001', sentAt: '2026-09-02T01:00:00Z' } },
		}] });
		// This is the only storage attached to the model runtime, never the fixture writer.
		storage = new PostgresStore({ id: runtimeSchema, connectionString: readonlyUrl(databaseUrl!), schemaName: schema, disableInit: true });
		storage.__setLogger(noopLogger);
		for (const domain of Object.values(storage.stores)) domain?.__setLogger(noopLogger);
		expect((await storage.db.one('SHOW default_transaction_read_only')).default_transaction_read_only).toBe('on');
		const workflows = (await storage.getStore('workflows'))!;
		// Count attempts too: the SDK can catch a failed read-only snapshot write.
		snapshotGuards = (['init', 'persistWorkflowSnapshot', 'updateWorkflowResults', 'updateWorkflowState', 'deleteWorkflowRunById'] as const)
			.map(method => spyOn(workflows, method).mockName(method));
	});

	afterEach(async () => {
		try {
			expect(snapshotGuards.flatMap(guard => guard.mock.calls.map((args: Array<{ workflowName?: string } | undefined>) => ({
				method: guard.getMockName(),
				workflowName: args[0]?.workflowName,
			})))).toEqual([]);
			expect((await root`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = ${runtimeSchema}`)[0].n).toBe(0);
		} finally {
			for (const guard of snapshotGuards) guard.mockRestore();
			snapshotGuards = [];
			await storage?.close();
		}
	});
	afterAll(async () => {
		await writer?.close();
		await sql?.close();
		if (root) {
			await root.unsafe(`DROP SCHEMA IF EXISTS "${runtimeSchema}" CASCADE`);
			await root.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
			await root.close();
		}
	});

	async function snapshot() {
		const rows: Record<string, Array<{ count: number; hash: string }>> = {};
		for (const table of ['fantasy_recap_generations', 'fantasy_recap_runs', 'mastra_messages', 'mastra_threads', 'mastra_workflow_snapshot']) {
			rows[table] = [...await sql.unsafe(`SELECT count(*)::int AS count,
				md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) AS hash FROM "${table}" t`)];
		}
		const relations = [...await root`SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname IN (${schema}, ${runtimeSchema}) ORDER BY c.relname, c.relkind`];
		return { rows, relations };
	}

	function nativeFixture(onCall?: (input: EditorialModelInput) => Promise<void>, multipart = false) {
		let packet: RecapEvidencePacket;
		const outcomes: EditorialOutcome[] = [];
		const fixture = editorialFixtureRuntime(async (input) => {
			await onCall?.(input);
			if (input.role === 'reviewer')
				return passingEditorialReview(input.data);
			const draft = validEditorialDraft(packet);
			if (multipart) {
				draft.manager.body += ' The result spoke clearly.'.repeat(350);
				draft.loser.body += ' The result spoke clearly.'.repeat(350);
			}
			return { case: 'completed', result: draft };
		}, { storage });
		const prepare = createProcedure(fixture.runtime);
		return { ...fixture, outcomes, prepare: async (input: RecapEvidencePacket, signal?: AbortSignal) => {
			packet = input;
			const outcome = await prepare(input, signal);
			outcomes.push(outcome);
			return outcome;
		} };
	}

	test.each([false, true])('native preview preserves exact reviewed parts and the entire read-only interval (multipart=%s)', async (multipart) => {
		const before = await snapshot();
		const fixture = nativeFixture(async () => {
			expect(await snapshot()).toEqual(before);
		}, multipart);
		expect(fixture.runtime.getStorage()?.id).toBe(runtimeSchema);
		const result = await preview(request(), { ...options(), prepare: fixture.prepare });
		expect({ status: result.status, reason: result.reason, counts: result.counts, databaseUnchanged: result.databaseUnchanged })
			.toEqual({ status: 'approved', reason: null, counts: { drafts: 1, reviews: 1 }, databaseUnchanged: true });
		expect(fixture.calls.map(call => call.role)).toEqual(['writer', 'reviewer']);
		expect(fixture.resolved.length).toBeGreaterThan(0);
		expect(fixture.resolved.every(id => id === 'gpt-6-astra')).toBe(true);
		expect(Object.keys(fixture.runtime.listAgents())).toEqual([]);
		expect(Object.keys(fixture.runtime.listWorkflows())).toEqual([]);
		expect(() => fixture.runtime.getWorkflow('prepare_fantasy_recap')).toThrow();
		expect(result.packet?.chat?.status).toBe('complete');
		expect(resolveChatSource(result.packet!, 'exact-source')?.text).toBe(editorialFixtureQuote);
		expect(Object.isFrozen(result.packet)).toBe(true);
		expect(result.outcome?.status).toBe('approved');
		if (result.outcome?.status !== 'approved')
			throw new Error('Expected approved native candidate');
		const { candidate, review } = result.outcome;
		expect(candidate.parts).toHaveLength(multipart ? 2 : 1);
		expect(candidate.parts.filter(part => part.includes(editorialFixtureQuote))).toHaveLength(1);
		expect(candidate.draft.quote?.messageId).toBe('exact-source');
		expect(candidate.evidenceId).toBe(result.packet!.id);
		expect(review.candidateId).toBe(candidate.id);
		expect(review.evidenceId).toBe(result.packet!.id);
		expect(fixture.calls[1].data.candidate).toEqual(candidate);
		expect(buildEditorialCandidate(result.packet!, candidate.draft)).toEqual({ status: 'candidate', candidate });
		expect(fixture.outcomes).toEqual([result.outcome]);
		expect(await snapshot()).toEqual(before);
		expect((await sql`SELECT saved_text FROM fantasy_recap_generations`)[0].saved_text).toBe('Saved recap must stay exact');
	});

	test.each([
		['fantasy_recap_generations', 'writer'],
		['fantasy_recap_generations', 'reviewer'],
		['fantasy_recap_runs', 'writer'],
		['fantasy_recap_runs', 'reviewer'],
	] as const)('same-count mutation of %s during %s drops approval but keeps accurate counts', async (table, role) => {
		const before = await snapshot();
		const fixture = nativeFixture(async (input) => {
			if (input.role === role)
				await sql.unsafe(`UPDATE "${table}" SET extra = '{"revision":2}'`);
		});
		const result = await preview(request(), { ...options(), prepare: fixture.prepare });
		expect(fixture.outcomes[0]).toMatchObject({ status: 'approved', counts: { drafts: 1, reviews: 1 } });
		expect(result).toEqual({ status: 'blocked', reason: 'recap_state_changed_during_preview', packet: null, outcome: null, counts: { drafts: 1, reviews: 1 }, databaseUnchanged: false });
		expect(fixture.calls.map(call => call.role)).toEqual(['writer', 'reviewer']);
		expect(result.counts.drafts).toBe(fixture.calls.filter(call => call.role === 'writer').length);
		expect(result.counts.reviews).toBe(fixture.calls.filter(call => call.role === 'reviewer').length);
		expect(JSON.stringify(result)).not.toContain(editorialFixtureQuote);
		const after = await snapshot();
		expect(after.rows[table][0].count).toBe(before.rows[table][0].count);
		expect(after.rows[table][0].hash).not.toBe(before.rows[table][0].hash);
		for (const other of Object.keys(before.rows).filter(name => name !== table)) expect(after.rows[other]).toEqual(before.rows[other]);
		expect(after.relations).toEqual(before.relations);
	});

	test('post-model database check failure drops approval without losing counts or leaking details', async () => {
		let hidden = false;
		const fixture = nativeFixture(async ({ role }) => {
			if (role === 'reviewer') {
				await sql`ALTER TABLE fantasy_recap_runs RENAME TO fixture_hidden_runs`;
				hidden = true;
			}
		});
		try {
			const result = await preview(request(), { ...options(), prepare: fixture.prepare });
			expect(fixture.outcomes[0]).toMatchObject({ status: 'approved', counts: { drafts: 1, reviews: 1 } });
			expect(result).toEqual({ status: 'blocked', reason: 'preview_recap_state_unavailable', packet: null, outcome: null, counts: { drafts: 1, reviews: 1 }, databaseUnchanged: false });
			expect(fixture.calls).toHaveLength(2);
			expect(JSON.stringify(result)).not.toContain('fixture_hidden_runs');
		} finally {
			if (hidden)
				await sql`ALTER TABLE fixture_hidden_runs RENAME TO fantasy_recap_runs`;
		}
	});

	test.each(['missing-thread', 'missing-table'] as const)('%s archive blocks before any native model call', async (fault) => {
		const fixture = nativeFixture();
		if (fault === 'missing-thread')
			await sql`DELETE FROM mastra_threads`;
		else await sql`ALTER TABLE mastra_threads RENAME TO fixture_hidden_threads`;
		try {
			const result = await preview(request(), { ...options(), prepare: fixture.prepare });
			expect(result).toMatchObject({ status: 'blocked', reason: 'evidence_blocked', outcome: null, counts: { drafts: 0, reviews: 0 }, databaseUnchanged: true });
			expect(result.packet?.chat?.gaps).toContain(fault === 'missing-thread' ? 'archive_thread_unavailable' : 'archive_unavailable');
			expect(fixture.calls).toHaveLength(0);
			expect(fixture.resolved).toHaveLength(0);
			expect(fixture.outcomes).toHaveLength(0);
			expect(JSON.stringify(result)).not.toContain('fixture_hidden_threads');
		} finally {
			if (fault === 'missing-table')
				await sql`ALTER TABLE fixture_hidden_threads RENAME TO mastra_threads`;
		}
	});

	test.each(['fantasy_recap_generations', 'fantasy_recap_runs'])('missing %s blocks before collection or native model calls', async (table) => {
		const fixture = nativeFixture();
		const publicRead = spyOn(sleeper, 'getNflState');
		await sql.unsafe(`ALTER TABLE "${table}" RENAME TO fixture_hidden_recap`);
		try {
			const result = await preview(request(), { ...options(), prepare: fixture.prepare });
			expect(result).toEqual({ status: 'blocked', reason: 'preview_recap_state_unavailable', packet: null, outcome: null, counts: { drafts: 0, reviews: 0 }, databaseUnchanged: false });
			expect(publicRead).not.toHaveBeenCalled();
			expect(fixture.calls).toHaveLength(0);
			expect(fixture.resolved).toHaveLength(0);
			expect((await sql`SELECT to_regclass(${`${schema}.${table}`}) AS name`)[0].name).toBeNull();
		} finally {
			publicRead.mockRestore();
			await sql.unsafe(`ALTER TABLE fixture_hidden_recap RENAME TO "${table}"`);
		}
	});

	test('unavailable loopback database blocks before model calls', async () => {
		const fixture = nativeFixture();
		const unavailableUrl = new URL(databaseUrl!);
		unavailableUrl.port = '1';
		const result = await preview({ ...request(), databaseUrl: unavailableUrl.toString() }, { ...options(), prepare: fixture.prepare });
		expect(result).toEqual({ status: 'blocked', reason: 'preview_database_unavailable', packet: null, outcome: null, counts: { drafts: 0, reviews: 0 }, databaseUnchanged: false });
		expect(fixture.calls).toHaveLength(0);
		expect(fixture.resolved).toHaveLength(0);
		expect(JSON.stringify(result)).not.toContain(unavailableUrl.toString());
	}, 10000);

	test.each([false, true])('prepare callback exception is safe and still checks DB afterward (mutation=%s)', async (mutate) => {
		const before = await snapshot();
		let callbacks = 0;
		const result = await preview(request(), { ...options(), prepare: async () => {
			callbacks++;
			if (mutate)
				await sql`UPDATE fantasy_recap_runs SET extra = '{"revision":2}'`;
			throw new Error('PRIVATE_CALLBACK_ERROR');
		} });
		expect(callbacks).toBe(1);
		expect(result).toEqual({ status: 'blocked', reason: mutate ? 'recap_state_changed_during_preview' : 'preview_candidate_failed', packet: null, outcome: null, counts: { drafts: 0, reviews: 0 }, databaseUnchanged: !mutate });
		expect(JSON.stringify(result)).not.toContain('PRIVATE_CALLBACK_ERROR');
		const after = await snapshot();
		if (!mutate) {
			expect(after).toEqual(before);
		} else {
			expect(after.rows.fantasy_recap_runs[0].count).toBe(before.rows.fantasy_recap_runs[0].count);
			expect(after.rows.fantasy_recap_runs[0].hash).not.toBe(before.rows.fantasy_recap_runs[0].hash);
		}
	});
});
