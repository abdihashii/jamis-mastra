import type { SendOutcome } from '../deliver';
import type { SqlLike } from '../recaps';
import type { SavedReportReference } from '../runs';
import type { SavedReport } from '../saved-report';
import type { SavedReportRecoveryRequest } from '../saved-report-recovery';
import { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { runEditorialLoop } from '../editorial-loop';
import { ensureFantasyRecapsTable, recordApprovedReport } from '../recaps';
import {
	beginSavedReportPart,
	claimRun,
	claimSavedReportRetry,
	confirmSentByOperator,
	createRunsStore,
	ensureFantasyRunsTable,
	getRun,
	getSavedReportState,
	markDeliveryUnknown,
	markFailed,
	recordAttemptText,
	reserveSavedReportDelivery,
	savedPartStatus,
} from '../runs';
import { buildSavedReport } from '../saved-report';
import { dispatchSavedReport } from '../saved-report-delivery';
import { parseSavedReportRecovery, runSavedReportRecovery, unavailableSavedReportRecovery } from '../saved-report-recovery';
import { frozenEditorialFixture, validEditorialDraft } from './fixtures/editorial.fixture';

const reportId = `report-${'a'.repeat(64)}`;
const attemptId = '11111111-1111-4111-8111-111111111111';
const selectors = ['--week', '1', '--report-id', reportId];
const partSelectors = ['--part', '2', '--attempt-id', attemptId];
const expires = () => new Date(Date.now() + 60_000);
const cli = new URL('../../../../scripts/fantasy-recap.ts', import.meta.url).pathname;

async function runCli(flags: string[], env: Record<string, string> = {}) {
	const child = Bun.spawn([process.execPath, '--no-env-file', '--bun', cli, ...flags], {
		env: { HOME: '/tmp/jamis-stage1-home', ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

describe('strict additive saved-report CLI parsing', () => {
	test('no new selectors preserves the original legacy path', () => {
		for (const command of ['retry', 'confirm-sent', 'inspect', 'preview', 'run']) {
			expect(parseSavedReportRecovery(command, ['--week', '1'])).toBeNull();
		}
		expect(parseSavedReportRecovery('retry', ['--week', '1', '--operator-verified-absent'])).toBeNull();
	});
	test('accepts only exact retry, absence, and record-only confirmation forms', () => {
		expect(parseSavedReportRecovery('retry', selectors)).toEqual({ command: 'retry', week: 1, reportId });
		expect(parseSavedReportRecovery('retry', [...selectors, '--operator-verified-absent', ...partSelectors])).toEqual({
			command: 'retry',
			week: 1,
			reportId,
			absent: { part: 2, attemptId },
		});
		expect(parseSavedReportRecovery('confirm-sent', [...selectors, ...partSelectors])).toEqual({
			command: 'confirm-sent',
			week: 1,
			reportId,
			part: 2,
			attemptId,
		});
		expect(parseSavedReportRecovery('retry', ['--report-id', reportId, '--week', '22'])?.week).toBe(22);
	});
	test.each([
		['retry', ['--report-id']],
		['retry', [`--report-id=${reportId}`, '--week', '1']],
		['retry', ['--week', '1', ...partSelectors]],
		['retry', ['--week', '1', '--part', '1']],
		['retry', ['--week', '1', '--attempt-id', attemptId]],
		['retry', [...selectors, '--part', '1']],
		['retry', [...selectors, '--attempt-id', attemptId]],
		['retry', [...selectors, '--operator-verified-absent']],
		['retry', [...selectors, ...partSelectors]],
		['retry', [...selectors, '--week', '2']],
		['retry', [...selectors, '--report-id', reportId]],
		['retry', [...selectors, '--unexpected']],
		['retry', [...selectors, 'stray']],
		['retry', [...selectors, '--operator-verified-absent', '--operator-verified-absent', ...partSelectors]],
		['retry', [...selectors, '--operator-verified-absent', ...partSelectors, '--part', '2']],
		['retry', [...selectors, '--operator-verified-absent', ...partSelectors, '--attempt-id', attemptId]],
		['retry', ['--week', '0', '--report-id', reportId]],
		['retry', ['--week', '23', '--report-id', reportId]],
		['retry', ['--week', '1.0', '--report-id', reportId]],
		['retry', ['--week', '1e0', '--report-id', reportId]],
		['retry', ['--week', '01', '--report-id', reportId]],
		['retry', ['--week', '1', '--report-id', `report-${'z'.repeat(64)}`]],
		['retry', ['--week', '1', '--report-id', 'report-short']],
		['confirm-sent', selectors],
		['confirm-sent', [...selectors, '--part', '0', '--attempt-id', attemptId]],
		['confirm-sent', [...selectors, '--part', '4', '--attempt-id', attemptId]],
		['confirm-sent', [...selectors, '--part', '1', '--attempt-id', 'not-a-uuid']],
		['confirm-sent', [...selectors, ...partSelectors, '--operator-verified-absent']],
		['run', selectors],
		['preview', selectors],
		['preview-candidate', selectors],
		['inspect', selectors],
	] as Array<[string, string[]]>)('rejects %s %j without legacy fallthrough', (command, flags) => {
		expect(() => parseSavedReportRecovery(command, flags)).toThrow('invalid_saved_report_recovery_arguments');
	});
	test.each([
		['retry', '--week', '1', '--part', '1'],
		['retry', ...selectors, '--operator-verified-absent'],
		['confirm-sent', ...selectors],
		['inspect', ...selectors],
	])('malformed CLI %j needs no configuration, provider credentials, or operational imports', async (...flags) => {
		const result = await runCli(flags);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('Invalid saved-report recovery arguments.');
		expect(result.stderr).not.toMatch(/configuration is missing|SENDBLUE_API|DATABASE_URL|login|credential/i);
	}, 30_000);
	test('safe unavailable result contains only allowlisted operator fields', () => {
		expect(unavailableSavedReportRecovery({ command: 'retry', week: 1, reportId })).toEqual({
			status: 'blocked',
			week: 1,
			reportId,
			acceptedParts: 0,
			totalParts: 0,
			recoveryRequired: true,
			unresolved: null,
		});
	});
});

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
		review: async assignment => ({
			evidenceId: packet.id,
			candidateId: JSON.parse(assignment).candidate.id,
			verdict: 'pass',
			issues: [],
		}),
	});
	return buildSavedReport(packet, outcome);
}

type TransactionalSql = SqlLike & { begin: <T>(action: (sql: SqlLike) => Promise<T>) => Promise<T> };

// Fail only after the retry transaction commits, then optionally replace or expire that claim.
function lostClaimAck(base: SQL, afterCommit?: () => Promise<void>) {
	let hits = 0;
	const tagged: SqlLike = (strings, ...values) => base(strings, ...values);
	Object.assign(tagged, {
		begin: async <T>(action: (sql: SqlLike) => Promise<T>) => {
			const result = await (base as TransactionalSql).begin(action);
			if (hits++ === 0) {
				await afterCommit?.();
				throw new Error('SECRET database acknowledgement lost');
			}
			return result;
		},
	});
	return tagged;
}

const databaseUrl = process.env.JAMIS_TEST_DATABASE_URL;
if (databaseUrl) {
	const url = new URL(databaseUrl);
	if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)
		|| url.port !== '15458' || url.pathname !== '/jamis_sessions_test' || url.search) {
		throw new Error('Disposable loopback15458/jamis_sessions_test URL required');
	}
	const probe = new SQL(databaseUrl, { connectionTimeout: 1 });
	try {
		await probe`SELECT 1`;
	} finally {
		await probe.close();
	}
}

describe.skipIf(!databaseUrl)('saved-report operator recovery, native PG and mock publication only', () => {
	const schema = `saved_recovery_${randomUUID().replaceAll('-', '')}`;
	const token = 'fixture-original-claim';
	let root: SQL;
	let sql: SQL;
	let one: SavedReport;
	let three: SavedReport;
	let fetchGuard: ReturnType<typeof spyOn>;
	beforeAll(async () => {
		root = new SQL(databaseUrl!);
		await root.unsafe(`CREATE SCHEMA "${schema}"`);
		sql = new SQL(databaseUrl!, { connection: { search_path: schema } });
		await ensureFantasyRunsTable(sql);
		await ensureFantasyRecapsTable(sql);
		[one, three] = await Promise.all([reportFixture(false), reportFixture(true)]);
		expect(one.parts).toHaveLength(1);
		expect(three.parts).toHaveLength(3);
	}, 30_000);
	beforeEach(async () => {
		fetchGuard = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => {
			throw new Error('External network forbidden in recovery fixture');
		}, { preconnect: () => { throw new Error('External preconnect forbidden in recovery fixture'); } }));
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
	const ref = (report = three): SavedReportReference => ({ ...report.scope, reportId: report.id });
	const request = (report = three): SavedReportRecoveryRequest => ({
		command: 'retry',
		week: report.scope.week,
		reportId: report.id,
	});
	const deps = () => ({ leagueId: three.scope.leagueId, groupId: three.scope.groupId, sql });
	async function save(report = three) {
		const claim = await claimRun(report.scope.leagueId, report.scope.week, token, expires(), null, sql);
		expect(claim.claimed).toBe(true);
		expect(await recordApprovedReport(report, token, sql)).toBe(true);
		return ref(report);
	}
	async function state(report = three) {
		const value = await getSavedReportState(ref(report), sql);
		expect(value).not.toBeNull();
		return value!;
	}
	async function expire() {
		await sql`UPDATE fantasy_recap_runs SET lease_expires_at = ${new Date(Date.now() - 1000).toISOString()}`;
	}
	async function snapshot() {
		return [...await sql`SELECT to_jsonb(r) AS row FROM fantasy_recap_runs r ORDER BY league_id, fantasy_week`];
	}
	function publisher(outcomes: SendOutcome[] = []) {
		let calls = 0;
		const texts: string[] = [];
		return {
			calls: () => calls,
			texts,
			publish: async (reference: SavedReportReference, claimToken: string) => {
				calls++;
				const receipt = await dispatchSavedReport(reference, claimToken, sql, async (groupId, text) => {
					expect(groupId).toBe(three.scope.groupId);
					texts.push(text);
					return outcomes[texts.length - 1] ?? { kind: 'sent', handle: `fixture-${texts.length}` };
				});
				return { receipt, contribution: { status: 'FAKE_MODEL_STATUS', text: 'SECRET contribution and group' } };
			},
		};
	}
	async function stoppedAtSecond() {
		const reference = await save();
		const first = publisher([{ kind: 'sent', handle: 'first' }, { kind: 'unknown', error: 'SECRET transport error' }]);
		await first.publish(reference, token);
		const attempt = (await state()).progress.parts[1]!.at(-1)!;
		expect(attempt.state).toBe('unknown');
		return attempt;
	}

	test('confirmation records the exact unknown attempt, invokes zero publishers, and retains the automatic hold', async () => {
		const attempt = await stoppedAtSecond();
		const next = publisher();
		const result = await runSavedReportRecovery({ ...request(), command: 'confirm-sent', part: 2, attemptId: attempt.id }, { ...deps(), publish: next.publish });
		expect(result).toEqual({
			status: 'confirmed',
			week: three.scope.week,
			reportId: three.id,
			acceptedParts: 2,
			totalParts: 3,
			recoveryRequired: true,
			unresolved: null,
		});
		expect(next.calls()).toBe(0);
		expect((await state()).progress.parts.map(savedPartStatus)).toEqual(['accepted', 'accepted', 'pending']);
		expect(await claimSavedReportRetry(ref(), 'automatic', expires(), { source: 'automatic' }, sql)).toBe(false);
	});
	test('confirmation acknowledgement loss reconciles the exact accepted attempt without publication', async () => {
		const attempt = await stoppedAtSecond();
		let lost = false;
		const fault: SqlLike = async (strings, ...values) => {
			const result = await sql(strings, ...values);
			if (!lost && strings.join(' ').includes('UPDATE fantasy_recap_runs')) {
				lost = true;
				throw new Error('SECRET confirmation acknowledgement lost');
			}
			return result;
		};
		const next = publisher();
		const result = await runSavedReportRecovery({ ...request(), command: 'confirm-sent', part: 2, attemptId: attempt.id }, {
			...deps(),
			sql: fault,
			publish: next.publish,
		});
		expect(lost).toBe(true);
		expect(result).toMatchObject({ status: 'confirmed', acceptedParts: 2, recoveryRequired: true, unresolved: null });
		expect(next.calls()).toBe(0);
	});
	test.each([false, true])('acknowledged confirmation survives later SQL unavailability (final part=%s)', async (final) => {
		let attemptId: string;
		const part = final ? 3 : 2;
		if (final) {
			const reference = await save();
			const first = publisher([
				{ kind: 'sent', handle: 'first' },
				{ kind: 'sent', handle: 'second' },
				{ kind: 'unknown', error: 'synthetic unknown' },
			]);
			await first.publish(reference, token);
			attemptId = (await state()).progress.parts[2]!.at(-1)!.id;
		} else {
			attemptId = (await stoppedAtSecond()).id;
		}
		let unavailable = false;
		const fault: SqlLike = async (strings, ...values) => {
			if (unavailable)
				throw new Error('SECRET database unavailable after acknowledged confirmation');
			const result = await sql(strings, ...values);
			if (strings.join(' ').includes('UPDATE fantasy_recap_runs'))
				unavailable = true;
			return result;
		};
		const next = publisher();
		const result = await runSavedReportRecovery({ ...request(), command: 'confirm-sent', part, attemptId }, {
			...deps(),
			sql: fault,
			publish: next.publish,
		});
		expect(result).toMatchObject({
			status: final ? 'sent' : 'confirmed',
			acceptedParts: part,
			totalParts: 3,
			recoveryRequired: !final,
			unresolved: null,
		});
		expect(next.calls()).toBe(0);
		expect((await state()).progress.parts.filter(attempts => savedPartStatus(attempts) === 'accepted')).toHaveLength(part);
	});

	test('manual retry sends only the pending tail after record-only confirmation', async () => {
		const attempt = await stoppedAtSecond();
		await runSavedReportRecovery({ ...request(), command: 'confirm-sent', part: 2, attemptId: attempt.id }, deps());
		const next = publisher();
		const result = await runSavedReportRecovery(request(), { ...deps(), publish: next.publish });
		expect(result).toEqual({
			status: 'sent',
			week: three.scope.week,
			reportId: three.id,
			acceptedParts: 3,
			totalParts: 3,
			recoveryRequired: false,
			unresolved: null,
		});
		expect(next.calls()).toBe(1);
		expect(next.texts).toEqual(three.parts.slice(2));
		expect((await state()).deliverySource).toBe('operator');
	});
	test('unknown retry needs the exact absent part and attempt, never replays the accepted prefix', async () => {
		const attempt = await stoppedAtSecond();
		const next = publisher();
		const before = await snapshot();
		for (const absent of [undefined, { part: 1, attemptId: attempt.id }, { part: 2, attemptId: randomUUID() }]) {
			const result = await runSavedReportRecovery({ ...request(), command: 'retry', absent }, { ...deps(), publish: next.publish });
			expect(result).toMatchObject({ status: 'blocked', acceptedParts: 1, recoveryRequired: true, unresolved: { part: 2, attemptId: attempt.id } });
		}
		expect(await snapshot()).toEqual(before);
		expect(next.calls()).toBe(0);
		const result = await runSavedReportRecovery({ ...request(), command: 'retry', absent: { part: 2, attemptId: attempt.id } }, { ...deps(), publish: next.publish });
		expect(result.status).toBe('sent');
		expect(next.calls()).toBe(1);
		expect(next.texts).toEqual(three.parts.slice(1));
		expect((await state()).report).toEqual(three);
	});
	test('wrong confirmation selectors cannot record any part', async () => {
		const attempt = await stoppedAtSecond();
		const before = await snapshot();
		for (const selection of [{ part: 1, attemptId: attempt.id }, { part: 2, attemptId: randomUUID() }]) {
			expect((await runSavedReportRecovery({ ...request(), command: 'confirm-sent', ...selection }, deps())).status).toBe('blocked');
		}
		expect(await snapshot()).toEqual(before);
	});
	test('expired sending first becomes unknown, then exact confirmation records it without publication', async () => {
		const reference = await save();
		const operation = (await reserveSavedReportDelivery(reference, token, sql))!;
		const begun = (await beginSavedReportPart(reference, token, operation, sql))!;
		await expire();
		const result = await runSavedReportRecovery({ ...request(), command: 'confirm-sent', part: 1, attemptId: begun.attemptId }, deps());
		expect(result).toMatchObject({ status: 'confirmed', acceptedParts: 1, recoveryRequired: true, unresolved: null });
		expect((await state()).progress.parts.map(savedPartStatus)).toEqual(['accepted', 'pending', 'pending']);
	});
	test('bounded confirmation and blocked retry CLIs need no provider environment', async () => {
		const attempt = await stoppedAtSecond();
		const url = new URL(databaseUrl!);
		url.searchParams.set('options', `-c search_path=${schema}`);
		const flags = ['--week', String(three.scope.week), '--report-id', three.id];
		const env = {
			DATABASE_URL: url.toString(),
			FANTASY_SLEEPER_LEAGUE_ID: three.scope.leagueId,
			FANTASY_SENDBLUE_GROUP_ID: three.scope.groupId,
			FANTASY_MANAGER_MAP: '{}',
			FANTASY_RECAP_TIMEZONE: 'America/Chicago',
		};
		const blocked = await runCli(['retry', ...flags], env);
		expect(blocked.code).toBe(1);
		expect(blocked.stderr).toBe('');
		expect(JSON.parse(blocked.stdout)).toMatchObject({ status: 'blocked', unresolved: { part: 2, attemptId: attempt.id } });
		await sql.unsafe(`CREATE FUNCTION check_cli_timeouts() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				IF current_setting('statement_timeout') <> '15s' OR current_setting('lock_timeout') <> '5s' THEN
					RAISE EXCEPTION 'CLI timeouts are not set';
				END IF;
				RETURN NEW;
			END $$`);
		await sql.unsafe(`CREATE TRIGGER check_cli_timeouts BEFORE UPDATE ON fantasy_recap_runs
			FOR EACH ROW EXECUTE FUNCTION check_cli_timeouts()`);
		try {
			const result = await runCli(['confirm-sent', ...flags, '--part', '2', '--attempt-id', attempt.id], env);
			expect(result.code).toBe(0);
			expect(result.stderr).toBe('');
			expect(JSON.parse(result.stdout)).toMatchObject({ status: 'confirmed', acceptedParts: 2, recoveryRequired: true });
			expect((await state()).progress.parts[2]).toEqual([]);
		} finally {
			await sql.unsafe('DROP TRIGGER check_cli_timeouts ON fantasy_recap_runs');
			await sql.unsafe('DROP FUNCTION check_cli_timeouts()');
		}
	}, 30_000);
	test('safe receipt output excludes text, group, claim, errors and model contribution', async () => {
		await save();
		await expire();
		const next = publisher([{ kind: 'unknown', error: 'SECRET provider request and token' }]);
		const result = await runSavedReportRecovery(request(), { ...deps(), publish: next.publish });
		expect(result.status).toBe('delivery_unknown');
		expect(result.unresolved).toMatchObject({ part: 1 });
		expect(Object.keys(result).sort()).toEqual(['status', 'week', 'reportId', 'acceptedParts', 'totalParts', 'recoveryRequired', 'unresolved'].sort());
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain('SECRET');
		expect(serialized).not.toContain('FAKE_MODEL_STATUS');
		expect(serialized).not.toContain(three.scope.groupId);
		expect(serialized).not.toContain((await state()).claimToken!);
		expect(serialized).not.toContain(three.parts[0]!);
	});
	test.each(['group', 'league', 'week', 'id', 'digest', 'partial'] as const)('wrong %s is blocked without publication or mutation', async (kind) => {
		await save();
		await expire();
		const requestValue = request();
		const config = deps();
		if (kind === 'group')
			config.groupId = 'different-group';
		if (kind === 'league')
			config.leagueId = 'different-league';
		if (kind === 'week')
			requestValue.week++;
		if (kind === 'id')
			requestValue.reportId = one.id;
		if (kind === 'digest') {
			const corrupt = structuredClone(three);
			corrupt.parts[0] += ' changed';
			await sql`UPDATE fantasy_recap_runs SET saved_report = ${corrupt}`;
		}
		if (kind === 'partial')
			await sql`UPDATE fantasy_recap_runs SET part_delivery = NULL`;
		const before = await snapshot();
		const next = publisher();
		expect((await runSavedReportRecovery(requestValue, { ...config, publish: next.publish })).status).toBe('blocked');
		expect(next.calls()).toBe(0);
		expect(await snapshot()).toEqual(before);
	});
	test('live owner and newer active week refuse manual retry without composing the publisher', async () => {
		await save();
		const next = publisher();
		expect((await runSavedReportRecovery(request(), { ...deps(), publish: next.publish })).status).toBe('blocked');
		await expire();
		expect((await claimRun(three.scope.leagueId, three.scope.week + 1, 'newer', expires(), null, sql)).claimed).toBe(true);
		expect((await runSavedReportRecovery(request(), { ...deps(), publish: next.publish })).status).toBe('blocked');
		expect(next.calls()).toBe(0);
	});
	test('lost claim acknowledgement reconciles the same live token and publishes exactly once with a 15-minute lease', async () => {
		await save(one);
		await expire();
		let calls = 0;
		const result = await runSavedReportRecovery(request(one), {
			...deps(),
			sql: lostClaimAck(sql),
			publish: async (reference, claimToken) => {
				calls++;
				const owned = await state(one);
				expect(owned.claimToken).toBe(claimToken);
				expect(owned.leaseExpiresAt!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
				expect(owned.leaseExpiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
				return { receipt: await dispatchSavedReport(reference, claimToken, sql, async () => ({ kind: 'sent', handle: 'one' })) };
			},
		});
		expect(result.status).toBe('sent');
		expect(calls).toBe(1);
	});
	test.each(['expired', 'replaced'] as const)('lost claim acknowledgement cannot publish a subsequently %s claim', async (kind) => {
		await save();
		await expire();
		const next = publisher();
		const fault = lostClaimAck(sql, async () => {
			if (kind === 'expired')
				await expire();
			else await sql`UPDATE fantasy_recap_runs SET claim_token = 'replacement-claim'`;
		});
		expect((await runSavedReportRecovery(request(), { ...deps(), sql: fault, publish: next.publish })).status).toBe('blocked');
		expect(next.calls()).toBe(0);
	});
	test('publication error after acceptance returns durable truth and never republishes', async () => {
		await save(one);
		await expire();
		const next = publisher();
		const result = await runSavedReportRecovery(request(one), {
			...deps(),
			publish: async (reference, claimToken) => {
				await next.publish(reference, claimToken);
				throw new Error('SECRET model failed after transport');
			},
		});
		expect(result).toMatchObject({ status: 'sent', acceptedParts: 1, totalParts: 1 });
		expect(next.calls()).toBe(1);
		expect(next.texts).toEqual(one.parts);
	});
	test('publisher initialization failure holds its unreserved claim without an automatic second call', async () => {
		await save();
		await expire();
		let calls = 0;
		const result = await runSavedReportRecovery(request(), {
			...deps(),
			publish: async () => {
				calls++;
				throw new Error('SECRET gateway initialization failure');
			},
		});
		expect(result.status).toBe('failed');
		expect(calls).toBe(1);
		expect((await state()).progress.recoveryRequired).toBe(true);
		expect(await claimSavedReportRetry(ref(), 'automatic-after-init-failure', expires(), { source: 'automatic' }, sql)).toBe(false);
		expect(JSON.stringify(result)).not.toContain('SECRET');
	});
	test('database failures return a safe unavailable summary and never publish', async () => {
		const next = publisher();
		const unavailable: SqlLike = async () => {
			throw new Error('SECRET postgres://credential@private-host');
		};
		const result = await runSavedReportRecovery(request(), { ...deps(), sql: unavailable, publish: next.publish });
		expect(result).toEqual(unavailableSavedReportRecovery(request()));
		expect(next.calls()).toBe(0);
	});
	test('new selectors cannot fall back to legacy null/null rows; original retry and confirmation still work', async () => {
		const { leagueId, week } = three.scope;
		await claimRun(leagueId, week, token, expires(), null, sql);
		await recordAttemptText(leagueId, week, token, 'legacy exact text', sql);
		await markFailed(leagueId, week, token, 'fixture failure', 'model', 'execution_failed', sql);
		const before = await snapshot();
		const next = publisher();
		expect((await runSavedReportRecovery(request(), { ...deps(), publish: next.publish })).status).toBe('blocked');
		expect(await snapshot()).toEqual(before);
		expect(next.calls()).toBe(0);
		expect(await createRunsStore(leagueId, sql).claimForRetry(week, 'legacy-retry', expires())).toBe('legacy exact text');
		await markDeliveryUnknown(leagueId, week, 'legacy-retry', 'fixture unknown', sql);
		expect(await confirmSentByOperator(leagueId, week, sql)).toBe(true);
		expect((await getRun(leagueId, week, sql))?.status).toBe('sent');
		expect((await sql`SELECT saved_report, part_delivery FROM fantasy_recap_runs`)[0]).toEqual({ saved_report: null, part_delivery: null });
	});
});
