import type { GenerationState } from '../generation-state';
import type { SqlLike } from '../recaps';
import type { SavedReportScope } from '../saved-report';
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportGenerationDebug, purgeGenerationDebugExports } from '../generation-debug';
import { GENERATION_LIMITS, generationReference, initialGenerationState, parseGenerationState } from '../generation-state';
import { editorialFixtureNow, editorialFixtureWindow, frozenEditorialFixture, validEditorialDraft } from './fixtures/editorial.fixture';

const now = editorialFixtureNow().toISOString();
const at = (milliseconds: number) => new Date(Date.parse(now) + milliseconds).toISOString();
const roots: string[] = [];
const exportFailure = 'generation_debug_export_failed';
const purgeFailure = 'generation_debug_purge_failed';
const secret = 'PRIVATE postgres://user:password@host/db /private/path fixture-group';
let fetchGuard: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

beforeAll(() => {
	const rejectNetwork = () => {
		throw new Error('unexpected_fixture_network');
	};
	fetchGuard = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(rejectNetwork, { preconnect: rejectNetwork }));
});
afterAll(() => {
	expect(fetchGuard).not.toHaveBeenCalled();
	fetchGuard.mockRestore();
});
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function directory() {
	// macOS /var and /tmp are symlinks; the managed path itself must have no symlink components.
	const root = await mkdtemp(join(await realpath(tmpdir()), 'generation-debug-'));
	roots.push(root);
	return { root, managed: join(root, 'data', 'fantasy-debug') };
}

async function fixture(start = now) {
	const packet = await frozenEditorialFixture();
	const scope: SavedReportScope = {
		leagueId: packet.scope.leagueId,
		groupId: packet.scope.groupId,
		season: Number(packet.scope.season),
		week: packet.scope.week,
	};
	const state = initialGenerationState(scope, editorialFixtureWindow, randomUUID(), start, packet.scope.calendarProof);
	const attempt = state.current;
	attempt.phase = 'blocked';
	attempt.reasonCode = 'review_rejected';
	attempt.paidWorkAtUtc = start;
	attempt.editorialDeadlineAtUtc = new Date(Date.parse(start) + 1_800_000).toISOString();
	attempt.evidenceId = packet.id;
	attempt.counts = { nfl: 1, drafts: 1, reviews: 1 };
	const draft = validEditorialDraft(packet);
	draft.evidenceId = 'rejected-foreign-evidence';
	const review = {
		evidenceId: 'rejected-foreign-evidence',
		candidateId: 'rejected-foreign-candidate',
		verdict: 'fail',
		issues: [{ path: 'quote.body', category: 'quote_privacy', message: 'PRIVATE rejected quote', supportIds: [] }],
	};
	const bundle = state.debug[attempt.id];
	bundle.packetJson = JSON.stringify(packet);
	bundle.notes = ['writer:partial', 'reviewer:blocked'];
	for (const [kind, contributionCase, value] of [
		['nfl', 'failed', null],
		['writer', 'partial', draft],
		['reviewer', 'blocked', review],
	] as const) {
		const id = randomUUID();
		attempt.calls.push({
			id,
			kind,
			ordinal: 1,
			state: contributionCase === 'failed' ? 'failed' : 'completed',
			atUtc: start,
			deadlineAtUtc: new Date(Date.parse(start) + 600_000).toISOString(),
			settledAtUtc: start,
			code: `contribution:${contributionCase}`,
		});
		bundle.outputs.push({
			callId: id,
			kind,
			ordinal: 1,
			contributionCase,
			valueJson: value === null ? null : JSON.stringify(value),
			atUtc: start,
		});
	}
	const prior = initialGenerationState(scope, editorialFixtureWindow, randomUUID(), start);
	state.prior.push(prior.current);
	state.debug[prior.current.id] = { packetJson: null, outputs: [], notes: ['collector_unavailable'] };
	return parseGenerationState(state);
}

type Clock = Date | Error | (() => Promise<Date>);
function database(state: GenerationState | null, readNow = now, clocks: Clock[] = [new Date(readNow)]) {
	const queries: Array<{ text: string; values: unknown[] }> = [];
	const store = {
		row: state
			? {
					editorial_attempt: state,
					status: state.current.phase === 'collecting' ? 'started' : 'failed',
					claim_token: null,
					lease_stamp: null,
					lease_current: false,
					db_now: new Date(readNow),
					publication_exists: false,
				}
			: null,
		history: [{ finalText: 'unchanged historical report' }],
		sentReport: { finalText: 'unchanged published report' },
	};
	const sql: SqlLike = async (strings, ...values) => {
		const text = strings.join('?').replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
		queries.push({ text, values });
		if (text === 'SELECT clock_timestamp() AS db_now') {
			const clock = clocks.shift();
			if (clock instanceof Error)
				throw clock;
			if (!clock)
				throw new Error(`unexpected_clock_query ${secret}`);
			return [{ db_now: typeof clock === 'function' ? await clock() : clock }];
		}
		expect(text).toBe('SELECT editorial_attempt, status, claim_token, lease_expires_at::text AS lease_stamp, lease_expires_at > clock_timestamp() AS lease_current, clock_timestamp() AS db_now, (saved_report IS NOT NULL OR part_delivery IS NOT NULL OR final_text IS NOT NULL OR send_attempt_at IS NOT NULL) AS publication_exists FROM fantasy_recap_runs WHERE league_id = ? AND fantasy_week = ?');
		if (!state || values[0] !== state.current.scope.leagueId || values[1] !== state.current.scope.week)
			return [];
		return [store.row];
	};
	return { sql, store, queries };
}

async function safeFailure(promise: Promise<unknown>, code = exportFailure) {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(Error);
	expect(String(caught)).toBe(`Error: ${code}`);
	expect(caught).not.toHaveProperty('cause');
	expect(JSON.stringify(caught)).not.toContain(secret);
}

const filename = (state: GenerationState) => `attempt-${state.current.id}.json`;
function envelope(state: GenerationState) {
	return { version: 'fantasy-debug-export-v1', attempt: state.current, bundle: state.debug[state.current.id] };
}

async function storeFile(directory: string, name: string, value: unknown) {
	await writeFile(join(directory, name), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
}

describe('managed private generation debug exports', () => {
	it('preserves exact packet bytes, typed rejected outputs and progress, with 0700/0600 modes and no DB mutation', async () => {
		const state = await fixture();
		const { managed } = await directory();
		const db = database(state);
		const before = JSON.stringify(db.store);
		const result = await exportGenerationDebug(generationReference(state), db.sql, managed);
		expect(result).toEqual({
			attemptId: state.current.id,
			expiresAtUtc: at(GENERATION_LIMITS.debugMs),
			path: join(managed, filename(state)),
		});
		expect((await lstat(managed)).mode & 0o777).toBe(0o700);
		expect((await lstat(result.path)).mode & 0o777).toBe(0o600);
		const exported = JSON.parse(await readFile(result.path, 'utf8'));
		expect(exported).toEqual(envelope(state));
		expect(exported.bundle.packetJson).toBe(state.debug[state.current.id].packetJson);
		expect(JSON.parse(exported.bundle.outputs[1].valueJson).evidenceId).toBe('rejected-foreign-evidence');
		expect(JSON.parse(exported.bundle.outputs[2].valueJson).verdict).toBe('fail');
		expect(JSON.stringify(db.store)).toBe(before);
		expect(db.queries).toHaveLength(2);
		expect(db.queries[0].values).toEqual([state.current.scope.leagueId, state.current.scope.week]);
	});

	it('rejects missing, expired, purged and empty debug without creating a file or regenerating', async () => {
		const state = await fixture();
		const purged = structuredClone(state);
		delete purged.debug[state.current.id];
		const empty = initialGenerationState(state.current.scope, editorialFixtureWindow, state.current.id, now);
		const expired = database(state, state.current.debugExpiresAtUtc);
		const cases = [database(null), expired, database(purged), database(empty)];
		for (const db of cases) {
			const { root, managed } = await directory();
			await safeFailure(exportGenerationDebug(generationReference(state), db.sql, managed));
			expect(await readdir(root)).toEqual([]);
			expect(db.queries).toHaveLength(1);
		}
	});

	it('binds lookup to group, season, league, week and attempt; rejects path-like attempt selectors', async () => {
		const state = await fixture();
		const { root, managed } = await directory();
		const ref = generationReference(state);
		for (const changed of [
			{ groupId: 'foreign-private-group' },
			{ season: 2025 },
			{ leagueId: 'foreign-private-league' },
			{ week: 2 },
			{ attemptId: randomUUID() },
			{ attemptId: '../private' },
		]) {
			await safeFailure(exportGenerationDebug({ ...ref, ...changed }, database(state).sql, managed));
		}
		expect(await readdir(root)).toEqual([]);
	});

	it('rejects malformed typed outputs and packet identity without leaking payload or SQL failures', async () => {
		const state = await fixture();
		const { root, managed } = await directory();
		const badOutput = structuredClone(state);
		badOutput.debug[state.current.id].outputs[1].valueJson = JSON.stringify({ object: { secret } });
		const badPacket = structuredClone(state);
		badPacket.debug[state.current.id].packetJson += secret;
		for (const bad of [badOutput, badPacket])
			await safeFailure(exportGenerationDebug(generationReference(state), database(bad).sql, managed));
		await safeFailure(exportGenerationDebug(generationReference(state), async () => {
			throw new Error(secret);
		}, managed));
		expect(await readdir(root)).toEqual([]);
	});

	it('never overwrites an existing export or follows a final-file symlink', async () => {
		const state = await fixture();
		const { root, managed } = await directory();
		const ref = generationReference(state);
		const result = await exportGenerationDebug(ref, database(state).sql, managed);
		const original = await readFile(result.path, 'utf8');
		await safeFailure(exportGenerationDebug(ref, database(state).sql, managed));
		expect(await readFile(result.path, 'utf8')).toBe(original);
		await rm(result.path);
		const target = join(root, 'unrelated.json');
		await writeFile(target, secret);
		await symlink(target, result.path);
		await safeFailure(exportGenerationDebug(ref, database(state).sql, managed));
		expect((await lstat(result.path)).isSymbolicLink()).toBe(true);
		expect(await readFile(target, 'utf8')).toBe(secret);
	});

	it('rejects symlink directories and ancestors, non-directories and loose modes without altering them', async () => {
		const state = await fixture();
		const { root } = await directory();
		const target = join(root, 'target');
		await mkdir(target, { mode: 0o700 });
		const link = join(root, 'link');
		await symlink(target, link);
		const regular = join(root, 'regular');
		await writeFile(regular, secret);
		const loose = join(root, 'loose');
		await mkdir(loose, { mode: 0o700 });
		await chmod(loose, 0o755);
		for (const path of [link, join(link, 'child'), regular, loose]) {
			await safeFailure(exportGenerationDebug(generationReference(state), database(state).sql, path));
			await safeFailure(purgeGenerationDebugExports(database(state).sql, path), purgeFailure);
		}
		expect(await readdir(target)).toEqual([]);
		expect(await readdir(loose)).toEqual([]);
		expect((await lstat(loose)).mode & 0o777).toBe(0o755);
		expect(await readFile(regular, 'utf8')).toBe(secret);
		expect((await lstat(link)).isSymbolicLink()).toBe(true);
	});

	it('removes only the just-created export on after-write expiry, clock error or invalid clock', async () => {
		const state = await fixture();
		const { managed } = await directory();
		for (const clock of [new Date(state.current.debugExpiresAtUtc), new Error(secret), new Date(Number.NaN)]) {
			const db = database(state, now, [async () => {
				expect(JSON.parse(await readFile(join(managed, filename(state)), 'utf8'))).toEqual(envelope(state));
				if (clock instanceof Error)
					throw clock;
				return clock;
			}]);
			await safeFailure(exportGenerationDebug(generationReference(state), db.sql, managed));
			expect(await readdir(managed)).toEqual([]);
			expect(db.queries).toHaveLength(2);
		}
	});

	it('exports retained prior attempts without extending expiry', async () => {
		const state = await fixture();
		const { managed } = await directory();
		const prior = state.prior[0];
		const ref = { ...prior.scope, attemptId: prior.id };
		const result = await exportGenerationDebug(ref, database(state).sql, managed);
		expect(result.expiresAtUtc).toBe(prior.debugExpiresAtUtc);
		const exported = JSON.parse(await readFile(result.path, 'utf8'));
		expect(exported.attempt).toEqual(prior);
		expect(exported.bundle).toEqual(state.debug[prior.id]);
	});

	it('purges only own valid exports at original DB-clock expiry, preserving foreign files and source state', async () => {
		const expired = await fixture();
		const live = await fixture(at(86_400_000));
		const { root, managed } = await directory();
		await exportGenerationDebug(generationReference(expired), database(expired).sql, managed);
		await exportGenerationDebug(generationReference(live), database(live, live.current.startedAtUtc).sql, managed);
		const outside = join(root, 'operator-copy.json');
		await writeFile(outside, JSON.stringify(envelope(expired)));
		await storeFile(managed, 'unrelated.json', envelope(expired));
		await storeFile(managed, 'attempt-not-a-uuid.json', envelope(expired));
		await storeFile(managed, `attempt-${randomUUID()}.json`, envelope(expired));
		const malformed = await fixture();
		await writeFile(join(managed, filename(malformed)), '{PRIVATE invalid JSON');
		const alteredExpiry = await fixture();
		alteredExpiry.current.debugExpiresAtUtc = at(GENERATION_LIMITS.debugMs - 1);
		await storeFile(managed, filename(alteredExpiry), envelope(alteredExpiry));
		const alteredBundle = await fixture();
		alteredBundle.debug[alteredBundle.current.id].outputs[1].valueJson = JSON.stringify({ secret });
		await storeFile(managed, filename(alteredBundle), envelope(alteredBundle));
		const wrongVersion = await fixture();
		await storeFile(managed, filename(wrongVersion), { ...envelope(wrongVersion), version: 'foreign-v1' });
		const extraKeys = await fixture();
		await storeFile(managed, filename(extraKeys), { ...envelope(extraKeys), foreign: true });
		const linked = `attempt-${randomUUID()}.json`;
		await symlink(outside, join(managed, linked));
		const folder = `attempt-${randomUUID()}.json`;
		await mkdir(join(managed, folder));
		const names = (await readdir(managed)).sort();
		const beforeExpiry = database(expired, now, [new Date(at(GENERATION_LIMITS.debugMs - 1))]);
		expect(await purgeGenerationDebugExports(beforeExpiry.sql, managed)).toBe(0);
		const db = database(expired, now, [new Date(expired.current.debugExpiresAtUtc)]);
		const sourceBefore = JSON.stringify(db.store);
		expect(await purgeGenerationDebugExports(db.sql, managed)).toBe(1);
		expect((await readdir(managed)).sort()).toEqual(names.filter(name => name !== filename(expired)));
		expect((await lstat(join(managed, linked))).isSymbolicLink()).toBe(true);
		expect(await readFile(outside, 'utf8')).toBe(JSON.stringify(envelope(expired)));
		expect(JSON.stringify(db.store)).toBe(sourceBefore);
		expect(db.queries).toEqual([{ text: 'SELECT clock_timestamp() AS db_now', values: [] }]);
	});

	it('fails purge closed on DB errors and treats a missing managed directory as nothing to purge', async () => {
		const state = await fixture();
		const { root, managed } = await directory();
		expect(await purgeGenerationDebugExports(database(state).sql, managed)).toBe(0);
		expect(await readdir(root)).toEqual([]);
		await exportGenerationDebug(generationReference(state), database(state).sql, managed);
		const bytes = await readFile(join(managed, filename(state)), 'utf8');
		const db = database(state, now, [new Error(secret)]);
		await safeFailure(purgeGenerationDebugExports(db.sql, managed), purgeFailure);
		expect(await readFile(join(managed, filename(state)), 'utf8')).toBe(bytes);
	});
});
