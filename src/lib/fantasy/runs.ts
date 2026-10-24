import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { SqlLike } from './recaps';
import type { SavedReport, SavedReportScope } from './saved-report';

import { parseGenerationState } from './generation-state';
import { parseSavedReport, sameSavedReportScope } from './saved-report';

export type RunStatus = 'started' | 'failed' | 'delivery_unknown' | 'sent';
export type RecapFailureStage = 'scheduled_job' | 'model' | 'application_storage' | 'reply_delivery';
export type RecapFailureClassification = 'execution_failed' | 'execution_interrupted' | 'delivery_failed' | 'unknown';

export interface RecapRun {
	leagueId: string;
	fantasyWeek: number;
	status: RunStatus;
	latestAttemptTraceId: string | null;
	failureStage: RecapFailureStage | null;
	failureClassification: RecapFailureClassification | null;
	finalText: string | null;
	claimToken: string | null;
	leaseExpiresAt: Date | null;
	sendAttemptAt: Date | null;
	messageHandle: string | null;
	deliverySource: 'api' | 'operator' | null;
	sentAt: Date | null;
	lastError: string | null;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * Delivery-state authority for one league/week (ADR 0018).
 * Multipart progress and pre-publication attempt metadata stay on this same row. The optimistic claim UPDATE
 * is the single-writer lock: two concurrent coordinators race it and exactly one
 * gets a row back.
 */
export async function ensureFantasyRunsTable(sql: SqlLike): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS fantasy_recap_runs (
			league_id TEXT NOT NULL,
			fantasy_week INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'started',
			latest_attempt_trace_id TEXT,
			failure_stage TEXT,
			failure_classification TEXT,
			final_text TEXT,
			claim_token TEXT,
			lease_expires_at TIMESTAMPTZ,
			send_attempt_at TIMESTAMPTZ,
			message_handle TEXT,
			delivery_source TEXT,
			sent_at TIMESTAMPTZ,
			last_error TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			PRIMARY KEY (league_id, fantasy_week)
		)
	`;
	await sql`
		ALTER TABLE fantasy_recap_runs
		ADD COLUMN IF NOT EXISTS latest_attempt_trace_id TEXT,
		ADD COLUMN IF NOT EXISTS failure_stage TEXT,
		ADD COLUMN IF NOT EXISTS failure_classification TEXT,
		ADD COLUMN IF NOT EXISTS saved_report JSONB,
		ADD COLUMN IF NOT EXISTS part_delivery JSONB,
		ADD COLUMN IF NOT EXISTS editorial_attempt JSONB
	`;
	// One operator alert per unmapped sender, forever (alert-once dedup).
	await sql`
		CREATE TABLE IF NOT EXISTS fantasy_unmapped_sender_alerts (
			sender_hash TEXT PRIMARY KEY,
			alerted_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`;
}

interface RunRow {
	league_id: string;
	fantasy_week: number;
	status: RunStatus;
	latest_attempt_trace_id: string | null;
	failure_stage: RecapFailureStage | null;
	failure_classification: RecapFailureClassification | null;
	final_text: string | null;
	claim_token: string | null;
	lease_expires_at: Date | null;
	send_attempt_at: Date | null;
	message_handle: string | null;
	delivery_source: 'api' | 'operator' | null;
	sent_at: Date | null;
	last_error: string | null;
	created_at: Date;
	updated_at: Date;
}

function toRun(row: RunRow): RecapRun {
	return {
		leagueId: row.league_id,
		fantasyWeek: row.fantasy_week,
		status: row.status,
		latestAttemptTraceId: row.latest_attempt_trace_id,
		failureStage: row.failure_stage,
		failureClassification: row.failure_classification,
		finalText: row.final_text,
		claimToken: row.claim_token,
		leaseExpiresAt: row.lease_expires_at,
		sendAttemptAt: row.send_attempt_at,
		messageHandle: row.message_handle,
		deliverySource: row.delivery_source,
		sentAt: row.sent_at,
		lastError: row.last_error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export async function getRun(leagueId: string, week: number, sql: SqlLike): Promise<RecapRun | null> {
	const rows = (await sql`
		SELECT
			*
		FROM
			fantasy_recap_runs
		WHERE
			league_id = ${leagueId}
			AND fantasy_week = ${week}
	`) as RunRow[];
	return rows[0] ? toRun(rows[0]) : null;
}

export const fantasyGenerationSummarySchema = z.object({
	attemptId: z.string().uuid(),
	generatorVersion: z.literal('fantasy-recap-v13'),
	phase: z.enum(['collecting', 'editorial', 'source_retryable', 'blocked', 'approved']),
	counts: z.object({
		nfl: z.number().int().min(0).max(3),
		drafts: z.number().int().min(0).max(3),
		reviews: z.number().int().min(0).max(3),
	}).strict(),
	reasonCode: z.string().regex(/^[a-z][a-z0-9_:.-]{0,99}$/).nullable(),
	evidenceId: z.string().regex(/^evidence-[a-f0-9]{64}$/).nullable(),
	candidateId: z.string().regex(/^candidate-[a-f0-9]{64}$/).nullable(),
	reportId: z.string().regex(/^report-[a-f0-9]{64}$/).nullable(),
}).strict();

export interface FantasyMonitoringRun {
	generationSummary?: z.infer<typeof fantasyGenerationSummarySchema>;
	latestAttemptTraceId?: string | null;
	fantasyWeek: number;
	status: RunStatus;
	failureStage: string | null;
	failureClassification: string | null;
	leaseExpiresAt: Date | null;
	sendAttemptAt: Date | null;
	deliverySource: string | null;
	sentAt: Date | null;
	updatedAt: Date;
}

interface FantasyMonitoringRunRow {
	generation_summary?: unknown;
	latest_attempt_trace_id?: unknown;
	fantasy_week: number;
	status: RunStatus;
	failure_stage: string | null;
	failure_classification: string | null;
	lease_expires_at: Date | null;
	send_attempt_at: Date | null;
	delivery_source: string | null;
	sent_at: Date | null;
	updated_at: Date;
}

function toFantasyMonitoringRun(row: FantasyMonitoringRunRow): FantasyMonitoringRun {
	const generationSummary = fantasyGenerationSummarySchema.safeParse(row.generation_summary);
	const traceId = z.string().regex(/^[a-f0-9]{32}$/).safeParse(row.latest_attempt_trace_id);
	return {
		...(generationSummary.success ? { generationSummary: generationSummary.data } : {}),
		...(traceId.success ? { latestAttemptTraceId: traceId.data } : {}),
		fantasyWeek: row.fantasy_week,
		status: row.status,
		failureStage: row.failure_stage,
		failureClassification: row.failure_classification,
		leaseExpiresAt: row.lease_expires_at,
		sendAttemptAt: row.send_attempt_at,
		deliverySource: row.delivery_source,
		sentAt: row.sent_at,
		updatedAt: row.updated_at,
	};
}

/** Allowlisted current-row evidence for configured-league Monitoring. */
export async function listFantasyMonitoringRuns(
	leagueId: string,
	week: number | undefined,
	sql: SqlLike,
): Promise<FantasyMonitoringRun[]> {
	const rows = week === undefined
		? await sql`
			SELECT
				fantasy_week,
				status,
				failure_stage,
				failure_classification,
				lease_expires_at,
				send_attempt_at,
				delivery_source,
				sent_at,
				updated_at,
				latest_attempt_trace_id,
				jsonb_build_object(
					'attemptId',
					editorial_attempt -> 'current' -> 'id',
					'generatorVersion',
					editorial_attempt -> 'current' -> 'generatorVersion',
					'phase',
					editorial_attempt -> 'current' -> 'phase',
					'counts',
					editorial_attempt -> 'current' -> 'counts',
					'reasonCode',
					editorial_attempt -> 'current' -> 'reasonCode',
					'evidenceId',
					editorial_attempt -> 'current' -> 'evidenceId',
					'candidateId',
					editorial_attempt -> 'current' -> 'candidateId',
					'reportId',
					editorial_attempt -> 'current' -> 'reportId'
				) AS generation_summary
			FROM
				fantasy_recap_runs
			WHERE
				league_id = ${leagueId}
				AND fantasy_week BETWEEN 1 AND 22
			ORDER BY
				fantasy_week DESC
			LIMIT
				22
		`
		: await sql`
			SELECT
				fantasy_week,
				status,
				failure_stage,
				failure_classification,
				lease_expires_at,
				send_attempt_at,
				delivery_source,
				sent_at,
				updated_at,
				latest_attempt_trace_id,
				jsonb_build_object(
					'attemptId',
					editorial_attempt -> 'current' -> 'id',
					'generatorVersion',
					editorial_attempt -> 'current' -> 'generatorVersion',
					'phase',
					editorial_attempt -> 'current' -> 'phase',
					'counts',
					editorial_attempt -> 'current' -> 'counts',
					'reasonCode',
					editorial_attempt -> 'current' -> 'reasonCode',
					'evidenceId',
					editorial_attempt -> 'current' -> 'evidenceId',
					'candidateId',
					editorial_attempt -> 'current' -> 'candidateId',
					'reportId',
					editorial_attempt -> 'current' -> 'reportId'
				) AS generation_summary
			FROM
				fantasy_recap_runs
			WHERE
				league_id = ${leagueId}
				AND fantasy_week = ${week}
			LIMIT
				1
		`;
	return (rows as FantasyMonitoringRunRow[]).map(toFantasyMonitoringRun);
}

export interface ClaimResult {
	claimed: boolean;
	run: RecapRun | null;
}

/**
 * Claims week for recap processing. Claimable states: no row yet (fresh week) or
 * `failed` (definite pre-send failure retries automatically). Everything else
 * refuses: `sent` is a no-op, `delivery_unknown` needs the operator, an
 * in-flight `started` lease belongs to another runner (a dead one is swept
 * into delivery_unknown first by sweepExpiredLeases).
 */
async function claimRunUnlocked(
	leagueId: string,
	week: number,
	claimToken: string,
	leaseExpiresAt: Date,
	traceId: string | null,
	sql: SqlLike,
): Promise<ClaimResult> {
	await sql`
		INSERT INTO
			fantasy_recap_runs (
				league_id,
				fantasy_week,
				status,
				claim_token,
				lease_expires_at,
				latest_attempt_trace_id
			)
		VALUES
			(
				${leagueId},
				${week},
				'started',
				${claimToken},
				${leaseExpiresAt.toISOString()},
				${traceId}
			)
		ON CONFLICT (league_id, fantasy_week) DO NOTHING
	`;
	const rows = (await sql`
		UPDATE fantasy_recap_runs
		SET
			claim_token = ${claimToken},
			lease_expires_at = ${leaseExpiresAt.toISOString()},
			send_attempt_at = NULL,
			status = 'started',
			last_error = NULL,
			latest_attempt_trace_id = ${traceId},
			failure_stage = NULL,
			failure_classification = NULL,
			updated_at = now()
		WHERE
			league_id = ${leagueId}
			AND fantasy_week = ${week}
			AND saved_report IS NULL
			AND part_delivery IS NULL
			AND editorial_attempt IS NULL
			AND (
				status = 'failed'
				OR (
					status = 'started'
					AND claim_token = ${claimToken}
				)
			)
		RETURNING
			*
	`) as RunRow[];
	if (rows[0])
		return { claimed: true, run: toRun(rows[0]) };
	const existing = await getRun(leagueId, week, sql);
	return { claimed: false, run: existing };
}

/** Stamps the exact text and attempt time immediately before the outbound request fires (ADR 0018). */
export async function recordAttemptText(
	leagueId: string,
	week: number,
	claimToken: string,
	finalText: string,
	sql: SqlLike,
): Promise<boolean> {
	const rows = (await sql`
		UPDATE fantasy_recap_runs
		SET
			final_text = ${finalText},
			send_attempt_at = now(),
			updated_at = now()
		WHERE
			saved_report IS NULL
			AND part_delivery IS NULL
			AND editorial_attempt IS NULL
			AND league_id = ${leagueId}
			AND fantasy_week = ${week}
			AND status = 'started'
			AND claim_token = ${claimToken}
		RETURNING
			1
	`) as unknown[];
	return rows.length === 1;
}

export async function markSent(
	leagueId: string,
	week: number,
	claimToken: string,
	handle: string,
	sql: SqlLike,
): Promise<boolean> {
	const rows = (await sql`
		UPDATE fantasy_recap_runs
		SET
			status = 'sent',
			message_handle = ${handle},
			delivery_source = 'api',
			sent_at = now(),
			failure_stage = NULL,
			failure_classification = NULL,
			updated_at = now()
		WHERE
			saved_report IS NULL
			AND part_delivery IS NULL
			AND editorial_attempt IS NULL
			AND league_id = ${leagueId}
			AND fantasy_week = ${week}
			AND status = 'started'
			AND claim_token = ${claimToken}
		RETURNING
			1
	`) as unknown[];
	return rows.length === 1;
}

export async function markFailed(
	leagueId: string,
	week: number,
	claimToken: string,
	error: string,
	stage: RecapFailureStage,
	classification: RecapFailureClassification,
	sql: SqlLike,
): Promise<boolean> {
	const rows = (await sql`
		UPDATE fantasy_recap_runs
		SET
			status = 'failed',
			last_error = ${error},
			failure_stage = ${stage},
			failure_classification = ${classification},
			updated_at = now()
		WHERE
			saved_report IS NULL
			AND part_delivery IS NULL
			AND editorial_attempt IS NULL
			AND league_id = ${leagueId}
			AND fantasy_week = ${week}
			AND status = 'started'
			AND claim_token = ${claimToken}
		RETURNING
			1
	`) as unknown[];
	return rows.length === 1;
}

export async function markDeliveryUnknown(
	leagueId: string,
	week: number,
	claimToken: string,
	error: string,
	sql: SqlLike,
): Promise<void> {
	await sql`
		UPDATE fantasy_recap_runs
		SET
			status = 'delivery_unknown',
			last_error = ${error},
			failure_stage = 'reply_delivery',
			failure_classification = 'unknown',
			updated_at = now()
		WHERE
			saved_report IS NULL
			AND part_delivery IS NULL
			AND editorial_attempt IS NULL
			AND league_id = ${leagueId}
			AND fantasy_week = ${week}
			AND status = 'started'
			AND claim_token = ${claimToken}
	`;
}

/**
 * Operator observed the message in the group. Effective delivery time stays
 * the original attempt (the message arrived then, we just learned later).
 */
export async function confirmSentByOperator(leagueId: string, week: number, sql: SqlLike): Promise<boolean> {
	const rows = (await sql`
		UPDATE fantasy_recap_runs
		SET
			status = 'sent',
			delivery_source = 'operator',
			sent_at = COALESCE(send_attempt_at, now()),
			failure_stage = NULL,
			failure_classification = NULL,
			updated_at = now()
		WHERE
			saved_report IS NULL
			AND part_delivery IS NULL
			AND editorial_attempt IS NULL
			AND league_id = ${leagueId}
			AND fantasy_week = ${week}
			AND status = 'delivery_unknown'
		RETURNING
			*
	`) as RunRow[];
	return rows.length === 1;
}

/**
 * Crash recovery as one guarded statement. Work interrupted before a recorded
 * send attempt is retryable; work interrupted after one remains delivery_unknown.
 * Legacy rows stamped attempts at claim time, so no final text also proves no send.
 */
export async function expireStaleLeases(
	leagueId: string,
	now: Date,
	reason: string,
	sql: SqlLike,
): Promise<RecapRun[]> {
	const rows = (await sql`
		UPDATE fantasy_recap_runs
		SET
			status = CASE
				WHEN send_attempt_at IS NULL
				OR final_text IS NULL THEN 'failed'
				ELSE 'delivery_unknown'
			END,
			last_error = CASE
				WHEN send_attempt_at IS NULL
				OR final_text IS NULL THEN 'recap processing interrupted before send'
				ELSE ${reason}
			END,
			failure_stage = CASE
				WHEN send_attempt_at IS NULL
				OR final_text IS NULL THEN NULL
				ELSE 'reply_delivery'
			END,
			failure_classification = 'execution_interrupted',
			updated_at = now()
		WHERE
			league_id = ${leagueId}
			AND status = 'started'
			AND saved_report IS NULL
			AND part_delivery IS NULL
			AND editorial_attempt IS NULL
			AND lease_expires_at < ${now.toISOString()}
		RETURNING
			*
	`) as RunRow[];
	return rows.map(toRun);
}

/** Retry guard: nothing newer may be claimed/sent while an older week retries. */
export async function hasNewerActiveRun(leagueId: string, week: number, sql: SqlLike): Promise<boolean> {
	const rows = (await sql`
		SELECT
			1
		FROM
			fantasy_recap_runs
		WHERE
			league_id = ${leagueId}
			AND fantasy_week > ${week}
			AND (
				status != 'failed'
				OR saved_report IS NOT NULL
				OR part_delivery IS NOT NULL
				OR editorial_attempt IS NOT NULL
			)
		LIMIT
			1
	`) as unknown[];
	return rows.length > 0;
}

/** Chat-context window anchor: the most recent sent run before this week. */
export async function latestSentRunBefore(leagueId: string, week: number, sql: SqlLike): Promise<RecapRun | null> {
	const rows = (await sql`
		SELECT
			*
		FROM
			fantasy_recap_runs
		WHERE
			league_id = ${leagueId}
			AND fantasy_week < ${week}
			AND status = 'sent'
		ORDER BY
			fantasy_week DESC
		LIMIT
			1
	`) as RunRow[];
	return rows[0] ? toRun(rows[0]) : null;
}

/** Bounded unresolved failures for incident triage, not a monitoring signal. */
export async function listActionableRuns(
	leagueId: string,
	start: Date,
	end: Date,
	limit: number,
	sql: SqlLike,
): Promise<RecapRun[]> {
	const rows = (await sql`
		SELECT
			*
		FROM
			fantasy_recap_runs
		WHERE
			league_id = ${leagueId}
			AND status IN ('failed', 'delivery_unknown')
			AND updated_at >= ${start.toISOString()}
			AND updated_at <= ${end.toISOString()}
		ORDER BY
			updated_at ASC,
			fantasy_week ASC
		LIMIT
			${limit}
	`) as RunRow[];
	return rows.map(toRun);
}

type TransactionalSql = SqlLike & { begin: <T>(action: (sql: SqlLike) => Promise<T>) => Promise<T> };

/** Lock before the eligibility statement, so concurrent cross-week inserts are visible. */
export async function withFantasyLeagueLock<T>(leagueId: string, sql: SqlLike, action: (sql: SqlLike) => Promise<T>): Promise<T> {
	if (!('begin' in sql) || typeof sql.begin !== 'function')
		throw new Error('transactional_recap_store_required');
	return (sql as TransactionalSql).begin(async (transaction) => {
		await transaction`SET LOCAL lock_timeout = '5s'`;
		await transaction`SET LOCAL statement_timeout = '15s'`;
		await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${leagueId}, 0))`;
		// Lock existing league rows before wall-clock checks, including unchanged-tuple lock waits.
		await transaction`SELECT fantasy_week FROM fantasy_recap_runs WHERE league_id = ${leagueId} ORDER BY fantasy_week FOR UPDATE`;
		return action(transaction);
	});
}

export async function claimRun(
	leagueId: string,
	week: number,
	claimToken: string,
	leaseExpiresAt: Date,
	traceId: string | null,
	sql: SqlLike,
): Promise<ClaimResult> {
	return withFantasyLeagueLock(leagueId, sql, transaction => claimRunUnlocked(leagueId, week, claimToken, leaseExpiresAt, traceId, transaction));
}

const partAttemptSchema = z.object({
	id: z.uuid(),
	claimToken: z.string().min(1),
	operationId: z.uuid(),
	state: z.enum(['sending', 'accepted', 'failed', 'unknown', 'absent']),
	atUtc: z.iso.datetime(),
	settledAtUtc: z.iso.datetime().nullable(),
	handle: z.string().min(1).max(500).nullable(),
	source: z.enum(['api', 'operator']).nullable(),
}).strict().superRefine((attempt, context) => {
	if ((attempt.state === 'accepted' && (!attempt.settledAtUtc || !attempt.source || (attempt.source === 'api' && !attempt.handle)))
		|| (attempt.state !== 'accepted' && attempt.handle !== null)
		|| (attempt.state === 'sending' && (attempt.settledAtUtc !== null || attempt.source !== null))
		|| (attempt.state === 'absent' && (attempt.source !== 'operator' || !attempt.settledAtUtc))) {
		context.addIssue({ code: 'custom', message: 'invalid_part_attempt' });
	}
});
const partProgressSchema = z.object({
	reportId: z.string(),
	operationId: z.uuid().nullable(),
	recoveryRequired: z.boolean(),
	recoveryNotifiedAtUtc: z.iso.datetime().optional(),
	parts: z.array(z.array(partAttemptSchema)).min(1).max(3),
}).strict();
export type SavedPartAttempt = z.infer<typeof partAttemptSchema>;
export type SavedReportProgress = z.infer<typeof partProgressSchema>;
export type SavedReportReference = SavedReportScope & { reportId: string };
export interface SavedReportState {
	report: SavedReport;
	progress: SavedReportProgress;
	status: RunStatus;
	claimToken: string | null;
	leaseExpiresAt: Date | null;
	leaseCurrent: boolean;
	/** Keep PostgreSQL microseconds for CAS; JavaScript Date truncates them. */
	leaseStamp: string | null;
	sendAttemptAt: Date | null;
	sentAt: Date | null;
	messageHandle: string | null;
	deliverySource: 'api' | 'operator' | null;
	traceId: string | null;
}

export function savedPartStatus(attempts: SavedPartAttempt[]): 'pending' | 'sending' | 'accepted' | 'failed' | 'unknown' {
	if (attempts.some(attempt => attempt.state === 'accepted'))
		return 'accepted';
	const last = attempts.at(-1)?.state;
	return last === 'absent' ? 'failed' : last ?? 'pending';
}

export function initialSavedReportProgress(report: SavedReport): SavedReportProgress {
	return { reportId: report.id, operationId: null, recoveryRequired: false, parts: report.parts.map(() => []) };
}

/** Operator recovery binds the exact report and configured destination, without a source/model lookup. */
export async function findSavedReportReference(
	leagueId: string,
	week: number,
	groupId: string,
	reportId: string,
	sql: SqlLike,
): Promise<SavedReportReference | null> {
	const [row] = await sql`
		SELECT
			saved_report,
			part_delivery
		FROM
			fantasy_recap_runs
		WHERE
			league_id = ${leagueId}
			AND fantasy_week = ${week}
	` as { saved_report: unknown; part_delivery: unknown }[];
	if (!row || (row.saved_report == null && row.part_delivery == null))
		return null;
	const report = parseSavedReport(row.saved_report);
	if (report.id !== reportId || report.scope.leagueId !== leagueId || report.scope.week !== week || report.scope.groupId !== groupId)
		return null;
	const reference = { ...report.scope, reportId: report.id };
	return await getSavedReportState(reference, sql) ? reference : null;
}

/** Private state only; models receive a bounded receipt, never this artifact or target. */
export async function getSavedReportState(reference: SavedReportReference, sql: SqlLike): Promise<SavedReportState | null> {
	const [row] = await sql`
		SELECT
			*,
			lease_expires_at > clock_timestamp() AS lease_current,
			lease_expires_at::text AS lease_stamp
		FROM
			fantasy_recap_runs
		WHERE
			league_id = ${reference.leagueId}
			AND fantasy_week = ${reference.week}
	` as (RunRow & { saved_report: unknown; part_delivery: unknown; editorial_attempt: unknown; lease_current: boolean; lease_stamp: string | null })[];
	if (!row || (row.saved_report == null && row.part_delivery == null))
		return null;
	const report = parseSavedReport(row.saved_report);
	if (row.editorial_attempt != null) {
		const attempt = parseGenerationState(row.editorial_attempt).current;
		if (attempt.phase !== 'approved' || !sameSavedReportScope(report, attempt.scope)
			|| attempt.reportId !== report.id || attempt.evidenceId !== report.evidenceId || attempt.candidateId !== report.candidateId
			|| attempt.counts.drafts !== report.counts.drafts || attempt.counts.reviews !== report.counts.reviews) {
			throw new Error('invalid_saved_report_state');
		}
	}
	const progress = partProgressSchema.parse(row.part_delivery);
	const statuses = progress.parts.map(savedPartStatus);
	const next = statuses.findIndex(status => status !== 'accepted');
	const ids = progress.parts.flat().map(attempt => attempt.id);
	if (!['started', 'failed', 'delivery_unknown', 'sent'].includes(row.status)
		|| !sameSavedReportScope(report, reference) || report.id !== reference.reportId || progress.reportId !== report.id
		|| progress.parts.length !== report.parts.length || new Set(ids).size !== ids.length
		|| (next >= 0 && statuses.slice(next + 1).some(status => status !== 'pending'))
		|| (row.status === 'sent') !== (next === -1)
		|| (row.status === 'delivery_unknown' && (statuses[next!] !== 'unknown' || !progress.recoveryRequired))
		|| (row.status === 'failed' && ['unknown', 'sending'].includes(statuses[next!]!))
		|| (row.status === 'started' && progress.recoveryRequired)) {
		throw new Error('invalid_saved_report_state');
	}
	return {
		report,
		progress,
		status: row.status,
		claimToken: row.claim_token,
		leaseExpiresAt: row.lease_expires_at,
		leaseCurrent: row.lease_current === true,
		leaseStamp: row.lease_stamp,
		sendAttemptAt: row.send_attempt_at,
		sentAt: row.sent_at,
		messageHandle: row.message_handle,
		deliverySource: row.delivery_source,
		traceId: row.latest_attempt_trace_id,
	};
}

/** CAS keeps concurrent recovery and late receipts from overwriting one another. */
async function replaceSavedReportState(
	before: SavedReportState,
	after: SavedReportState,
	sql: SqlLike,
	liveLease = false,
	newest = false,
): Promise<boolean> {
	const scope = before.report.scope;
	const rows = await sql`
		UPDATE fantasy_recap_runs
		SET
			part_delivery = ${after.progress},
			status = ${after.status},
			claim_token = ${after.claimToken},
			lease_expires_at = ${after.leaseStamp}::timestamptz,
			send_attempt_at = ${after.sendAttemptAt?.toISOString() ?? null},
			sent_at = ${after.sentAt?.toISOString() ?? null},
			message_handle = ${after.messageHandle},
			delivery_source = ${after.deliverySource},
			latest_attempt_trace_id = ${after.traceId},
			last_error = ${after.status === 'sent' || after.status === 'started' ? null : `saved_report_${after.status}`},
			failure_stage = ${after.status === 'sent' || after.status === 'started' ? null : 'reply_delivery'},
			failure_classification = ${after.status === 'delivery_unknown' ? 'unknown' : after.status === 'failed' ? 'delivery_failed' : null},
			updated_at = now()
		WHERE
			league_id = ${scope.leagueId}
			AND fantasy_week = ${scope.week}
			AND saved_report = ${before.report}
			AND part_delivery = ${before.progress}
			AND status = ${before.status}
			AND claim_token IS NOT DISTINCT FROM ${before.claimToken}
			AND lease_expires_at IS NOT DISTINCT FROM ${before.leaseStamp}::timestamptz
			AND (
				${liveLease} = false
				OR lease_expires_at > clock_timestamp()
			)
			AND (
				${newest} = false
				OR NOT EXISTS (
					SELECT
						1
					FROM
						fantasy_recap_runs newer
					WHERE
						newer.league_id = ${scope.leagueId}
						AND newer.fantasy_week > ${scope.week}
						AND (
							newer.status != 'failed'
							OR newer.saved_report IS NOT NULL
							OR newer.part_delivery IS NOT NULL
							OR newer.editorial_attempt IS NOT NULL
						)
				)
			)
		RETURNING
			1
	`;
	return rows.length === 1;
}

function completedSavedReport(state: SavedReportState): void {
	const accepted = state.progress.parts.map(attempts => attempts.find(attempt => attempt.state === 'accepted'));
	if (accepted.some(attempt => !attempt))
		return;
	state.status = 'sent';
	state.progress.recoveryRequired = false;
	state.sentAt = new Date(Math.max(...accepted.map(attempt => new Date(attempt!.source === 'operator' ? attempt!.atUtc : attempt!.settledAtUtc!).getTime())));
	state.deliverySource = accepted.some(attempt => attempt!.source === 'operator') ? 'operator' : 'api';
	state.messageHandle = accepted.at(-1)!.handle;
}

function markOutstandingUnknown(progress: SavedReportProgress): void {
	for (const attempts of progress.parts) {
		for (const attempt of attempts) {
			if (attempt.state === 'sending')
				attempt.state = 'unknown';
		}
	}
}

/** Expiry revokes dispatch permission, not the ability to record a matching late receipt. */
export async function recoverSavedReport(reference: SavedReportReference, sql: SqlLike): Promise<void> {
	const before = await getSavedReportState(reference, sql);
	if (!before || before.status !== 'started' || before.leaseCurrent)
		return;
	const after = structuredClone(before);
	markOutstandingUnknown(after.progress);
	const unknown = after.progress.parts.some(attempts => savedPartStatus(attempts) === 'unknown');
	after.status = unknown ? 'delivery_unknown' : 'failed';
	after.progress.recoveryRequired ||= unknown;
	await replaceSavedReportState(before, after, sql);
}

/** One reservation per claim, including across recreated tool/procedure instances. */
export async function reserveSavedReportDelivery(reference: SavedReportReference, token: string, sql: SqlLike): Promise<string | null> {
	return withFantasyLeagueLock(reference.leagueId, sql, async (transaction) => {
		const before = await getSavedReportState(reference, transaction);
		if (!before || before.status !== 'started' || before.claimToken !== token || !before.leaseCurrent
			|| before.progress.recoveryRequired || before.progress.operationId !== null) {
			return null;
		}
		const after = structuredClone(before);
		after.progress.operationId = randomUUID();
		return await replaceSavedReportState(before, after, transaction, true, true) ? after.progress.operationId : null;
	});
}

export async function beginSavedReportPart(reference: SavedReportReference, token: string, operationId: string, sql: SqlLike) {
	return withFantasyLeagueLock(reference.leagueId, sql, async (transaction) => {
		const before = await getSavedReportState(reference, transaction);
		if (!before || before.status !== 'started' || before.claimToken !== token || !before.leaseCurrent
			|| before.progress.recoveryRequired || before.progress.operationId !== operationId) {
			return null;
		}
		const index = before.progress.parts.findIndex(attempts => savedPartStatus(attempts) !== 'accepted');
		if (index < 0 || !['pending', 'failed'].includes(savedPartStatus(before.progress.parts[index]!)))
			return null;
		const after = structuredClone(before);
		const attempt: SavedPartAttempt = {
			id: randomUUID(),
			claimToken: token,
			operationId,
			state: 'sending',
			atUtc: new Date().toISOString(),
			settledAtUtc: null,
			handle: null,
			source: null,
		};
		after.progress.parts[index]!.push(attempt);
		after.sendAttemptAt = new Date(attempt.atUtc);
		if (!await replaceSavedReportState(before, after, transaction, true, true))
			return null;
		return { part: index + 1, attemptId: attempt.id, text: before.report.parts[index]! };
	});
}

/** Local CAS retries never repeat transport; superseded uncertain attempts remain attributable. */
export async function recordSavedReportPart(
	reference: SavedReportReference,
	part: number,
	attemptId: string,
	outcome: { kind: 'sent'; handle: string } | { kind: 'failed' | 'unknown' },
	sql: SqlLike,
	pauseBeforeDispatch = false,
): Promise<boolean> {
	if (!Number.isInteger(part) || part < 1 || part > 3
		|| (outcome.kind === 'sent' && (!outcome.handle?.trim() || outcome.handle.length > 500))) {
		return false;
	}
	for (let conflict = 0; conflict < 3; conflict++) {
		try {
			const before = await getSavedReportState(reference, sql);
			const found = before?.progress.parts[part - 1]?.find(attempt => attempt.id === attemptId);
			if (!before || !found)
				return false;
			if (found.state === 'accepted' || (found.state === 'absent' && outcome.kind !== 'sent')
				|| (found.state === 'failed' && outcome.kind === 'unknown')) {
				return true;
			}
			const after = structuredClone(before);
			const attempt = after.progress.parts[part - 1]!.find(attempt => attempt.id === attemptId)!;
			const canceledBeforeDispatch = pauseBeforeDispatch && found.claimToken === before.claimToken
				&& found.operationId === before.progress.operationId;
			after.progress.recoveryRequired ||= canceledBeforeDispatch;
			attempt.state = outcome.kind === 'sent' ? 'accepted' : outcome.kind;
			attempt.settledAtUtc = new Date().toISOString();
			attempt.handle = outcome.kind === 'sent' ? outcome.handle : null;
			attempt.source = outcome.kind === 'sent' ? 'api' : null;
			if (!before.leaseCurrent)
				markOutstandingUnknown(after.progress);
			const next = after.progress.parts.find(attempts => savedPartStatus(attempts) !== 'accepted');
			if (next) {
				const status = savedPartStatus(next);
				if (status === 'unknown') {
					after.status = 'delivery_unknown';
					after.progress.recoveryRequired = true;
				} else if (status === 'failed' || canceledBeforeDispatch || before.status !== 'started' || !before.leaseCurrent) {
					after.status = 'failed';
					after.progress.recoveryRequired ||= before.status === 'delivery_unknown' || !before.leaseCurrent;
				}
			}
			completedSavedReport(after);
			if (await replaceSavedReportState(before, after, sql))
				return true;
		} catch { /* Re-read after an uncertain SQL acknowledgement; never resend. */ }
	}
	return false;
}

/** A confirmation never invokes transport or clears the hold on a pending tail. */
export async function confirmSavedReportPart(reference: SavedReportReference, part: number, attemptId: string, sql: SqlLike): Promise<boolean> {
	const before = await getSavedReportState(reference, sql);
	if (!before || before.status !== 'delivery_unknown' || !Number.isInteger(part))
		return false;
	const after = structuredClone(before);
	const attempts = after.progress.parts[part - 1];
	const attempt = attempts?.at(-1);
	if (!attempt || attempt.id !== attemptId || attempt.state !== 'unknown' || savedPartStatus(attempts!) !== 'unknown')
		return false;
	attempt.state = 'accepted';
	attempt.source = 'operator';
	attempt.settledAtUtc = new Date().toISOString();
	after.status = 'failed';
	after.progress.recoveryRequired = true;
	completedSavedReport(after);
	return replaceSavedReportState(before, after, sql);
}

export async function claimSavedReportRetry(
	reference: SavedReportReference,
	token: string,
	leaseExpiresAt: Date,
	request: { source: 'operator' | 'automatic'; absent?: { part: number; attemptId: string } },
	sql: SqlLike,
): Promise<boolean> {
	if (!['operator', 'automatic'].includes(request.source))
		return false;
	await recoverSavedReport(reference, sql);
	return withFantasyLeagueLock(reference.leagueId, sql, async (transaction) => {
		const before = await getSavedReportState(reference, transaction);
		if (!before || !['failed', 'delivery_unknown'].includes(before.status) || !token
			|| !Number.isFinite(leaseExpiresAt.getTime()) || leaseExpiresAt <= new Date()
			|| (request.source === 'automatic' && (before.progress.recoveryRequired || request.absent))) {
			return false;
		}
		const after = structuredClone(before);
		const next = after.progress.parts.findIndex(attempts => savedPartStatus(attempts) !== 'accepted');
		if (next < 0)
			return false;
		const last = after.progress.parts[next]!.at(-1);
		if (last?.state === 'unknown') {
			if (request.source !== 'operator' || request.absent?.part !== next + 1 || request.absent.attemptId !== last.id)
				return false;
			// An absence observation is not cancellation. Keep this identity for late receipts.
			last.state = 'absent';
			last.source = 'operator';
			last.settledAtUtc = new Date().toISOString();
		} else if (request.absent) {
			return false;
		}
		after.status = 'started';
		after.claimToken = token;
		after.leaseExpiresAt = leaseExpiresAt;
		after.leaseStamp = leaseExpiresAt.toISOString();
		after.progress.operationId = null;
		after.progress.recoveryRequired = false;
		delete after.progress.recoveryNotifiedAtUtc;
		after.traceId = null;
		return replaceSavedReportState(before, after, transaction, false, true);
	});
}

/** Claim one bounded recovery notification on the existing delivery row, never a send grant. */
export async function markSavedReportNotified(reference: SavedReportReference, sql: SqlLike): Promise<SavedReportState | null> {
	return withFantasyLeagueLock(reference.leagueId, sql, async (transaction) => {
		const before = await getSavedReportState(reference, transaction);
		if (!before || before.status === 'sent' || before.progress.recoveryNotifiedAtUtc
			|| (before.status !== 'delivery_unknown' && !before.progress.recoveryRequired)) {
			return null;
		}
		const after = structuredClone(before);
		after.progress.recoveryNotifiedAtUtc = new Date().toISOString();
		return await replaceSavedReportState(before, after, transaction) ? after : null;
	});
}

export async function pauseSavedReportDelivery(reference: SavedReportReference, token: string, operationId: string | null, sql: SqlLike): Promise<void> {
	const before = await getSavedReportState(reference, sql);
	if (!before || !['started', 'failed'].includes(before.status) || before.claimToken !== token || before.progress.operationId !== operationId
		|| before.progress.parts.some(attempts => ['sending', 'unknown'].includes(savedPartStatus(attempts)))) {
		return;
	}
	const after = structuredClone(before);
	after.status = 'failed';
	after.progress.recoveryRequired = true;
	await replaceSavedReportState(before, after, sql);
}

/** The store port the coordinator orchestrates against (PG impl below, in-memory in tests). */
export interface RunsStore {
	ensureSchema: () => Promise<void>;
	getRun: (week: number) => Promise<RecapRun | null>;
	claimRun: (week: number, claimToken: string, leaseExpiresAt: Date, traceId: string | null) => Promise<ClaimResult>;
	/** Returns the claimed row's stored final_text (the exact text to resend), or null when unclaimable. */
	claimForRetry: (week: number, claimToken: string, leaseExpiresAt: Date) => Promise<string | null>;
	recordAttemptText: (week: number, claimToken: string, finalText: string) => Promise<boolean>;
	markSent: (week: number, claimToken: string, handle: string) => Promise<boolean>;
	markFailed: (
		week: number,
		claimToken: string,
		error: string,
		stage: RecapFailureStage,
		classification: RecapFailureClassification,
	) => Promise<boolean>;
	markDeliveryUnknown: (week: number, claimToken: string, error: string) => Promise<void>;
	confirmSentByOperator: (week: number) => Promise<boolean>;
	/** Atomic expired-lease sweep; transitioned rows (each needs an operator DM). */
	expireStaleLeases: (now: Date, reason: string) => Promise<RecapRun[]>;
	hasNewerActiveRun: (week: number) => Promise<boolean>;
	latestSentRunBefore: (week: number) => Promise<RecapRun | null>;
	/** Returns true exactly once per sender, across runs (alert-once dedup). */
	alertUnmappedSenderOnce: (senderHash: string) => Promise<boolean>;
}

export function createRunsStore(leagueId: string, sql: SqlLike): RunsStore {
	return {
		ensureSchema: () => ensureFantasyRunsTable(sql),
		getRun: week => getRun(leagueId, week, sql),
		claimRun: (
			week,
			claimToken,
			leaseExpiresAt,
			traceId,
		) => claimRun(leagueId, week, claimToken, leaseExpiresAt, traceId, sql),
		claimForRetry: (week, claimToken, leaseExpiresAt) => withFantasyLeagueLock(leagueId, sql, async (sql) => {
			const rows = (await sql`
				UPDATE fantasy_recap_runs
				SET
					claim_token = ${claimToken},
					lease_expires_at = ${leaseExpiresAt.toISOString()},
					send_attempt_at = NULL,
					status = 'started',
					last_error = NULL,
					latest_attempt_trace_id = NULL,
					failure_stage = NULL,
					failure_classification = NULL,
					updated_at = now()
				WHERE
					league_id = ${leagueId}
					AND fantasy_week = ${week}
					AND status IN ('failed', 'delivery_unknown')
					AND saved_report IS NULL
					AND part_delivery IS NULL
					AND editorial_attempt IS NULL
				RETURNING
					final_text
			`) as { final_text: string }[];
			return rows.length === 1 ? rows[0]!.final_text : null;
		}),
		recordAttemptText: (
			week,
			claimToken,
			finalText,
		) => recordAttemptText(leagueId, week, claimToken, finalText, sql),
		markSent: (week, claimToken, handle) => markSent(leagueId, week, claimToken, handle, sql),
		markFailed: (
			week,
			claimToken,
			error,
			stage,
			classification,
		) => markFailed(leagueId, week, claimToken, error, stage, classification, sql),
		markDeliveryUnknown: (week, claimToken, error) => markDeliveryUnknown(leagueId, week, claimToken, error, sql),
		confirmSentByOperator: week => confirmSentByOperator(leagueId, week, sql),
		expireStaleLeases: (now, reason) => expireStaleLeases(leagueId, now, reason, sql),
		hasNewerActiveRun: week => hasNewerActiveRun(leagueId, week, sql),
		latestSentRunBefore: week => latestSentRunBefore(leagueId, week, sql),
		alertUnmappedSenderOnce: async (senderHash) => {
			const rows = (await sql`
				INSERT INTO
					fantasy_unmapped_sender_alerts (sender_hash)
				VALUES
					(${senderHash})
				ON CONFLICT (sender_hash) DO NOTHING
				RETURNING
					sender_hash
			`) as unknown[];
			return rows.length === 1;
		},
	};
}
