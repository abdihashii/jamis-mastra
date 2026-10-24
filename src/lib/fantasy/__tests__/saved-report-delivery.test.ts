import type { SendOutcome } from '../deliver';
import type { RecapGenerationRecord, SqlLike } from '../recaps';
import type { SavedReportProgress, SavedReportReference } from '../runs';
import type { SavedReport } from '../saved-report';
import { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runEditorialLoop } from '../editorial-loop';
import { ensureFantasyRecapsTable, recordApprovedReport, recordClaimedGeneration, recordGeneration } from '../recaps';
import {
	beginSavedReportPart,
	claimRun,
	claimSavedReportRetry,
	confirmSavedReportPart,
	confirmSentByOperator,
	createRunsStore,
	ensureFantasyRunsTable,
	expireStaleLeases,
	getSavedReportState,
	markDeliveryUnknown,
	markFailed,
	markSent,
	pauseSavedReportDelivery,
	recordAttemptText,
	recordSavedReportPart,
	recoverSavedReport,
	reserveSavedReportDelivery,
	savedPartStatus,
} from '../runs';
import { buildSavedReport, parseSavedReport } from '../saved-report';
import { dispatchSavedReport } from '../saved-report-delivery';
import { editorialFixtureQuote, frozenEditorialFixture, validEditorialDraft } from './fixtures/editorial.fixture';

const expires = () => new Date(Date.now() + 60_000);
const reference = (report: SavedReport): SavedReportReference => ({ ...report.scope, reportId: report.id });
const accepted = (handle = 'fixture-handle'): SendOutcome => ({ kind: 'sent', handle });
const uncertain: SendOutcome = { kind: 'unknown', error: 'fixture transport lost acknowledgement' };
const rejected: SendOutcome = { kind: 'failed', error: 'sendblue HTTP 400' };

async function reportFixture(multipart: boolean): Promise<SavedReport> {
	const packet = await frozenEditorialFixture();
	const draft = validEditorialDraft(packet);
	if (multipart) {
		draft.stories = ['First', 'Second', 'Third'].map(angle => ({
			headline: `${angle} perspective`,
			body: `${angle} story. `.repeat(900),
			supportIds: ['score:1:1'],
		}));
	}
	const outcome = await runEditorialLoop(packet, {
		write: async () => draft,
		review: async (assignment) => {
			const { candidate } = JSON.parse(assignment);
			return { evidenceId: packet.id, candidateId: candidate.id, verdict: 'pass', issues: [] };
		},
	});
	expect(outcome.status).toBe('approved');
	const report = buildSavedReport(packet, outcome);
	expect(report.parts).toHaveLength(multipart ? 3 : 1);
	return report;
}

type TransactionalSql = SqlLike & { begin: <T>(action: (sql: SqlLike) => Promise<T>) => Promise<T> };
type QueryMatch = (query: string, values: unknown[]) => boolean;

// Lose the acknowledgement AFTER COMMIT, not inside a transaction that would roll back the marker.
function faultSql(
	base: SqlLike,
	matches: QueryMatch,
	mode: 'after' | 'before' = 'after',
	afterCommit?: (query: string, values: unknown[]) => Promise<void>,
) {
	let hits = 0;
	let committedFault = false;
	const wrap = (client: SqlLike, transaction: boolean): SqlLike => {
		const tagged: SqlLike = async (strings, ...values) => {
			const match = hits === 0 && matches(strings.join(' ').replace(/\s+/g, ' ').trim().toLowerCase(), values);
			if (match) {
				hits++;
				if (mode === 'before')
					throw new Error('fixture SQL failure before write');
			}
			const result = await client(strings, ...values);
			if (!transaction && afterCommit)
				await afterCommit(strings.join(' ').replace(/\s+/g, ' ').trim().toLowerCase(), values);
			if (match) {
				if (!transaction)
					throw new Error('fixture SQL acknowledgement lost');
				committedFault = true;
			}
			return result;
		};
		if ('begin' in client && typeof client.begin === 'function') {
			Object.assign(tagged, {
				begin: async <T>(action: (sql: SqlLike) => Promise<T>): Promise<T> => {
					const result = await (client as TransactionalSql).begin(tx => action(wrap(tx, true)));
					if (committedFault) {
						committedFault = false;
						throw new Error('fixture SQL acknowledgement lost after commit');
					}
					return result;
				},
			});
		}
		return tagged;
	};
	return { sql: wrap(base, false), hits: () => hits };
}

function progressWrite(state: 'sending' | 'accepted' | 'reserved' | 'failed'): QueryMatch {
	return (query, values) => {
		if (!query.includes('update fantasy_recap_runs set part_delivery ='))
			return false;
		const progress = values[0] as SavedReportProgress;
		return state === 'reserved'
			? progress.operationId !== null && progress.parts.every(attempts => attempts.length === 0)
			: progress.parts.some(attempts => attempts.some(attempt => attempt.state === state));
	};
}

// Never fall back to DATABASE_URL or a non-disposable target. A configured fixture MUST work.
const databaseUrl = process.env.JAMIS_TEST_DATABASE_URL;
if (databaseUrl) {
	const url = new URL(databaseUrl);
	if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)
		|| url.pathname !== '/jamis_sessions_test' || url.search) {
		throw new Error('Disposable loopback jamis_sessions_test URL required');
	}
	const probe = new SQL(databaseUrl, { connectionTimeout: 1 });
	try {
		await probe`SELECT 1`;
	} finally {
		await probe.close();
	}
}

describe.skipIf(!databaseUrl)('saved-report native PG delivery gates (mock sender, off live path)', () => {
	const schema = `saved_delivery_${randomUUID().replaceAll('-', '')}`;
	let root: SQL;
	let sql: SQL;
	let one: SavedReport;
	let three: SavedReport;
	let fetchGuard: ReturnType<typeof spyOn>;
	const token = 'fixture-first-claim';

	beforeAll(async () => {
		root = new SQL(databaseUrl!);
		await root.unsafe(`CREATE SCHEMA "${schema}"`);
		sql = new SQL(databaseUrl!, { connection: { search_path: schema } });
		await ensureFantasyRunsTable(sql);
		await ensureFantasyRecapsTable(sql);
		[one, three] = await Promise.all([reportFixture(false), reportFixture(true)]);
	}, 30_000);
	beforeEach(async () => {
		fetchGuard = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => {
			throw new Error('External network forbidden in saved-report fixture');
		}, { preconnect: () => { throw new Error('External preconnect forbidden in saved-report fixture'); } }));
		await sql`TRUNCATE fantasy_recap_runs, fantasy_recap_generations`;
	});
	afterEach(() => {
		try {
			expect(fetchGuard).not.toHaveBeenCalled();
		} finally {
			fetchGuard.mockRestore();
		}
	});
	afterAll(async () => {
		await sql?.close();
		if (root) {
			await root.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
			await root.close();
		}
	});

	async function claim(report = three, claimToken = token) {
		const result = await claimRun(report.scope.leagueId, report.scope.week, claimToken, expires(), null, sql);
		expect(result.claimed).toBe(true);
	}
	async function save(report = three) {
		await claim(report);
		expect(await recordApprovedReport(report, token, sql)).toBe(true);
		return reference(report);
	}
	async function state(ref = reference(three)) {
		const value = await getSavedReportState(ref, sql);
		expect(value).not.toBeNull();
		return value!;
	}
	async function expire(ref = reference(three)) {
		await sql`
			UPDATE fantasy_recap_runs
			SET
				lease_expires_at = ${new Date(Date.now() - 1_000).toISOString()}
			WHERE
				league_id = ${ref.leagueId}
				AND fantasy_week = ${ref.week}
		`;
	}
	async function snapshot() {
		return {
			runs: [...await sql`SELECT to_jsonb(r) AS row FROM fantasy_recap_runs r ORDER BY league_id, fantasy_week`],
			history: [...await sql`SELECT to_jsonb(g) AS row FROM fantasy_recap_generations g ORDER BY league_id, fantasy_week, generator_version, model`],
		};
	}
	function sender(outcomes: SendOutcome[] = [], report = three) {
		const calls: Array<{ groupId: string; text: string }> = [];
		return {
			calls,
			send: async (groupId: string, text: string): Promise<SendOutcome> => {
				const saved = await state(reference(report));
				const index = saved.progress.parts.findIndex(attempts => savedPartStatus(attempts) === 'sending');
				expect(index).toBeGreaterThanOrEqual(0);
				expect(saved.report).toEqual(report);
				expect(groupId).toBe(report.scope.groupId);
				expect(Buffer.from(text)).toEqual(Buffer.from(report.parts[index]!));
				expect(saved.progress.parts[index]!.at(-1)).toMatchObject({
					claimToken: saved.claimToken,
					operationId: saved.progress.operationId,
					state: 'sending',
				});
				expect(saved.sendAttemptAt).not.toBeNull();
				const [history] = await sql`SELECT generator_version, facts FROM fantasy_recap_generations`;
				expect(history).toEqual({
					generator_version: report.version,
					facts: { version: report.version, report },
				});
				calls.push({ groupId, text }); // This line represents entering the SDK, after durable snapshots.
				return outcomes[calls.length - 1] ?? accepted(`fixture-handle-${calls.length}`);
			},
		};
	}
	async function stoppedAtSecond() {
		const ref = await save();
		const transport = sender([accepted('first'), uncertain]);
		const result = await dispatchSavedReport(ref, token, sql, transport.send);
		expect(result).toMatchObject({ status: 'delivery_unknown', reportId: three.id, acceptedParts: 1, totalParts: 3 });
		expect(transport.calls.map(call => call.text)).toEqual(three.parts.slice(0, 2));
		const current = await state(ref);
		expect(current.progress.parts.map(savedPartStatus)).toEqual(['accepted', 'unknown', 'pending']);
		return { ref, transport, attempt: current.progress.parts[1]!.at(-1)! };
	}

	test('save is immutable and idempotent, with exactly one matching generation-history row', async () => {
		const ref = await save(one);
		const before = await snapshot();
		expect(await recordApprovedReport(one, token, sql)).toBe(true);
		const repeated = await snapshot();
		expect(repeated.history).toEqual(before.history);
		// A repeated save may refresh the audit timestamp, never artifact, progress, claim or history.
		expect(repeated.runs[0].row).toEqual({ ...before.runs[0].row, updated_at: repeated.runs[0].row.updated_at });
		expect(await recordApprovedReport(three, token, sql)).toBe(false);
		expect(await snapshot()).toEqual(repeated);
		expect((await state(ref)).report).toEqual(one);
		expect(before.history).toHaveLength(1);
		expect(before.history[0].row).toMatchObject({
			generator_version: one.version,
			facts: { version: one.version, report: one },
		});
	});

	test('historical editorial-v1 delivery preserves reviewed basis labels and exact bytes', async () => {
		const report = parseSavedReport(JSON.parse(await readFile(new URL('./fixtures/saved-report-editorial-v1.fixture.json', import.meta.url), 'utf8')));
		const ref = await save(report);
		const transport = sender([], report);
		const result = await dispatchSavedReport(ref, token, sql, transport.send);
		expect(result).toMatchObject({ status: 'sent', reportId: report.id, acceptedParts: 1 });
		expect(transport.calls).toEqual([{ groupId: report.scope.groupId, text: report.parts[0] }]);
		expect(transport.calls[0].text).toContain('Basis: weekly performance.');
		expect((await state(ref)).report).toEqual(report);
	});

	test('wrong or expired save claims write neither artifact nor history', async () => {
		await claim();
		expect(await recordApprovedReport(three, 'wrong-token', sql)).toBe(false);
		await expire();
		const before = await snapshot();
		expect(await recordApprovedReport(three, token, sql)).toBe(false);
		expect(await snapshot()).toEqual(before);
		expect(before.runs[0].row.saved_report).toBeNull();
		expect(before.history).toEqual([]);
	});

	test('save/history failure rolls back both writes; committed save acknowledgement loss remains idempotent', async () => {
		await claim();
		const before = await snapshot();
		const historyWrite: QueryMatch = query => query.includes('insert into fantasy_recap_generations');
		const fail = faultSql(sql, historyWrite, 'before');
		await recordApprovedReport(three, token, fail.sql).catch(() => false);
		expect(fail.hits()).toBe(1);
		expect(await snapshot()).toEqual(before);
		const lost = faultSql(sql, historyWrite);
		await recordApprovedReport(three, token, lost.sql).catch(() => false);
		expect(lost.hits()).toBe(1);
		expect((await state()).report).toEqual(three);
		expect(await recordApprovedReport(three, token, sql)).toBe(true);
		expect((await snapshot()).history).toHaveLength(1);
	});

	test('server-side failure after history insert rolls back the entire report save', async () => {
		await claim();
		const before = await snapshot();
		await sql.unsafe(`CREATE FUNCTION reject_report_save() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'fixture_report_write_rejected'; END $$`);
		await sql.unsafe(`CREATE TRIGGER reject_report_save BEFORE UPDATE ON fantasy_recap_runs
			FOR EACH ROW WHEN (NEW.saved_report IS NOT NULL) EXECUTE FUNCTION reject_report_save()`);
		try {
			expect(await recordApprovedReport(three, token, sql)).toBe(false);
			expect(await snapshot()).toEqual(before);
		} finally {
			await sql.unsafe('DROP TRIGGER reject_report_save ON fantasy_recap_runs');
			await sql.unsafe('DROP FUNCTION reject_report_save()');
		}
	});

	test('a conflicting historical artifact cannot leave a new saved report on the run', async () => {
		await claim();
		await sql`
	INSERT INTO
		fantasy_recap_generations (
			league_id,
			fantasy_week,
			generator_version,
			model,
			final_text,
			facts
		)
	VALUES
		(
			${three.scope.leagueId},
			${three.scope.week},
			${three.version},
			${three.writer.model},
			'historical bytes',
			'{}'
		)
`;
		const before = await snapshot();
		expect(await recordApprovedReport(three, token, sql)).toBe(false);
		expect(await snapshot()).toEqual(before);
	});

	test('database-clock leases retain their full precision through dispatch fencing', async () => {
		const ref = await save(one);
		await sql`UPDATE fantasy_recap_runs SET lease_expires_at = date_trunc('milliseconds', now()) + interval '60.000123 seconds'`;
		const transport = sender([], one);
		expect((await dispatchSavedReport(ref, token, sql, transport.send)).status).toBe('sent');
		expect(transport.calls.map(call => call.text)).toEqual(one.parts);
	});

	test('sends all exact ordered bytes only after saved artifact, history and per-part marker are visible', async () => {
		const ref = await save();
		const transport = sender();
		expect(three.parts.join('')).toContain(editorialFixtureQuote);
		expect(three.parts.join('')).not.toBe(three.parts.join('').normalize('NFC'));
		expect(await dispatchSavedReport(ref, token, sql, transport.send)).toMatchObject({
			status: 'sent',
			reportId: three.id,
			acceptedParts: 3,
			totalParts: 3,
		});
		expect(transport.calls.map(call => call.text)).toEqual(three.parts);
		expect((await state()).progress.parts.map(savedPartStatus)).toEqual(['accepted', 'accepted', 'accepted']);
		await dispatchSavedReport(ref, token, sql, transport.send);
		expect(transport.calls).toHaveLength(3);
	});

	test.each(['bytes', 'digest', 'scope', 'version'] as const)('changed persisted %s cannot dispatch', async (change) => {
		const ref = await save();
		const corrupt = structuredClone(three);
		if (change === 'bytes')
			corrupt.parts[0] += ' ';
		if (change === 'digest')
			corrupt.id = `report-${'0'.repeat(64)}`;
		if (change === 'scope')
			corrupt.scope.groupId = 'different-group';
		if (change === 'version')
			Object.assign(corrupt, { version: 'fantasy-saved-report-v999' });
		await sql`UPDATE fantasy_recap_runs SET saved_report = ${corrupt}`;
		const transport = sender();
		expect((await dispatchSavedReport(ref, token, sql, transport.send)).status).toBe('blocked');
		expect(transport.calls).toEqual([]);
	});

	test('every mismatched reference scope field fails closed without sending', async () => {
		const ref = await save();
		const transport = sender();
		for (const change of [
			{ leagueId: 'elsewhere' },
			{ groupId: 'elsewhere' },
			{ season: ref.season + 1 },
			{ week: ref.week + 1 },
			{ reportId: one.id },
		]) {
			expect((await dispatchSavedReport({ ...ref, ...change }, token, sql, transport.send)).status).toBe('blocked');
		}
		expect(transport.calls).toEqual([]);
	});

	test.each(['wrong', 'expired', 'replaced'] as const)('%s claim permits zero SDK attempts', async (kind) => {
		const ref = await save();
		const transport = sender();
		if (kind === 'expired')
			await expire(ref);
		if (kind === 'replaced')
			await sql`UPDATE fantasy_recap_runs SET claim_token = 'replacement-claim'`;
		await dispatchSavedReport(ref, kind === 'wrong' ? 'wrong-token' : token, sql, transport.send);
		expect(transport.calls).toEqual([]);
		expect((await state()).progress.parts.flat()).toEqual([]);
	});

	test('a lease expiring while waiting for the league lock cannot authorize dispatch', async () => {
		const ref = await save();
		const operation = (await reserveSavedReportDelivery(ref, token, sql))!;
		const waiter = new SQL(databaseUrl!, { max: 1, connection: { search_path: schema } });
		const [identity] = await waiter`SELECT pg_backend_pid() AS pid`;
		let unlock!: () => void;
		let locked!: () => void;
		const barrier = new Promise<void>((resolve) => {
			unlock = resolve;
		});
		const acquired = new Promise<void>((resolve) => {
			locked = resolve;
		});
		const held = sql.begin(async (transaction) => {
			await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${ref.leagueId}, 0))`;
			locked();
			await barrier;
		});
		await acquired;
		let pending: ReturnType<typeof beginSavedReportPart> | undefined;
		try {
			await sql`UPDATE fantasy_recap_runs SET lease_expires_at = ${new Date(Date.now() + 1_000).toISOString()}`;
			pending = beginSavedReportPart(ref, token, operation, waiter);
			let waiting = false;
			for (let tries = 0; tries < 50; tries++) {
				const rows = await root`SELECT 1 FROM pg_locks WHERE pid = ${identity.pid} AND locktype = 'advisory' AND NOT granted`;
				if (rows.length) {
					waiting = true;
					break;
				}
				await Bun.sleep(10);
			}
			expect(waiting).toBe(true);
			await root`SELECT pg_sleep(1.1)`;
			unlock();
			await held;
			expect(await pending).toBeNull();
			expect((await state()).progress.parts.flat()).toEqual([]);
		} finally {
			unlock();
			await held;
			await pending;
			await waiter.close();
		}
	});

	test('a row lock released without a tuple change cannot authorize an expired owner', async () => {
		const ref = await save();
		const operation = (await reserveSavedReportDelivery(ref, token, sql))!;
		const waiter = new SQL(databaseUrl!, { max: 1, connection: { search_path: schema } });
		const [identity] = await waiter`SELECT pg_backend_pid() AS pid`;
		let unlock!: () => void;
		let locked!: () => void;
		const barrier = new Promise<void>((resolve) => {
			unlock = resolve;
		});
		const acquired = new Promise<void>((resolve) => {
			locked = resolve;
		});
		await sql`UPDATE fantasy_recap_runs SET lease_expires_at = ${new Date(Date.now() + 1_000).toISOString()}`;
		const held = sql.begin(async (transaction) => {
			await transaction`SELECT 1 FROM fantasy_recap_runs WHERE league_id = ${ref.leagueId} AND fantasy_week = ${ref.week} FOR UPDATE`;
			locked();
			await barrier;
		});
		await acquired;
		let pending: ReturnType<typeof beginSavedReportPart> | undefined;
		try {
			pending = beginSavedReportPart(ref, token, operation, waiter);
			let waiting = false;
			for (let tries = 0; tries < 50; tries++) {
				const rows = await root`SELECT 1 FROM pg_locks WHERE pid = ${identity.pid} AND NOT granted`;
				if (rows.length) {
					waiting = true;
					break;
				}
				await Bun.sleep(10);
			}
			expect(waiting).toBe(true);
			await root`SELECT pg_sleep(1.1)`;
			unlock();
			await held;
			expect(await pending).toBeNull();
			expect((await state()).progress.parts.flat()).toEqual([]);
		} finally {
			unlock();
			await held;
			await pending;
			await waiter.close();
		}
	});

	test('same-claim concurrent drivers reserve one operation and attempt each part only once', async () => {
		const ref = await save();
		const transport = sender();
		const dispatch = () => dispatchSavedReport(ref, token, sql, transport.send);
		const results = await Promise.all(Array.from({ length: 5 }, dispatch));
		expect(results.some(result => result.status === 'sent')).toBe(true);
		expect(transport.calls.map(call => call.text)).toEqual(three.parts);
		const parts = (await state()).progress.parts;
		expect(parts.map(attempts => attempts.length)).toEqual([1, 1, 1]);
		expect(new Set(parts.flat().map(attempt => attempt.operationId)).size).toBe(1);
	});

	test('unknown second part stops the tail; record-only confirmation holds it for explicit manual retry', async () => {
		const { ref, transport, attempt } = await stoppedAtSecond();
		expect(await confirmSavedReportPart(ref, 2, randomUUID(), sql)).toBe(false);
		expect(await confirmSavedReportPart(ref, 1, attempt.id, sql)).toBe(false);
		expect(await confirmSavedReportPart(ref, 2, attempt.id, sql)).toBe(true);
		expect(transport.calls).toHaveLength(2);
		expect((await state()).progress).toMatchObject({ recoveryRequired: true });
		expect((await state()).progress.parts.map(savedPartStatus)).toEqual(['accepted', 'accepted', 'pending']);
		expect(await claimSavedReportRetry(ref, 'auto', expires(), { source: 'automatic' }, sql)).toBe(false);
		await dispatchSavedReport(ref, token, sql, transport.send);
		expect(transport.calls).toHaveLength(2);
		expect(await claimSavedReportRetry(ref, 'manual', expires(), { source: 'operator' }, sql)).toBe(true);
		const tail = sender();
		expect((await dispatchSavedReport(ref, 'manual', sql, tail.send)).status).toBe('sent');
		expect(tail.calls.map(call => call.text)).toEqual([three.parts[2]!]);
		expect((await state()).deliverySource).toBe('operator');
	});

	test('unknown retry requires exact absence attestation and never resends the accepted prefix', async () => {
		const { ref, attempt } = await stoppedAtSecond();
		for (const request of [
			{ source: 'automatic' as const },
			{ source: 'operator' as const },
			{ source: 'operator' as const, absent: { part: 1, attemptId: attempt.id } },
			{ source: 'operator' as const, absent: { part: 2, attemptId: randomUUID() } },
			{ source: 'automatic' as const, absent: { part: 2, attemptId: attempt.id } },
		]) expect(await claimSavedReportRetry(ref, 'retry', expires(), request, sql)).toBe(false);
		expect(await claimSavedReportRetry(ref, 'retry', expires(), { source: 'operator', absent: { part: 2, attemptId: attempt.id } }, sql)).toBe(true);
		const transport = sender();
		expect((await dispatchSavedReport(ref, 'retry', sql, transport.send)).status).toBe('sent');
		expect(transport.calls.map(call => call.text)).toEqual(three.parts.slice(1));
		const current = await state();
		expect(current.report).toEqual(three);
		expect(current.progress.parts[1]).toHaveLength(2);
		expect(current.progress.parts[1]![0]).toMatchObject({ id: attempt.id, state: 'absent', source: 'operator' });
		expect(current.progress.parts[0]).toHaveLength(1);
	});

	test('definitive 4xx rejection is retryable automatically with identical bytes', async () => {
		const ref = await save();
		const first = sender([accepted('first'), rejected]);
		expect((await dispatchSavedReport(ref, token, sql, first.send)).status).toBe('failed');
		expect((await state()).progress.parts.map(savedPartStatus)).toEqual(['accepted', 'failed', 'pending']);
		expect(await claimSavedReportRetry(ref, 'retry', expires(), { source: 'automatic' }, sql)).toBe(true);
		const retry = sender();
		expect((await dispatchSavedReport(ref, 'retry', sql, retry.send)).status).toBe('sent');
		expect(retry.calls.map(call => call.text)).toEqual(three.parts.slice(1));
		expect(retry.calls[0]!.text).toBe(first.calls[1]!.text);
	});

	test('a recreated SQL client recovers expired sending as unknown without losing attempt identities', async () => {
		const ref = await save();
		const operation = await reserveSavedReportDelivery(ref, token, sql);
		expect(operation).not.toBeNull();
		const begun = await beginSavedReportPart(ref, token, operation!, sql);
		expect(begun).not.toBeNull();
		const before = (await state()).progress.parts[0]![0]!;
		await expire(ref);
		const restarted = new SQL(databaseUrl!, { connection: { search_path: schema } });
		try {
			await recoverSavedReport(ref, restarted);
			const recovered = await getSavedReportState(ref, restarted);
			expect(recovered).toMatchObject({ status: 'delivery_unknown', progress: { recoveryRequired: true } });
			expect(recovered!.progress.parts[0]![0]).toMatchObject({ ...before, state: 'unknown' });
			const transport = sender();
			await dispatchSavedReport(ref, token, restarted, transport.send);
			expect(transport.calls).toEqual([]);
		} finally {
			await restarted.close();
		}
	});

	test('late acceptance after expiry is attempt-fenced, upgrades truth, and cannot authorize a tail', async () => {
		const ref = await save();
		const operation = await reserveSavedReportDelivery(ref, token, sql);
		const begun = (await beginSavedReportPart(ref, token, operation!, sql))!;
		await expire(ref);
		await recoverSavedReport(ref, sql);
		expect(await recordSavedReportPart(ref, 1, randomUUID(), accepted(), sql)).toBe(false);
		expect(await recordSavedReportPart(ref, 2, begun.attemptId, accepted(), sql)).toBe(false);
		expect(await recordSavedReportPart(ref, 1, begun.attemptId, accepted('late'), sql)).toBe(true);
		const current = await state();
		expect(current.progress.parts.map(savedPartStatus)).toEqual(['accepted', 'pending', 'pending']);
		expect(current.progress.recoveryRequired).toBe(true);
		expect(await beginSavedReportPart(ref, token, operation!, sql)).toBeNull();
		const transport = sender();
		await dispatchSavedReport(ref, token, sql, transport.send);
		expect(transport.calls).toEqual([]);
		expect(await claimSavedReportRetry(ref, 'auto', expires(), { source: 'automatic' }, sql)).toBe(false);
	});

	test('late acceptance preserves recoverable state when a later part is sending under an expired retry', async () => {
		const ref = await save();
		const firstOperation = (await reserveSavedReportDelivery(ref, token, sql))!;
		const first = (await beginSavedReportPart(ref, token, firstOperation, sql))!;
		await recordSavedReportPart(ref, 1, first.attemptId, { kind: 'unknown' }, sql);
		expect(await claimSavedReportRetry(ref, 'retry', expires(), {
			source: 'operator',
			absent: { part: 1, attemptId: first.attemptId },
		}, sql)).toBe(true);
		const retryOperation = (await reserveSavedReportDelivery(ref, 'retry', sql))!;
		const replacement = (await beginSavedReportPart(ref, 'retry', retryOperation, sql))!;
		await recordSavedReportPart(ref, 1, replacement.attemptId, accepted('replacement'), sql);
		const second = (await beginSavedReportPart(ref, 'retry', retryOperation, sql))!;
		await expire(ref);
		expect(await recordSavedReportPart(ref, 1, first.attemptId, accepted('late-first'), sql)).toBe(true);
		const current = await state();
		expect(current.status).toBe('delivery_unknown');
		expect(current.progress.parts.map(savedPartStatus)).toEqual(['accepted', 'unknown', 'pending']);
		expect(current.progress.recoveryRequired).toBe(true);
		expect(await recordSavedReportPart(ref, 2, second.attemptId, accepted('late-second'), sql)).toBe(true);
		expect((await state()).progress.parts.map(savedPartStatus)).toEqual(['accepted', 'accepted', 'pending']);
		expect(await beginSavedReportPart(ref, 'retry', retryOperation, sql)).toBeNull();
	});

	test('late failure or cancellation cannot downgrade accepted truth', async () => {
		const ref = await save(one);
		const transport = sender([], one);
		await dispatchSavedReport(ref, token, sql, transport.send);
		const current = await state(ref);
		const attempt = current.progress.parts[0]![0]!;
		await recordSavedReportPart(ref, 1, attempt.id, { kind: 'failed' }, sql);
		await recordSavedReportPart(ref, 1, attempt.id, { kind: 'unknown' }, sql);
		await pauseSavedReportDelivery(ref, token, attempt.operationId, sql);
		const controller = new AbortController();
		controller.abort();
		await dispatchSavedReport(ref, token, sql, transport.send, controller.signal);
		expect(await state(ref)).toEqual(current);
		expect(transport.calls).toHaveLength(1);
	});

	test('superseded absent attempt remains attributable but its old operation gains no second tail authority', async () => {
		const { ref, attempt } = await stoppedAtSecond();
		expect(await claimSavedReportRetry(ref, 'retry', expires(), { source: 'operator', absent: { part: 2, attemptId: attempt.id } }, sql)).toBe(true);
		const operation = await reserveSavedReportDelivery(ref, 'retry', sql);
		const replacement = (await beginSavedReportPart(ref, 'retry', operation!, sql))!;
		expect(replacement.part).toBe(2);
		expect(await recordSavedReportPart(ref, 2, attempt.id, accepted('late-original'), sql)).toBe(true);
		expect(await beginSavedReportPart(ref, token, attempt.operationId, sql)).toBeNull();
		await recordSavedReportPart(ref, 2, replacement.attemptId, { kind: 'failed' }, sql);
		const current = await state();
		expect(current.progress.parts[1]).toHaveLength(2);
		expect(current.progress.parts[1]![0]).toMatchObject({ id: attempt.id, state: 'accepted', handle: 'late-original' });
		expect(current.progress.parts[1]![1]).toMatchObject({ id: replacement.attemptId, state: 'failed' });
		expect(savedPartStatus(current.progress.parts[1]!)).toBe('accepted');
		const tail = (await beginSavedReportPart(ref, 'retry', operation!, sql))!;
		expect(tail.part).toBe(3);
		expect(tail.text).toBe(three.parts[2]);
		expect(await beginSavedReportPart(ref, 'retry', operation!, sql)).toBeNull();
		await recordSavedReportPart(ref, 3, tail.attemptId, accepted('tail'), sql);
		expect((await state()).status).toBe('sent');
	});

	test.each(['reserved', 'sending'] as const)('lost %s acknowledgement never enters the sender or retries upstream', async (marker) => {
		const ref = await save();
		const fault = faultSql(sql, progressWrite(marker));
		const transport = sender();
		await dispatchSavedReport(ref, token, fault.sql, transport.send);
		expect(fault.hits()).toBe(1);
		await dispatchSavedReport(ref, token, sql, transport.send);
		expect(transport.calls).toEqual([]);
		const current = await state();
		expect(current.progress.operationId).not.toBeNull();
		expect(current.progress.parts.map(savedPartStatus)).toEqual([marker === 'sending' ? 'unknown' : 'pending', 'pending', 'pending']);
		await expire(ref);
		await recoverSavedReport(ref, sql);
		expect((await state()).status).toBe(marker === 'sending' ? 'delivery_unknown' : 'failed');
	});

	test('lost outcome acknowledgement preserves accepted truth without a second SDK call', async () => {
		const ref = await save(one);
		const fault = faultSql(sql, progressWrite('accepted'));
		const transport = sender([], one);
		await dispatchSavedReport(ref, token, fault.sql, transport.send);
		expect(fault.hits()).toBe(1);
		await dispatchSavedReport(ref, token, sql, transport.send);
		expect(transport.calls.map(call => call.text)).toEqual(one.parts);
		expect((await state(ref)).status).toBe('sent');
		expect((await state(ref)).progress.parts[0]).toHaveLength(1);
	});

	test('cancellation during the marker write records definitely-unsent state and never enters transport', async () => {
		const ref = await save();
		const controller = new AbortController();
		const wrapped = faultSql(sql, (query, values) => {
			if (progressWrite('sending')(query, values))
				controller.abort();
			return false;
		});
		const transport = sender();
		await dispatchSavedReport(ref, token, wrapped.sql, transport.send, controller.signal);
		expect(transport.calls).toEqual([]);
		expect((await state()).progress.parts.map(savedPartStatus)).toEqual(['failed', 'pending', 'pending']);
		expect((await state()).progress.recoveryRequired).toBe(true);
		expect(await claimSavedReportRetry(ref, 'auto', expires(), { source: 'automatic' }, sql)).toBe(false);
	});

	test('pre-dispatch cancellation and the retry hold become visible atomically', async () => {
		const ref = await save();
		const controller = new AbortController();
		const automatic = sender();
		let interleaved = false;
		let automaticClaimed = false;
		const wrapped = faultSql(sql, (query, values) => {
			if (progressWrite('sending')(query, values))
				controller.abort();
			return false;
		}, 'after', async (query, values) => {
			if (!interleaved && progressWrite('failed')(query, values)) {
				interleaved = true;
				automaticClaimed = await claimSavedReportRetry(ref, 'racing-auto', expires(), { source: 'automatic' }, sql);
				if (automaticClaimed)
					await dispatchSavedReport(ref, 'racing-auto', sql, automatic.send);
			}
		});
		const transport = sender();
		await dispatchSavedReport(ref, token, wrapped.sql, transport.send, controller.signal);
		expect(interleaved).toBe(true);
		expect(automaticClaimed).toBe(false);
		expect(transport.calls).toEqual([]);
		expect(automatic.calls).toEqual([]);
		expect((await state()).progress.recoveryRequired).toBe(true);
	});

	test('cancellation before dispatch sends nothing; cancellation after acceptance never sends the pending tail', async () => {
		const ref = await save();
		const controller = new AbortController();
		controller.abort();
		const transport = sender();
		await dispatchSavedReport(ref, token, sql, transport.send, controller.signal);
		expect(transport.calls).toEqual([]);
		// A separate claim is required if the canceled operation reserved this one.
		await expire(ref);
		await recoverSavedReport(ref, sql);
		expect(await claimSavedReportRetry(ref, 'manual', expires(), { source: 'operator' }, sql)).toBe(true);
		const during = new AbortController();
		await dispatchSavedReport(ref, 'manual', sql, async (group, text) => {
			const result = await transport.send(group, text);
			during.abort();
			return result;
		}, during.signal);
		expect(transport.calls.map(call => call.text)).toEqual([three.parts[0]!]);
		expect((await state()).progress.parts.map(savedPartStatus)).toEqual(['accepted', 'pending', 'pending']);
	});

	test('legacy mutation, retry, confirmation, generation and sweep paths cannot bypass new-format state', async () => {
		const ref = await save();
		const legacy = createRunsStore(ref.leagueId, sql);
		const record: RecapGenerationRecord = {
			leagueId: ref.leagueId,
			fantasyWeek: ref.week,
			generatorVersion: three.version,
			model: three.writer.model,
			finalText: 'must not replace report',
			facts: (await frozenEditorialFixture()).facts!,
		};
		const before = await snapshot();
		expect(await recordAttemptText(ref.leagueId, ref.week, token, 'replacement', sql)).toBe(false);
		expect(await markSent(ref.leagueId, ref.week, token, 'legacy-handle', sql)).toBe(false);
		expect(await markFailed(ref.leagueId, ref.week, token, 'legacy', 'model', 'execution_failed', sql)).toBe(false);
		await markDeliveryUnknown(ref.leagueId, ref.week, token, 'legacy', sql);
		for (const generatorVersion of [three.version, 'fixture-legacy-v1']) {
			const legacyRecord = { ...record, generatorVersion };
			expect(await recordClaimedGeneration(legacyRecord, token, sql)).toBe(false);
			await recordGeneration(legacyRecord, sql).catch(() => undefined);
		}
		expect((await claimRun(ref.leagueId, ref.week, 'legacy', expires(), null, sql)).claimed).toBe(false);
		expect(await snapshot()).toEqual(before);
		await expire(ref);
		const expired = await snapshot();
		expect(await expireStaleLeases(ref.leagueId, new Date(), 'legacy sweep', sql)).toEqual([]);
		expect(await snapshot()).toEqual(expired);
		await recoverSavedReport(ref, sql);
		const failed = await snapshot();
		expect(await legacy.claimForRetry(ref.week, 'legacy', expires())).toBeNull();
		expect(await snapshot()).toEqual(failed);
		expect(await claimSavedReportRetry(ref, 'native', expires(), { source: 'operator' }, sql)).toBe(true);
		const transport = sender([uncertain]);
		await dispatchSavedReport(ref, 'native', sql, transport.send);
		const unknown = await snapshot();
		expect(await confirmSentByOperator(ref.leagueId, ref.week, sql)).toBe(false);
		expect(await legacy.claimForRetry(ref.week, 'legacy', expires())).toBeNull();
		expect(await snapshot()).toEqual(unknown);
	});

	test('legacy null/null rows still use the original generation, retry and confirmation lifecycle', async () => {
		await claim(one);
		const { leagueId, week } = one.scope;
		expect(await recordClaimedGeneration({
			leagueId,
			fantasyWeek: week,
			generatorVersion: 'fixture-legacy-v1',
			model: 'fixture-model',
			finalText: 'legacy exact text',
			facts: (await frozenEditorialFixture()).facts!,
		}, token, sql)).toBe(true);
		expect(await markFailed(leagueId, week, token, 'fixture', 'model', 'execution_failed', sql)).toBe(true);
		expect(await createRunsStore(leagueId, sql).claimForRetry(week, 'legacy-retry', expires())).toBe('legacy exact text');
		expect(await recordAttemptText(leagueId, week, 'legacy-retry', 'legacy exact text', sql)).toBe(true);
		await markDeliveryUnknown(leagueId, week, 'legacy-retry', 'fixture timeout', sql);
		expect(await confirmSentByOperator(leagueId, week, sql)).toBe(true);
		expect((await sql`SELECT saved_report, part_delivery FROM fantasy_recap_runs`)[0]).toEqual({ saved_report: null, part_delivery: null });
	});

	test('newer active week blocks both retry claim and already-reserved dispatch', async () => {
		const ref = await save();
		const transport = sender([rejected]);
		await dispatchSavedReport(ref, token, sql, transport.send);
		expect((await claimRun(ref.leagueId, ref.week + 1, 'newer', expires(), null, sql)).claimed).toBe(true);
		expect(await claimSavedReportRetry(ref, 'retry', expires(), { source: 'automatic' }, sql)).toBe(false);
		expect(await claimSavedReportRetry(ref, 'manual', expires(), { source: 'operator' }, sql)).toBe(false);
		await sql`DELETE FROM fantasy_recap_runs WHERE fantasy_week = ${ref.week + 1}`;
		expect(await claimSavedReportRetry(ref, 'retry', expires(), { source: 'automatic' }, sql)).toBe(true);
		const operation = await reserveSavedReportDelivery(ref, 'retry', sql);
		expect(operation).not.toBeNull();
		expect((await claimRun(ref.leagueId, ref.week + 1, 'newer-again', expires(), null, sql)).claimed).toBe(true);
		expect(await beginSavedReportPart(ref, 'retry', operation!, sql)).toBeNull();
		const blocked = sender();
		await dispatchSavedReport(ref, 'retry', sql, blocked.send);
		expect(blocked.calls).toEqual([]);
	});
});
