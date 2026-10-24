import type { createFantasyEditorialProcedure as CreateProcedure } from '../../mastra/workflows/prepare-fantasy-recap';
import type { EditorialReview } from './editorial-loop';
import type { GenerationAttemptRef, GenerationState } from './generation-state';
import type { RecapGenerationRecord, SqlLike } from './recaps';
import type { SavedReport, SavedReportScope } from './saved-report';
import { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { buildEditorialCandidate } from './editorial';
import { editorialFixtureRuntime, passingEditorialReview } from './editorial-runtime.fixture';
import {
	editorialFixtureConfig,
	editorialFixtureNow,
	editorialFixtureQuote,
	editorialFixtureSleeper,
	editorialFixtureWindow,
	frozenEditorialFixture,
	validEditorialDraft,
} from './editorial.fixture';
import { createGenerationCapture } from './generation-capture';
import {
	blockGenerationAttempt,
	captureGenerationPacket,
	claimGenerationAttempt,
	findGenerationReference,
	generationApprovalState,
	getGenerationRun,
	markGenerationNotified,
	purgeGenerationDebug,
	readGenerationDebug,
	recordGenerationOutput,
	recoverGenerationAttempt,
	reserveGenerationCall,
} from './generation-runs';
import { GENERATION_LIMITS, GENERATION_VERSION, parseGenerationState } from './generation-state';
import { collectRecapEvidence } from './recap-evidence';
import { ensureFantasyRecapsTable, recordApprovedReport, recordClaimedGeneration, recordGeneration } from './recaps';
import { reportingWindowFixture } from './reporting-window.fixture';
import {
	beginSavedReportPart,
	claimRun,
	confirmSentByOperator,
	ensureFantasyRunsTable,
	expireStaleLeases,
	getSavedReportState,
	markDeliveryUnknown,
	markFailed,
	markSent,
	recordAttemptText,
	recordSavedReportPart,
	reserveSavedReportDelivery,
} from './runs';
import { buildSavedReport } from './saved-report';

type TransactionalSql = SqlLike & { begin: <T>(action: (sql: SqlLike) => Promise<T>) => Promise<T> };
type QueryMatch = (query: string, values: unknown[]) => boolean;
const normalized = (strings: TemplateStringsArray) => strings.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();

// Match the existing delivery fault fixture: throw AFTER native COMMIT, never inside its callback.
function faultSql(base: SqlLike, matches: QueryMatch, mode: 'after' | 'before' | 'delayed-ack' | 'delayed-read' | 'delayed-query' = 'after') {
	let hits = 0;
	let committedFault = false;
	const wrap = (client: SqlLike, transaction: boolean): SqlLike => {
		const tagged: SqlLike = async (strings, ...values) => {
			const match = hits === 0 && matches(normalized(strings), values);
			if (match) {
				hits++;
				if (mode === 'before')
					throw new Error('fixture SQL failure before write');
				if (mode === 'delayed-query')
					await Bun.sleep(400);
			}
			const result = await client(strings, ...values);
			if (match) {
				if (mode === 'delayed-read') {
					await Bun.sleep(400);
				} else if (mode !== 'delayed-query') {
					if (!transaction)
						throw new Error('fixture SQL acknowledgement lost');
					committedFault = true;
				}
			}
			return result;
		};
		if ('begin' in client && typeof client.begin === 'function') {
			Object.assign(tagged, {
				begin: async <T>(action: (sql: SqlLike) => Promise<T>): Promise<T> => {
					const result = await (client as TransactionalSql).begin(tx => action(wrap(tx, true)));
					if (committedFault) {
						committedFault = false;
						if (mode === 'delayed-ack')
							await Bun.sleep(400);
						else throw new Error('fixture SQL acknowledgement lost after commit');
					}
					return result;
				},
			});
		}
		return tagged;
	};
	return { sql: wrap(base, false), hits: () => hits };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// Never consult DATABASE_URL or permit a non-disposable database, port, or remote hostname.
const databaseUrl = process.env.JAMIS_TEST_DATABASE_URL;
if (databaseUrl) {
	const url = new URL(databaseUrl);
	if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)
		|| url.port !== '15458' || url.pathname !== '/jamis_sessions_test' || url.search || url.hash) {
		throw new Error('Disposable loopback port 15458 jamis_sessions_test URL required');
	}
}

describe.skipIf(!databaseUrl)('generation native PG gates (off live path, no model or sender)', () => {
	const schema = `generation_${randomUUID().replaceAll('-', '')}`;
	const token = 'fixture-generation-owner';
	const window = editorialFixtureWindow;
	const proof = reportingWindowFixture(window).source;
	let root: SQL;
	let sql: SQL;
	let packet: Awaited<ReturnType<typeof frozenEditorialFixture>>;
	let draft: ReturnType<typeof validEditorialDraft>;
	let review: EditorialReview;
	let report: SavedReport;
	let scope: SavedReportScope;
	let fetchGuard: ReturnType<typeof spyOn>;
	let createProcedure: typeof CreateProcedure;

	beforeAll(async () => {
		fetchGuard = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => {
			throw new Error('External fetch forbidden in generation fixture');
		}, { preconnect: () => { throw new Error('External preconnect forbidden in generation fixture'); } }));
		({ createFantasyEditorialProcedure: createProcedure } = await import('../../mastra/workflows/prepare-fantasy-recap'));
		root = new SQL(databaseUrl!, { connectionTimeout: 1 });
		await root.unsafe(`CREATE SCHEMA "${schema}"`);
		sql = new SQL(databaseUrl!, { connection: { search_path: schema } });
		await ensureFantasyRunsTable(sql);
		await ensureFantasyRunsTable(sql);
		await ensureFantasyRecapsTable(sql);
		packet = await frozenEditorialFixture();
		scope = {
			leagueId: packet.scope.leagueId,
			groupId: packet.scope.groupId,
			season: Number(packet.scope.season),
			week: packet.scope.week,
		};
		draft = validEditorialDraft(packet);
		const built = buildEditorialCandidate(packet, draft);
		if (built.status !== 'candidate')
			throw new Error('Fixture candidate required');
		review = { evidenceId: packet.id, candidateId: built.candidate.id, verdict: 'pass', issues: [] };
		report = buildSavedReport(packet, { status: 'approved', evidenceId: packet.id, candidate: built.candidate, review, counts: { drafts: 1, reviews: 1 } });
		expect(report.parts).toHaveLength(1);
		expect(report.scope).toEqual(scope);
		expect(packet.scope.chatWindow).toEqual(window);
		expect(fetchGuard).not.toHaveBeenCalled();
	}, 30_000);
	beforeEach(async () => {
		await sql`TRUNCATE fantasy_recap_runs, fantasy_recap_generations`;
	});
	afterEach(() => {
		expect(fetchGuard).not.toHaveBeenCalled();
	});
	afterAll(async () => {
		try {
			await sql?.close();
		} finally {
			try {
				if (root)
					await root.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
			} finally {
				try {
					await root?.close();
				} finally {
					fetchGuard?.mockRestore();
				}
			}
		}
	});

	async function claim(claimToken = token, expectedBlockedAttemptId?: string) {
		const ref = await claimGenerationAttempt(scope, window, claimToken, 'fixture-trace', sql, expectedBlockedAttemptId, proof);
		expect(ref).not.toBeNull();
		return ref!;
	}
	async function state() {
		const result = await getGenerationRun(scope, sql);
		expect(result).not.toBeNull();
		return result!;
	}
	async function snapshot() {
		return {
			runs: [...await sql`SELECT to_jsonb(r) AS row FROM fantasy_recap_runs r ORDER BY league_id, fantasy_week`],
			history: [...await sql`SELECT to_jsonb(g) AS row FROM fantasy_recap_generations g ORDER BY league_id, fantasy_week, generator_version, model`],
		};
	}
	async function unpublished() {
		const saved = await snapshot();
		expect(saved.history).toEqual([]);
		for (const run of saved.runs) {
			expect(run.row).toMatchObject({
				saved_report: null,
				part_delivery: null,
				final_text: null,
				send_attempt_at: null,
			});
		}
	}
	async function expireLease() {
		await sql`UPDATE fantasy_recap_runs SET lease_expires_at = ${new Date(Date.now() - 1_000).toISOString()}`;
	}
	async function writer(ref: GenerationAttemptRef, claimToken = token) {
		expect(await captureGenerationPacket(ref, claimToken, packet, sql)).toBe(true);
		const call = await reserveGenerationCall(ref, claimToken, 'writer', 1, sql);
		expect(call).not.toBeNull();
		expect(await recordGenerationOutput(ref, call!.id, 'completed', draft, sql)).toBe(true);
		return call!;
	}
	async function reviewed(ref: GenerationAttemptRef, value: EditorialReview = review) {
		await writer(ref);
		const call = await reserveGenerationCall(ref, token, 'reviewer', 1, sql);
		expect(call).not.toBeNull();
		expect(await recordGenerationOutput(ref, call!.id, 'completed', value, sql)).toBe(true);
		return call!;
	}
	async function save() {
		const ref = await claim();
		await reviewed(ref);
		expect(await recordApprovedReport(report, token, sql)).toBe(true);
		return ref;
	}
	async function legacyGeneration() {
		const next = structuredClone((await state()).generation);
		delete next.current.calendarProof;
		const legacyPacket = { ...packet, scope: { ...packet.scope } };
		delete legacyPacket.scope.calendarProof;
		Object.freeze(legacyPacket.scope);
		legacyPacket.id = '';
		legacyPacket.id = `evidence-${createHash('sha256').update(JSON.stringify(legacyPacket)).digest('hex')}`;
		const legacyDraft = validEditorialDraft(legacyPacket);
		const built = buildEditorialCandidate(Object.freeze(legacyPacket), legacyDraft);
		if (built.status !== 'candidate')
			throw new Error('Legacy fixture candidate required');
		const legacyReview = { ...review, evidenceId: legacyPacket.id, candidateId: built.candidate.id };
		const bundle = next.debug[next.current.id];
		if (bundle.packetJson !== null) {
			bundle.packetJson = JSON.stringify(legacyPacket);
			next.current.evidenceId = legacyPacket.id;
			if (next.current.candidateId !== null)
				next.current.candidateId = built.candidate.id;
			for (const output of bundle.outputs)
				output.valueJson = JSON.stringify(output.kind === 'writer' ? legacyDraft : legacyReview);
		}
		await sql`UPDATE fantasy_recap_runs SET editorial_attempt = ${parseGenerationState(next)}`;
		return buildSavedReport(Object.freeze(legacyPacket), { status: 'approved', evidenceId: legacyPacket.id, candidate: built.candidate, review: legacyReview, counts: { drafts: 1, reviews: 1 } });
	}
	function legacyRecord(): RecapGenerationRecord {
		return { leagueId: scope.leagueId, fantasyWeek: scope.week, generatorVersion: 'fantasy-recap-v12', model: 'fixture-model', finalText: 'legacy bytes', facts: packet.facts! };
	}
	// Shift only audit metadata; packet bytes and the historical chat window must stay unchanged.
	async function ageAttempts(milliseconds: number, attemptIds?: string[]) {
		const next = structuredClone((await state()).generation);
		const shift = (value: string) => new Date(Date.parse(value) - milliseconds).toISOString();
		for (const attempt of [next.current, ...next.prior]) {
			if (attemptIds && !attemptIds.includes(attempt.id))
				continue;
			for (const key of ['startedAtUtc', 'workDeadlineAtUtc', 'debugExpiresAtUtc', 'paidWorkAtUtc', 'editorialDeadlineAtUtc', 'notifiedAtUtc'] as const) {
				if (attempt[key] !== null)
					attempt[key] = shift(attempt[key]);
			}
			for (const call of attempt.calls) {
				call.atUtc = shift(call.atUtc);
				call.deadlineAtUtc = shift(call.deadlineAtUtc);
				if (call.settledAtUtc !== null)
					call.settledAtUtc = shift(call.settledAtUtc);
			}
			for (const output of next.debug[attempt.id]?.outputs ?? [])
				output.atUtc = shift(output.atUtc);
		}
		const checked = parseGenerationState(next);
		await sql`UPDATE fantasy_recap_runs SET editorial_attempt = ${checked}`;
		return checked;
	}

	test('unknown scope is absent; fresh owner gets exactly 45m lease and 40m work, with no paid intent', async () => {
		expect(await getGenerationRun(scope, sql)).toBeNull();
		expect(await findGenerationReference(scope.leagueId, scope.week, scope.groupId, randomUUID(), sql)).toBeNull();
		const ref = await claim();
		const current = await state();
		expect(current).toMatchObject({ status: 'started', claimToken: token, leaseCurrent: true, publicationExists: false });
		expect(current.generation.current).toMatchObject({ id: ref.attemptId, scope, window, generatorVersion: GENERATION_VERSION, phase: 'collecting', paidWorkAtUtc: null, counts: { nfl: 0, drafts: 0, reviews: 0 }, calls: [] });
		const meta = current.generation.current;
		const started = Date.parse(meta.startedAtUtc);
		expect(Date.parse(current.leaseStamp!) - started).toBe(GENERATION_LIMITS.leaseMs);
		expect(Date.parse(meta.workDeadlineAtUtc) - started).toBe(GENERATION_LIMITS.workMs);
		expect(Date.parse(meta.debugExpiresAtUtc) - started).toBe(GENERATION_LIMITS.debugMs);
		await unpublished();
	});

	test.each(['nfl', 'writer', 'reviewer'] as const)('readable proofless history cannot reserve a paid %s call', async (kind) => {
		const ref = await claim();
		if (kind === 'writer')
			expect(await captureGenerationPacket(ref, token, packet, sql)).toBe(true);
		if (kind === 'reviewer')
			await writer(ref);
		await legacyGeneration();
		const before = await snapshot();
		expect(Object.hasOwn((await state()).generation.current, 'calendarProof')).toBe(false);
		expect(await readGenerationDebug(ref, sql)).not.toBeNull();
		expect(await reserveGenerationCall(ref, token, kind, 1, sql)).toBeNull();
		expect(await snapshot()).toEqual(before);
	});

	test('proofless reviewed history remains readable but cannot create a new approval', async () => {
		const ref = await claim();
		await reviewed(ref);
		const legacyReport = await legacyGeneration();
		const before = await snapshot();
		expect(generationApprovalState(await state(), legacyReport)).toBeNull();
		expect(await recordApprovedReport(legacyReport, token, sql)).toBe(false);
		expect(await snapshot()).toEqual(before);
		await unpublished();
	});

	test('already-saved proofless approval reconciles without rewriting legacy state or history', async () => {
		const ref = await claim();
		await reviewed(ref);
		const legacyReport = await legacyGeneration();
		const legacy = (await state()).generation;
		await sql`UPDATE fantasy_recap_runs SET editorial_attempt = NULL`;
		expect(await recordApprovedReport(legacyReport, token, sql)).toBe(true);
		legacy.current.phase = 'approved';
		legacy.current.reportId = legacyReport.id;
		await sql`UPDATE fantasy_recap_runs SET editorial_attempt = ${parseGenerationState(legacy)}`;
		const before = await snapshot();
		expect(await recordApprovedReport(legacyReport, token, sql)).toBe(true);
		const after = await snapshot();
		expect(after.history).toEqual(before.history);
		expect(after.runs[0].row.editorial_attempt).toEqual(before.runs[0].row.editorial_attempt);
		expect(after.runs[0].row.saved_report).toEqual(before.runs[0].row.saved_report);
		expect(after.runs[0].row.final_text).toBe(before.runs[0].row.final_text);
		expect(Object.hasOwn((await state()).generation.current, 'calendarProof')).toBe(false);
	});

	test('a proofless blocked attempt cannot be restarted or retrofitted even with the exact selector', async () => {
		const ref = await claimGenerationAttempt(scope, window, token, null, sql);
		expect(ref).not.toBeNull();
		expect(await blockGenerationAttempt(ref!, token, 'legacy_held', sql)).toBe(true);
		const before = await snapshot();
		for (const source of [undefined, proof])
			expect(await claimGenerationAttempt(scope, window, 'restart', null, sql, ref!.attemptId, source)).toBeNull();
		expect(await snapshot()).toEqual(before);
		expect((await state()).generation.prior).toEqual([]);
	});

	test('verified exact restart rejects a missing, changed or rebased proof and preserves the original audit after purge', async () => {
		const old = await claim();
		await writer(old);
		expect(await blockGenerationAttempt(old, token, 'held', sql)).toBe(true);
		await ageAttempts(31 * 24 * 60 * 60_000);
		const before = await snapshot();
		const prior = (await state()).generation.current;
		const changed = structuredClone(proof);
		changed.retrievedAtUtc = new Date(Date.parse(changed.retrievedAtUtc) + 1_000).toISOString();
		const rebased = { ...window, startAtUtc: '2026-08-31T00:00:00.000Z' };
		const rejected = [
			[window, undefined],
			[window, changed],
			[rebased, reportingWindowFixture(rebased).source],
		] as const;
		for (const [bounds, source] of rejected)
			expect(await claimGenerationAttempt(scope, bounds, 'restart', null, sql, old.attemptId, source)).toBeNull();
		expect(await snapshot()).toEqual(before);
		const reordered = Object.fromEntries(Object.entries(proof).reverse()) as typeof proof;
		const next = await claimGenerationAttempt(scope, window, 'restart', null, sql, old.attemptId, reordered);
		expect(next).not.toBeNull();
		expect(next!.attemptId).not.toBe(old.attemptId);
		expect((await state()).generation.current).toMatchObject({ window, calendarProof: proof });
		expect((await state()).generation.prior).toEqual([prior]);
		expect(await purgeGenerationDebug(sql)).toBe(1);
		expect((await state()).generation.prior).toEqual([prior]);
		expect((await state()).generation.current.calendarProof).toEqual(proof);
		expect(await readGenerationDebug(old, sql)).toBeNull();
	});

	test.each([false, true])('unpaid source retry may replace its window/proof while retaining prior proof presence: %s', async (verifiedPrior) => {
		const old = await claimGenerationAttempt(scope, window, token, null, sql, undefined, verifiedPrior ? proof : undefined);
		expect(old).not.toBeNull();
		expect(await blockGenerationAttempt(old!, token, 'source_unavailable', sql, true)).toBe(true);
		const prior = (await state()).generation.current;
		const bounds = { ...window, startAtUtc: '2026-08-31T00:00:00.000Z' };
		const source = reportingWindowFixture(bounds).source;
		const next = await claimGenerationAttempt(scope, bounds, 'retry', null, sql, undefined, source);
		expect(next).not.toBeNull();
		expect(next!.attemptId).not.toBe(old!.attemptId);
		expect((await state()).generation.current).toMatchObject({ window: bounds, calendarProof: source });
		expect((await state()).generation.prior).toEqual([prior]);
		expect(Object.hasOwn((await state()).generation.prior[0], 'calendarProof')).toBe(verifiedPrior);
		expect(await reserveGenerationCall(next!, 'retry', 'nfl', 1, sql)).not.toBeNull();
	});

	test.each(['season', 'week', 'window'] as const)('claim rejects calendar %s mismatch before persisting ownership', async (change) => {
		const changedScope = { ...scope, season: scope.season + (change === 'season' ? 1 : 0), week: scope.week + (change === 'week' ? 1 : 0) };
		const bounds = change === 'window' ? { ...window, startAtUtc: '2026-08-31T00:00:00.000Z' } : window;
		expect(await claimGenerationAttempt(changedScope, bounds, token, null, sql, undefined, proof)).toBeNull();
		expect((await snapshot()).runs).toEqual([]);
	});

	test('concurrent daily and manual initial entry produces one claim and one attempt', async () => {
		const results = await Promise.all(['daily', 'manual'].map(owner => claimGenerationAttempt(scope, window, owner, null, sql)));
		expect(results.filter(Boolean)).toHaveLength(1);
		expect((await snapshot()).runs).toHaveLength(1);
		expect((await state()).generation.prior).toEqual([]);
		expect(await claimGenerationAttempt(scope, window, (await state()).claimToken!, null, sql)).toBeNull();
	});

	test('paid intent is durable before dispatch; duplicate ordinals and overlapping calls cannot reenter', async () => {
		const ref = await claim();
		const calls = await Promise.all([reserveGenerationCall(ref, token, 'nfl', 1, sql), reserveGenerationCall(ref, token, 'nfl', 1, sql)]);
		expect(calls.filter(Boolean)).toHaveLength(1);
		const reserved = calls.find(Boolean)!;
		const current = (await state()).generation.current;
		expect(current.paidWorkAtUtc).not.toBeNull();
		expect(current.counts).toEqual({ nfl: 1, drafts: 0, reviews: 0 });
		expect(current.calls).toMatchObject([{ id: reserved.id, kind: 'nfl', ordinal: 1, state: 'reserved', settledAtUtc: null }]);
		expect(await reserveGenerationCall(ref, token, 'nfl', 2, sql)).toBeNull();
		expect(await recordGenerationOutput(ref, reserved.id, 'failed', null, sql)).toBe(true);
		expect(await reserveGenerationCall(ref, token, 'nfl', 1, sql)).toBeNull();
		await unpublished();
	});

	test('three NFL no-output failures consume the whole budget without a provider fixture', async () => {
		const ref = await claim();
		for (let ordinal = 1; ordinal <= 3; ordinal++) {
			const call = await reserveGenerationCall(ref, token, 'nfl', ordinal, sql);
			expect(call).not.toBeNull();
			expect(call!.remainingMs).toBeGreaterThan(0);
			expect(call!.remainingMs).toBeLessThanOrEqual(GENERATION_LIMITS.workMs);
			expect(await recordGenerationOutput(ref, call!.id, 'failed', null, sql)).toBe(true);
		}
		const before = await snapshot();
		for (const ordinal of [0, 1, 3, 4, 1.5])
			expect(await reserveGenerationCall(ref, token, 'nfl', ordinal, sql)).toBeNull();
		expect(await snapshot()).toEqual(before);
		expect((await state()).generation.current.counts.nfl).toBe(3);
	});

	test('writer and reviewer budgets stop at three, bounded by 600s call and 1800s editorial deadlines', async () => {
		const ref = await claim();
		expect(await reserveGenerationCall(ref, token, 'writer', 1, sql)).toBeNull();
		expect(await captureGenerationPacket(ref, token, packet, sql)).toBe(true);
		expect(await reserveGenerationCall(ref, token, 'reviewer', 1, sql)).toBeNull();
		let editorialDeadline: string | null = null;
		for (let ordinal = 1; ordinal <= 3; ordinal++) {
			for (const kind of ['writer', 'reviewer'] as const) {
				const call = await reserveGenerationCall(ref, token, kind, ordinal, sql);
				expect(call).not.toBeNull();
				expect(call!.remainingMs).toBeGreaterThan(0);
				expect(call!.remainingMs).toBeLessThanOrEqual(600_000);
				const meta = (await state()).generation.current;
				const intent = meta.calls.at(-1)!;
				if (editorialDeadline === null) {
					editorialDeadline = meta.editorialDeadlineAtUtc;
					expect(Date.parse(editorialDeadline!) - Date.parse(intent.atUtc)).toBeLessThanOrEqual(1_800_000);
				}
				expect(meta.editorialDeadlineAtUtc).toBe(editorialDeadline);
				expect(Date.parse(intent.deadlineAtUtc)).toBeLessThanOrEqual(Date.parse(editorialDeadline!));
				expect(await reserveGenerationCall(ref, token, kind, ordinal, sql)).toBeNull();
				expect(await recordGenerationOutput(ref, call!.id, 'completed', kind === 'writer' ? draft : review, sql)).toBe(true);
			}
		}
		expect(await reserveGenerationCall(ref, token, 'writer', 4, sql)).toBeNull();
		expect(await reserveGenerationCall(ref, token, 'reviewer', 4, sql)).toBeNull();
		expect(await reserveGenerationCall(ref, token, 'nfl', 1, sql)).toBeNull();
		expect((await state()).generation.current.counts).toEqual({ nfl: 0, drafts: 3, reviews: 3 });
	});

	test('a delayed reservation acknowledgement cannot start a native writer past its persisted deadline', async () => {
		const ref = await claim();
		await captureGenerationPacket(ref, token, packet, sql);
		const meta = (await state()).generation;
		meta.current.workDeadlineAtUtc = new Date(Date.now() + 250).toISOString();
		await sql`UPDATE fantasy_recap_runs SET editorial_attempt = ${parseGenerationState(meta)}`;
		const delayed = faultSql(sql, (query, values) => query.startsWith('update fantasy_recap_runs')
			&& values.some(value => value && typeof value === 'object' && 'current' in value
				&& (value as GenerationState).current.counts.drafts === 1), 'delayed-ack');
		const capture = createGenerationCapture(ref, token, delayed.sql);
		const fixture = editorialFixtureRuntime(({ role, data }) => role === 'writer'
			? { case: 'completed', result: draft }
			: passingEditorialReview(data));
		const outcome = await createProcedure(fixture.runtime)(packet, undefined, capture.observer);
		expect(outcome.status).toBe('blocked');
		expect(delayed.hits()).toBe(1);
		expect(fixture.calls).toHaveLength(0);
		expect((await state()).generation.current.calls).toMatchObject([{ state: 'reserved', kind: 'writer' }]);
		await unpublished();
	});

	test.each(['writer', 'reviewer'] as const)('late %s output stays private diagnostics, not further call or approval authority', async (kind) => {
		const ref = await claim();
		let call;
		if (kind === 'reviewer') {
			await writer(ref);
			call = await reserveGenerationCall(ref, token, 'reviewer', 1, sql);
		} else {
			await captureGenerationPacket(ref, token, packet, sql);
			call = await reserveGenerationCall(ref, token, 'writer', 1, sql);
		}
		expect(call).not.toBeNull();
		await ageAttempts(700_000);
		expect(await recordGenerationOutput(ref, call!.id, 'completed', kind === 'writer' ? draft : review, sql)).toBe(true);
		const current = (await state()).generation;
		expect(current.debug[ref.attemptId].outputs.at(-1)?.valueJson).toBe(JSON.stringify(kind === 'writer' ? draft : review));
		if (kind === 'writer')
			expect(current.current.candidateId).toBeNull();
		expect(await reserveGenerationCall(ref, token, kind === 'writer' ? 'reviewer' : 'writer', kind === 'writer' ? 1 : 2, sql)).toBeNull();
		expect(await recordApprovedReport(report, token, sql)).toBe(false);
		await unpublished();
	});

	test.each(['delayed-read', 'delayed-query'] as const)('approval cannot cross a persisted deadline during %s', async (mode) => {
		const ref = await claim();
		await reviewed(ref);
		const meta = (await state()).generation;
		const deadline = new Date(Date.now() + 250).toISOString();
		meta.current.editorialDeadlineAtUtc = deadline;
		for (const call of meta.current.calls) call.deadlineAtUtc = deadline;
		await sql`UPDATE fantasy_recap_runs SET editorial_attempt = ${parseGenerationState(meta)}`;
		const delayed = faultSql(sql, query => mode === 'delayed-read'
			? query.startsWith('select') && query.includes('fantasy_week >')
			: query.startsWith('with eligible as materialized'), mode);
		expect(await recordApprovedReport(report, token, delayed.sql)).toBe(false);
		expect(delayed.hits()).toBe(1);
		expect((await state()).generation.current.phase).toBe('editorial');
		await unpublished();
	});

	test('expiry during history insertion rolls back the tentative history and leaves publication fields absent', async () => {
		const ref = await claim();
		await reviewed(ref);
		await sql.unsafe(`CREATE FUNCTION history_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$`);
		await sql.unsafe(`CREATE TRIGGER history_delay BEFORE INSERT ON fantasy_recap_generations FOR EACH ROW EXECUTE FUNCTION history_delay()`);
		try {
			const meta = (await state()).generation;
			const deadline = new Date(Date.now() + 250).toISOString();
			meta.current.editorialDeadlineAtUtc = deadline;
			for (const call of meta.current.calls) call.deadlineAtUtc = deadline;
			await sql`UPDATE fantasy_recap_runs SET editorial_attempt = ${parseGenerationState(meta)}`;
			expect(await recordApprovedReport(report, token, sql)).toBe(false);
			expect((await state()).generation.current.phase).toBe('editorial');
			await unpublished();
		} finally {
			await sql.unsafe('DROP TRIGGER history_delay ON fantasy_recap_generations');
			await sql.unsafe('DROP FUNCTION history_delay()');
		}
	});

	test('remaining work shortens both editorial and call deadlines instead of refreshing the budget', async () => {
		const ref = await claim();
		await ageAttempts(39 * 60_000);
		expect(await captureGenerationPacket(ref, token, packet, sql)).toBe(true);
		const call = await reserveGenerationCall(ref, token, 'writer', 1, sql);
		expect(call).not.toBeNull();
		expect(call!.remainingMs).toBeGreaterThan(0);
		expect(call!.remainingMs).toBeLessThanOrEqual(60_000);
		const meta = (await state()).generation.current;
		expect(meta.editorialDeadlineAtUtc).toBe(meta.workDeadlineAtUtc);
		expect(meta.calls[0]!.deadlineAtUtc).toBe(meta.workDeadlineAtUtc);
	});

	test.each(['work', 'editorial'] as const)('expired %s deadline cannot authorize another call despite a live lease', async (deadline) => {
		const ref = await claim();
		if (deadline === 'editorial')
			await writer(ref);
		await ageAttempts((deadline === 'work' ? 41 : 31) * 60_000);
		const before = await snapshot();
		expect((await state()).leaseCurrent).toBe(true);
		expect(await reserveGenerationCall(ref, token, deadline === 'work' ? 'nfl' : 'writer', deadline === 'work' ? 1 : 2, sql)).toBeNull();
		expect(await snapshot()).toEqual(before);
	});

	test('positive cheap source failure permits automatic reclaim and keeps prior payload', async () => {
		const old = await claim();
		expect(await captureGenerationPacket(old, token, packet, sql)).toBe(true);
		expect(await blockGenerationAttempt(old, token, 'source_unavailable', sql, true)).toBe(true);
		const prior = (await state()).generation.current;
		const next = await claim('automatic-retry');
		expect(next.attemptId).not.toBe(old.attemptId);
		expect((await state()).generation.prior).toEqual([prior]);
		expect((await readGenerationDebug(old, sql))!.bundle.packetJson).toBe(JSON.stringify(packet));
		expect((await state()).generation.current.paidWorkAtUtc).toBeNull();
	});

	test('paid work cannot become source-retryable; a blocked paid attempt needs an exact one-use restart selector', async () => {
		const old = await claim();
		await writer(old);
		const before = await snapshot();
		expect(await blockGenerationAttempt(old, token, 'source_unavailable', sql, true)).toBe(false);
		expect(await snapshot()).toEqual(before);
		expect(await blockGenerationAttempt(old, token, 'writer_failed', sql)).toBe(true);
		expect(await claimGenerationAttempt(scope, window, 'automatic', null, sql)).toBeNull();
		expect(await claimGenerationAttempt(scope, window, 'wrong-selector', null, sql, randomUUID())).toBeNull();
		const oldDebug = await readGenerationDebug(old, sql);
		const next = await claim('manual-restart', old.attemptId);
		expect(next.attemptId).not.toBe(old.attemptId);
		expect(await readGenerationDebug(old, sql)).toEqual(oldDebug);
		expect(await claimGenerationAttempt(scope, window, 'reuse-selector', null, sql, old.attemptId)).toBeNull();
		expect(await blockGenerationAttempt(next, 'manual-restart', 'second_block', sql)).toBe(true);
		expect(await claimGenerationAttempt(scope, window, 'old-selector-again', null, sql, old.attemptId)).toBeNull();
		expect((await claim('next-manual', next.attemptId)).attemptId).not.toBe(next.attemptId);
		await unpublished();
	});

	test('packet bytes retain property order through JSONB and identical capture is idempotent', async () => {
		const ref = await claim();
		expect(await captureGenerationPacket(ref, token, packet, sql)).toBe(true);
		const before = await snapshot();
		expect(await captureGenerationPacket(ref, token, packet, sql)).toBe(true);
		expect(await snapshot()).toEqual(before);
		const debug = await readGenerationDebug(ref, sql);
		expect(debug!.bundle.packetJson).toBe(JSON.stringify(packet));
		expect(debug!.attempt.evidenceId).toBe(packet.id);
		expect(await captureGenerationPacket(ref, token, structuredClone(packet), sql)).toBe(false);
	});

	test.each(['group', 'week', 'window', 'digest', 'proof', 'proof-absent'] as const)('captured packet with mismatched %s cannot create evidence authority', async (change) => {
		const ref = await claim();
		const changed = {
			...packet,
			id: '',
			scope: Object.freeze({
				...packet.scope,
				groupId: change === 'group' ? 'different-group' : packet.scope.groupId,
				week: change === 'week' ? packet.scope.week + 1 : packet.scope.week,
				chatWindow: change === 'window'
					? Object.freeze({ ...window, startAtUtc: '2026-08-31T00:00:00.000Z' })
					: packet.scope.chatWindow,
				calendarProof: change === 'proof-absent'
					? undefined
					: change === 'proof'
						? { ...proof, retrievedAtUtc: new Date(Date.parse(proof.retrievedAtUtc) + 1_000).toISOString() }
						: packet.scope.calendarProof,
			}),
		};
		changed.id = change === 'digest'
			? `evidence-${'0'.repeat(64)}`
			: `evidence-${createHash('sha256').update(JSON.stringify(changed)).digest('hex')}`;
		const before = await snapshot();
		expect(await captureGenerationPacket(ref, token, Object.freeze(changed), sql).catch(() => false)).toBe(false);
		expect(await snapshot()).toEqual(before);
	});

	test.each(['wrong-token', 'expired', 'replaced', 'old-attempt'] as const)('%s cannot reserve work, capture packet, block, or approve', async (change) => {
		const ref = await claim();
		let owner = token;
		let selected = ref;
		if (change === 'wrong-token')
			owner = 'wrong-token';
		if (change === 'expired')
			await expireLease();
		if (change === 'replaced')
			await sql`UPDATE fantasy_recap_runs SET claim_token = 'replacement'`;
		if (change === 'old-attempt')
			selected = { ...ref, attemptId: randomUUID() };
		const before = await snapshot();
		expect(await reserveGenerationCall(selected, owner, 'nfl', 1, sql)).toBeNull();
		expect(await captureGenerationPacket(selected, owner, packet, sql)).toBe(false);
		expect(await blockGenerationAttempt(selected, owner, 'stale_owner', sql)).toBe(false);
		expect(await recordApprovedReport(report, owner, sql)).toBe(false);
		expect(await snapshot()).toEqual(before);
	});

	test('recovery blocks an expired interrupted attempt, never automatically resumes paid work', async () => {
		const ref = await claim();
		const call = await reserveGenerationCall(ref, token, 'nfl', 1, sql);
		expect(call).not.toBeNull();
		await expireLease();
		await recoverGenerationAttempt(scope, sql);
		expect(await state()).toMatchObject({ status: 'failed', generation: { current: { phase: 'blocked', reasonCode: 'generation_interrupted', counts: { nfl: 1 } } } });
		const before = await snapshot();
		await recoverGenerationAttempt(scope, sql);
		expect(await snapshot()).toEqual(before);
		expect(await claimGenerationAttempt(scope, window, 'automatic', null, sql)).toBeNull();
		await unpublished();
	});

	test('full native microsecond lease stamp survives reserve, capture, and block CAS', async () => {
		const ref = await claim();
		await sql`UPDATE fantasy_recap_runs SET lease_expires_at = date_trunc('milliseconds', clock_timestamp()) + interval '60.000123 seconds'`;
		const before = await state();
		expect(before.leaseStamp).toMatch(/\d{3}123[+-]/);
		expect(await captureGenerationPacket(ref, token, packet, sql)).toBe(true);
		const call = await reserveGenerationCall(ref, token, 'nfl', 1, sql);
		expect(call).not.toBeNull();
		expect(await blockGenerationAttempt(ref, token, 'fixture_block', sql)).toBe(true);
		expect((await state()).leaseStamp).toBe(before.leaseStamp);
	});

	test.each(['advisory', 'row'] as const)('%s lock wait rechecks the native lease clock after the lock is granted', async (lock) => {
		const ref = await claim();
		const waiter = new SQL(databaseUrl!, { max: 1, connection: { search_path: schema } });
		const [identity] = await waiter`SELECT pg_backend_pid() AS pid`;
		const unlock = deferred();
		const acquired = deferred();
		await sql`UPDATE fantasy_recap_runs SET lease_expires_at = ${new Date(Date.now() + 1_000).toISOString()}`;
		const held = sql.begin(async (tx) => {
			if (lock === 'advisory')
				await tx`SELECT pg_advisory_xact_lock(hashtextextended(${scope.leagueId}, 0))`;
			else
				await tx`SELECT 1 FROM fantasy_recap_runs WHERE league_id = ${scope.leagueId} AND fantasy_week = ${scope.week} FOR UPDATE`;
			acquired.resolve();
			await unlock.promise;
		});
		await acquired.promise;
		let pending: ReturnType<typeof reserveGenerationCall> | undefined;
		try {
			pending = reserveGenerationCall(ref, token, 'nfl', 1, waiter);
			let waiting = false;
			for (let tries = 0; tries < 100; tries++) {
				const rows = await root`SELECT 1 FROM pg_locks WHERE pid = ${identity.pid} AND NOT granted`;
				if (rows.length) {
					waiting = true;
					break;
				}
				await Bun.sleep(10);
			}
			expect(waiting).toBe(true);
			await root`SELECT pg_sleep(1.1)`;
			unlock.resolve();
			await held;
			expect(await pending).toBeNull();
			expect((await state()).generation.current.calls).toEqual([]);
		} finally {
			unlock.resolve();
			await held;
			await pending;
			await waiter.close();
		}
	}, 10_000);

	test('a newer active week blocks older fresh claims and paid reservations', async () => {
		const ref = await claim();
		const newer = { ...scope, week: scope.week + 1 };
		expect(await claimGenerationAttempt(newer, window, 'newer', null, sql)).not.toBeNull();
		const before = await snapshot();
		expect(await reserveGenerationCall(ref, token, 'nfl', 1, sql)).toBeNull();
		expect(await claimGenerationAttempt(scope, window, 'old', null, sql)).toBeNull();
		expect(await snapshot()).toEqual(before);
	});

	test('lost native claim COMMIT acknowledgement leaves durable ownership but no dispatch permission', async () => {
		const lost = faultSql(sql, query => query.includes('insert into fantasy_recap_runs'));
		let dispatches = 0;
		const ref = await claimGenerationAttempt(scope, window, token, null, lost.sql);
		if (ref)
			dispatches++;
		expect(lost.hits()).toBe(1);
		expect(ref).toBeNull();
		expect(dispatches).toBe(0);
		expect((await state()).generation.current.calls).toEqual([]);
		expect(await claimGenerationAttempt(scope, window, token, null, sql)).toBeNull();
	});

	test('intent write failure before commit rolls back without consuming budget or paid intent', async () => {
		const ref = await claim();
		const before = await snapshot();
		const failed = faultSql(sql, query => query.startsWith('update fantasy_recap_runs'), 'before');
		expect(await reserveGenerationCall(ref, token, 'nfl', 1, failed.sql)).toBeNull();
		expect(failed.hits()).toBe(1);
		expect(await snapshot()).toEqual(before);
		expect(await reserveGenerationCall(ref, token, 'nfl', 1, sql)).not.toBeNull();
	});

	test('lost native intent COMMIT acknowledgement consumes ordinal without authorizing external dispatch', async () => {
		const ref = await claim();
		const lost = faultSql(sql, query => query.startsWith('update fantasy_recap_runs') && query.includes('editorial_attempt ='));
		let dispatches = 0;
		const call = await reserveGenerationCall(ref, token, 'nfl', 1, lost.sql);
		if (call)
			dispatches++;
		expect(lost.hits()).toBe(1);
		expect(call).toBeNull();
		expect(dispatches).toBe(0);
		const meta = (await state()).generation.current;
		expect(meta.counts.nfl).toBe(1);
		expect(meta.calls).toMatchObject([{ kind: 'nfl', ordinal: 1, state: 'reserved' }]);
		expect(meta.paidWorkAtUtc).not.toBeNull();
		expect(await reserveGenerationCall(ref, token, 'nfl', 1, sql)).toBeNull();
		expect(await reserveGenerationCall(ref, token, 'nfl', 2, sql)).toBeNull();
	});

	test.each(['none', 'packet', 'writer', 'failed-review', 'wrong-candidate', 'wrong-evidence'] as const)('approval rejects %s without captured matching writer and pass review; no final text or history', async (stage) => {
		const ref = await claim();
		if (stage === 'packet')
			expect(await captureGenerationPacket(ref, token, packet, sql)).toBe(true);
		if (stage === 'writer')
			await writer(ref);
		if (['failed-review', 'wrong-candidate', 'wrong-evidence'].includes(stage)) {
			const value = structuredClone(review);
			if (stage === 'failed-review') {
				value.verdict = 'fail';
				value.issues = [{ path: 'manager', category: 'grounding', message: 'Fixture review failure', supportIds: ['score:1:1'] }];
			}
			if (stage === 'wrong-candidate')
				value.candidateId = `candidate-${'0'.repeat(64)}`;
			if (stage === 'wrong-evidence')
				value.evidenceId = `evidence-${'0'.repeat(64)}`;
			await reviewed(ref, value);
		}
		const before = await snapshot();
		expect(await recordApprovedReport(report, token, sql)).toBe(false);
		expect(await snapshot()).toEqual(before);
		await unpublished();
	});

	test.each(['before', 'after'] as const)('optional NFL collector cannot swallow %s-commit reservation failure into editorial authority', async (mode) => {
		const ref = await claim();
		const failed = faultSql(sql, query => query.startsWith('update fantasy_recap_runs'), mode);
		const capture = createGenerationCapture(ref, token, failed.sql);
		let nflDispatches = 0;
		const collected = await collectRecapEvidence({ config: editorialFixtureConfig, week: scope.week, window, calendarProof: proof }, {
			now: editorialFixtureNow,
			sleeper: editorialFixtureSleeper,
			memory: {
				getThreadById: async ({ threadId }) => ({
					id: threadId,
					resourceId: threadId,
					createdAt: editorialFixtureNow(),
					updatedAt: editorialFixtureNow(),
				}),
				listMessages: async () => ({ total: 0, page: 0, perPage: 1000, hasMore: false, messages: [] }),
			},
			readNfl: capture.readNfl(async () => {
				nflDispatches++;
				throw new Error('Fixture provider must never be dispatched');
			}),
		});
		expect(failed.hits()).toBe(1);
		expect(nflDispatches).toBe(0);
		expect(collected.admission.canDraft).toBe(true);
		expect(collected.nfl).toMatchObject([{ status: 'unavailable' }]);
		expect(collected.gaps).toContainEqual({ source: 'nfl', code: 'source_unavailable', blocking: false });
		const before = await snapshot();
		expect(() => capture.assertHealthy()).toThrow('generation_capture_unavailable');
		await expect(capture.packet(collected)).rejects.toThrow('generation_capture_unavailable');
		await expect(capture.observer.beforeCall({ kind: 'writer', ordinal: 1 })).rejects.toThrow('generation_capture_unavailable');
		const fixture = editorialFixtureRuntime(() => {
			throw new Error('Fixture model must never be dispatched');
		});
		expect((await createProcedure(fixture.runtime)(collected, undefined, capture.observer)).status).toBe('blocked');
		expect(fixture.calls).toEqual([]);
		expect(fixture.resolved).toEqual([]);
		expect(await snapshot()).toEqual(before);
		const current = (await state()).generation.current;
		expect(current.counts).toEqual({ nfl: mode === 'after' ? 1 : 0, drafts: 0, reviews: 0 });
		expect(current.calls).toHaveLength(mode === 'after' ? 1 : 0);
		expect((await readGenerationDebug(ref, sql))!.bundle.packetJson).toBeNull();
		await unpublished();
	});

	test('healthy capture and actual private Astra fixture procedure persist typed outputs and authorize atomic approval', async () => {
		const ref = await claim();
		const capture = createGenerationCapture(ref, token, sql);
		await capture.packet(packet);
		const fixture = editorialFixtureRuntime(async ({ role, data }) => {
			const current = (await state()).generation.current;
			expect(current.calls.at(-1)).toMatchObject({ kind: role, ordinal: 1, state: 'reserved', settledAtUtc: null });
			expect(current.paidWorkAtUtc).not.toBeNull();
			const debug = await readGenerationDebug(ref, sql);
			expect(debug!.bundle.packetJson).toBe(JSON.stringify(packet));
			expect(debug!.bundle.outputs).toHaveLength(role === 'writer' ? 0 : 1);
			return role === 'writer' ? { case: 'completed', result: draft } : passingEditorialReview(data);
		});
		const outcome = await createProcedure(fixture.runtime)(packet, undefined, capture.observer);
		expect(outcome).toMatchObject({ status: 'approved', counts: { drafts: 1, reviews: 1 } });
		expect(() => capture.assertHealthy()).not.toThrow();
		expect(fixture.calls.map(call => call.role)).toEqual(['writer', 'reviewer']);
		expect(fixture.resolved.length).toBeGreaterThan(0);
		expect(fixture.resolved.every(id => id === 'gpt-6-astra')).toBe(true);
		expect(Object.keys(fixture.runtime.listAgents())).toEqual([]);
		expect(Object.keys(fixture.runtime.listWorkflows())).toEqual([]);
		const debug = await readGenerationDebug(ref, sql);
		expect(debug!.bundle.outputs.map(output => ({
			kind: output.kind,
			ordinal: output.ordinal,
			contributionCase: output.contributionCase,
			value: JSON.parse(output.valueJson!),
		}))).toEqual([
			{ kind: 'writer', ordinal: 1, contributionCase: 'completed', value: draft },
			{ kind: 'reviewer', ordinal: 1, contributionCase: 'completed', value: review },
		]);
		expect(debug!.attempt.calls.map(call => call.state)).toEqual(['completed', 'completed']);
		const approved = buildSavedReport(packet, outcome);
		expect(approved).toEqual(report);
		expect(await recordApprovedReport(approved, token, sql)).toBe(true);
		const saved = await snapshot();
		expect(saved.history).toHaveLength(1);
		expect(saved.history[0].row.facts).toEqual({ version: approved.version, report: approved });
		expect(saved.runs[0].row.editorial_attempt.current).toMatchObject({ phase: 'approved', reportId: approved.id });
		expect(saved.runs[0].row.final_text).toBe(approved.parts.join('\n\n'));
	});

	test('writer/reviewer values are direct typed outputs, not SDK handback wrappers or arbitrary errors', async () => {
		const ref = await claim();
		expect(await captureGenerationPacket(ref, token, packet, sql)).toBe(true);
		const call = await reserveGenerationCall(ref, token, 'writer', 1, sql);
		expect(call).not.toBeNull();
		const before = await snapshot();
		expect(await recordGenerationOutput(ref, call!.id, 'completed', { status: 'completed', value: draft }, sql)).toBe(false);
		expect(await recordGenerationOutput(ref, call!.id, 'failed', { message: 'raw SDK error', stack: 'private-stack' }, sql)).toBe(false);
		expect(await snapshot()).toEqual(before);
		expect(await recordGenerationOutput(ref, call!.id, 'completed', draft, sql)).toBe(true);
		const accepted = await snapshot();
		expect(await recordGenerationOutput(ref, call!.id, 'completed', draft, sql)).toBe(true);
		expect(await snapshot()).toEqual(accepted);
		expect(await recordGenerationOutput(ref, call!.id, 'failed', null, sql)).toBe(false);
	});

	test('approval atomically saves exact bytes, current approved phase, and one matching history row', async () => {
		await save();
		const saved = await snapshot();
		expect(saved.history).toHaveLength(1);
		expect(saved.history[0].row).toMatchObject({ final_text: report.parts.join('\n\n'), generator_version: report.version, facts: { version: report.version, report } });
		expect(saved.runs[0].row).toMatchObject({ final_text: report.parts.join('\n\n'), saved_report: report, editorial_attempt: { current: { phase: 'approved', reportId: report.id } } });
		expect(saved.runs[0].row.final_text).toContain(editorialFixtureQuote);
		expect(await recordApprovedReport(report, token, sql)).toBe(true);
		expect((await snapshot()).history).toEqual(saved.history);
		expect((await state()).generation).toEqual(saved.runs[0].row.editorial_attempt);
	});

	test('native approval acknowledgement loss reconciles a single atomic save without rewriting payloads', async () => {
		const ref = await claim();
		await reviewed(ref);
		const lost = faultSql(sql, query => query.includes('insert into fantasy_recap_generations'));
		expect(await recordApprovedReport(report, token, lost.sql)).toBe(true);
		expect(lost.hits()).toBe(1);
		const saved = await snapshot();
		expect(saved.history).toHaveLength(1);
		expect(saved.runs[0].row.editorial_attempt.current.phase).toBe('approved');
		expect(await recordApprovedReport(report, token, sql)).toBe(true);
		expect((await snapshot()).history).toEqual(saved.history);
	});

	test('server-side report write failure rolls back approval metadata and history together', async () => {
		const ref = await claim();
		await reviewed(ref);
		const before = await snapshot();
		await sql.unsafe(`CREATE FUNCTION reject_generation_save() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'fixture_generation_write_rejected'; END $$`);
		await sql.unsafe(`CREATE TRIGGER reject_generation_save BEFORE UPDATE ON fantasy_recap_runs
			FOR EACH ROW WHEN (NEW.saved_report IS NOT NULL) EXECUTE FUNCTION reject_generation_save()`);
		try {
			expect(await recordApprovedReport(report, token, sql)).toBe(false);
			expect(await snapshot()).toEqual(before);
		} finally {
			await sql.unsafe('DROP TRIGGER reject_generation_save ON fantasy_recap_runs');
			await sql.unsafe('DROP FUNCTION reject_generation_save()');
		}
	});

	test.each(['expired', 'replaced', 'newer'] as const)('fully reviewed %s owner cannot publish', async (change) => {
		const ref = await claim();
		await reviewed(ref);
		if (change === 'expired')
			await expireLease();
		if (change === 'replaced')
			await sql`UPDATE fantasy_recap_runs SET claim_token = 'replacement'`;
		if (change === 'newer')
			expect(await claimGenerationAttempt({ ...scope, week: scope.week + 1 }, window, 'newer', null, sql)).not.toBeNull();
		const before = await snapshot();
		expect(await recordApprovedReport(report, token, sql)).toBe(false);
		expect(await snapshot()).toEqual(before);
		await unpublished();
	});

	test('untagged v1 approval still preserves exact legacy bytes and history', async () => {
		const claimed = await claimRun(scope.leagueId, scope.week, token, new Date(Date.now() + 60_000), null, sql);
		expect(claimed.claimed).toBe(true);
		expect(await recordApprovedReport(report, token, sql)).toBe(true);
		const saved = await snapshot();
		expect(saved.runs[0].row.editorial_attempt).toBeNull();
		expect(saved.runs[0].row.final_text).toBe(report.parts.join('\n\n'));
		expect(saved.runs[0].row.final_text).toContain(editorialFixtureQuote);
		expect(saved.runs[0].row.final_text).not.toBe(saved.runs[0].row.final_text.normalize('NFC'));
		expect(saved.history[0].row.facts).toEqual({ version: report.version, report });
		expect(await recordApprovedReport(report, token, sql)).toBe(true);
		expect((await snapshot()).history).toEqual(saved.history);
	});

	for (const tag of ['valid', 'unknown'] as const) {
		test.each(['claim-live', 'claim-failed', 'attempt-text', 'sent', 'failed', 'unknown', 'confirm', 'sweep', 'claimed-history', 'preview-history'] as const)(`${tag} nonnull generation tag fences legacy %s`, async (operation) => {
			await claim();
			if (tag === 'unknown')
				await sql`UPDATE fantasy_recap_runs SET editorial_attempt = ${{ version: 'unknown-generation-version' }}`;
			if (operation === 'claim-failed')
				await sql`UPDATE fantasy_recap_runs SET status = 'failed'`;
			if (operation === 'confirm')
				await sql`UPDATE fantasy_recap_runs SET status = 'delivery_unknown'`;
			if (operation === 'sweep')
				await expireLease();
			const before = await snapshot();
			switch (operation) {
				case 'claim-live':
				case 'claim-failed': {
					const lease = new Date(Date.now() + 60_000);
					const claimed = await claimRun(scope.leagueId, scope.week, token, lease, null, sql);
					expect(claimed.claimed).toBe(false);
					break;
				}
				case 'attempt-text':
					expect(await recordAttemptText(scope.leagueId, scope.week, token, 'unapproved bytes', sql)).toBe(false);
					break;
				case 'sent':
					expect(await markSent(scope.leagueId, scope.week, token, 'not-a-real-handle', sql)).toBe(false);
					break;
				case 'failed':
					expect(await markFailed(scope.leagueId, scope.week, token, 'legacy failure', 'model', 'execution_failed', sql)).toBe(false);
					break;
				case 'unknown':
					await markDeliveryUnknown(scope.leagueId, scope.week, token, 'legacy unknown', sql);
					break;
				case 'confirm':
					expect(await confirmSentByOperator(scope.leagueId, scope.week, sql)).toBe(false);
					break;
				case 'sweep':
					expect(await expireStaleLeases(scope.leagueId, new Date(), 'legacy sweep', sql)).toEqual([]);
					break;
				case 'claimed-history':
					expect(await recordClaimedGeneration(legacyRecord(), token, sql)).toBe(false);
					break;
				case 'preview-history':
					await recordGeneration(legacyRecord(), sql);
					break;
			}
			expect(await snapshot()).toEqual(before);
		});
	}

	test('late old writer output survives a restart only as diagnostics, without changing the new owner', async () => {
		const old = await claim();
		expect(await captureGenerationPacket(old, token, packet, sql)).toBe(true);
		const call = await reserveGenerationCall(old, token, 'writer', 1, sql);
		expect(call).not.toBeNull();
		expect(await blockGenerationAttempt(old, token, 'writer_interrupted', sql)).toBe(true);
		const next = await claim('new-owner', old.attemptId);
		const before = await state();
		expect(await recordGenerationOutput(old, call!.id, 'completed', draft, sql)).toBe(true);
		const after = await state();
		expect(after.generation.current).toEqual(before.generation.current);
		expect(after).toMatchObject({
			claimToken: 'new-owner',
			leaseStamp: before.leaseStamp,
			status: 'started',
			publicationExists: false,
		});
		const debug = await readGenerationDebug(old, sql);
		expect(debug!.bundle.outputs).toMatchObject([{ callId: call!.id, valueJson: JSON.stringify(draft) }]);
		expect(await reserveGenerationCall(old, token, 'reviewer', 1, sql)).toBeNull();
		expect(await markGenerationNotified(old, sql)).toBe(false);
		expect(await recordApprovedReport(report, 'new-owner', sql)).toBe(false);
		const found = await findGenerationReference(scope.leagueId, scope.week, scope.groupId, next.attemptId, sql);
		expect(found).toEqual(next);
		await unpublished();
	});

	test('debug and mutation selectors deny wrong group, week, season, league, and attempt without writes', async () => {
		const ref = await claim();
		const call = await writer(ref);
		const before = await snapshot();
		for (const change of [{ groupId: 'wrong' }, { week: scope.week + 1 }, { season: scope.season + 1 }, { leagueId: 'wrong' }, { attemptId: randomUUID() }]) {
			const wrong = { ...ref, ...change };
			expect(await readGenerationDebug(wrong, sql).catch(() => null)).toBeNull();
			expect(await reserveGenerationCall(wrong, token, 'nfl', 1, sql)).toBeNull();
			expect(await captureGenerationPacket(wrong, token, packet, sql).catch(() => false)).toBe(false);
			expect(await recordGenerationOutput(wrong, call.id, 'completed', draft, sql)).toBe(false);
			expect(await markGenerationNotified(wrong, sql).catch(() => false)).toBe(false);
		}
		for (const change of [
			{ groupId: 'wrong' },
			{ week: scope.week + 1 },
			{ leagueId: 'wrong' },
			{ attemptId: randomUUID() },
		]) {
			const wrong = { ...ref, ...change };
			const { leagueId, week, groupId, attemptId } = wrong;
			const found = await findGenerationReference(leagueId, week, groupId, attemptId, sql);
			expect(found).toBeNull();
		}
		expect(await snapshot()).toEqual(before);
	});

	test('notification marker is one-shot even across concurrent callers', async () => {
		const ref = await claim();
		expect(await blockGenerationAttempt(ref, token, 'fixture_block', sql)).toBe(true);
		const results = await Promise.all([markGenerationNotified(ref, sql), markGenerationNotified(ref, sql)]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect((await state()).generation.current.notifiedAtUtc).not.toBeNull();
		const before = await snapshot();
		expect(await markGenerationNotified(ref, sql)).toBe(false);
		expect(await snapshot()).toEqual(before);
	});

	test('30-day retention removes only private payload; sent report, history, and attempt audit stay intact', async () => {
		const ref = await save();
		const savedRef = { ...scope, reportId: report.id };
		const operation = await reserveSavedReportDelivery(savedRef, token, sql);
		expect(operation).not.toBeNull();
		const part = await beginSavedReportPart(savedRef, token, operation!, sql);
		expect(part).not.toBeNull();
		// Fixture receipt only: no transport, SDK sender, or outbound request exists.
		expect(await recordSavedReportPart(savedRef, part!.part, part!.attemptId, { kind: 'sent', handle: 'fixture-receipt' }, sql)).toBe(true);
		expect((await getSavedReportState(savedRef, sql))!.status).toBe('sent');
		await ageAttempts(29 * 24 * 60 * 60_000);
		expect(await purgeGenerationDebug(sql)).toBe(0);
		expect(await readGenerationDebug(ref, sql)).not.toBeNull();
		await ageAttempts(2 * 24 * 60 * 60_000);
		const before = await snapshot();
		expect(await readGenerationDebug(ref, sql)).toBeNull();
		expect(await purgeGenerationDebug(sql)).toBe(1);
		const after = await snapshot();
		expect(after.history).toEqual(before.history);
		const expected = structuredClone(before);
		expected.runs[0].row.editorial_attempt.debug = {};
		expect(after).toEqual(expected);
		expect((await state()).generation.current.window).toEqual(window);
		expect((await state()).generation.current.calendarProof).toEqual(proof);
		expect(await purgeGenerationDebug(sql)).toBe(0);
		const found = await findGenerationReference(scope.leagueId, scope.week, scope.groupId, ref.attemptId, sql);
		expect(found).toEqual(ref);
	});

	test('expired debug reads fail closed before purge, and late output cannot resurrect the payload afterward', async () => {
		const ref = await claim();
		expect(await captureGenerationPacket(ref, token, packet, sql)).toBe(true);
		const call = await reserveGenerationCall(ref, token, 'writer', 1, sql);
		expect(call).not.toBeNull();
		expect(await blockGenerationAttempt(ref, token, 'writer_interrupted', sql)).toBe(true);
		await ageAttempts(31 * 24 * 60 * 60_000);
		expect(await readGenerationDebug(ref, sql)).toBeNull();
		expect(await recordGenerationOutput(ref, call!.id, 'completed', draft, sql)).toBe(false);
		expect(await purgeGenerationDebug(sql)).toBe(1);
		const before = await snapshot();
		expect(await recordGenerationOutput(ref, call!.id, 'completed', draft, sql)).toBe(false);
		expect(await captureGenerationPacket(ref, token, packet, sql)).toBe(false);
		expect(await snapshot()).toEqual(before);
		await unpublished();
	});

	test('purge re-reads after its initial scan, retaining a newly captured attempt while removing expired prior payload', async () => {
		const old = await claim();
		await writer(old);
		expect(await blockGenerationAttempt(old, token, 'writer_failed', sql)).toBe(true);
		await ageAttempts(31 * 24 * 60 * 60_000);
		const scanned = deferred();
		const resume = deferred();
		const scanSql: SqlLike = async (strings, ...values) => {
			const rows = await sql(strings, ...values);
			if (normalized(strings).startsWith('select league_id, fantasy_week, editorial_attempt')) {
				scanned.resolve();
				await resume.promise;
			}
			return rows;
		};
		Object.assign(scanSql, { begin: <T>(action: (tx: SqlLike) => Promise<T>) => sql.begin(action) });
		const purging = purgeGenerationDebug(scanSql);
		await scanned.promise;
		try {
			const next = await claim('new-capture', old.attemptId);
			expect(await captureGenerationPacket(next, 'new-capture', packet, sql)).toBe(true);
			const before = await state();
			resume.resolve();
			expect(await purging).toBe(1);
			const after = await state();
			expect(after.generation.current).toEqual(before.generation.current);
			expect(after.generation.prior).toEqual(before.generation.prior);
			expect(after.claimToken).toBe('new-capture');
			expect(after.leaseStamp).toBe(before.leaseStamp);
			expect(after.generation.debug[old.attemptId]).toBeUndefined();
			expect((await readGenerationDebug(next, sql))!.bundle.packetJson).toBe(JSON.stringify(packet));
			expect(await readGenerationDebug(old, sql)).toBeNull();
		} finally {
			resume.resolve();
			await purging;
		}
	});
});
