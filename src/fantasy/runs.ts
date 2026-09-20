import type { SqlLike } from './recaps';

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
 * Delivery-state authority for one league/week (ADR 0018). Born complete:
 * stage 5 scheduling adds zero columns. The optimistic claim UPDATE is the
 * single-writer lock — two concurrent coordinators race it and exactly one
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
			ADD COLUMN IF NOT EXISTS failure_classification TEXT
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
		SELECT * FROM fantasy_recap_runs WHERE league_id = ${leagueId} AND fantasy_week = ${week}
	`) as RunRow[];
	return rows[0] ? toRun(rows[0]) : null;
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
export async function claimRun(
	leagueId: string,
	week: number,
	claimToken: string,
	leaseExpiresAt: Date,
	traceId: string | null,
	sql: SqlLike,
): Promise<ClaimResult> {
	await sql`
		INSERT INTO fantasy_recap_runs (league_id, fantasy_week, status, claim_token, lease_expires_at, latest_attempt_trace_id)
		VALUES (${leagueId}, ${week}, 'started', ${claimToken}, ${leaseExpiresAt.toISOString()}, ${traceId})
		ON CONFLICT (league_id, fantasy_week) DO NOTHING
	`;
	const rows = (await sql`
		UPDATE fantasy_recap_runs
		SET claim_token = ${claimToken}, lease_expires_at = ${leaseExpiresAt.toISOString()},
			send_attempt_at = NULL, status = 'started', last_error = NULL,
			latest_attempt_trace_id = ${traceId}, failure_stage = NULL, failure_classification = NULL,
			updated_at = now()
		WHERE league_id = ${leagueId} AND fantasy_week = ${week}
			AND (status = 'failed' OR (status = 'started' AND claim_token = ${claimToken}))
		RETURNING *
	`) as RunRow[];
	if (rows[0])
		return { claimed: true, run: toRun(rows[0]) };
	const existing = await getRun(leagueId, week, sql);
	return { claimed: false, run: existing };
}

/** Stamps the exact text and attempt time immediately before the outbound request fires (ADR 0018). */
export async function recordAttemptText(leagueId: string, week: number, claimToken: string, finalText: string, sql: SqlLike): Promise<boolean> {
	const rows = (await sql`
		UPDATE fantasy_recap_runs SET final_text = ${finalText}, send_attempt_at = now(), updated_at = now()
		WHERE league_id = ${leagueId} AND fantasy_week = ${week}
			AND status = 'started' AND claim_token = ${claimToken}
		RETURNING 1
	`) as unknown[];
	return rows.length === 1;
}

export async function markSent(leagueId: string, week: number, claimToken: string, handle: string, sql: SqlLike): Promise<boolean> {
	const rows = (await sql`
		UPDATE fantasy_recap_runs
		SET status = 'sent', message_handle = ${handle}, delivery_source = 'api', sent_at = now(),
			failure_stage = NULL, failure_classification = NULL, updated_at = now()
		WHERE league_id = ${leagueId} AND fantasy_week = ${week}
			AND status = 'started' AND claim_token = ${claimToken}
		RETURNING 1
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
		SET status = 'failed', last_error = ${error}, failure_stage = ${stage},
			failure_classification = ${classification}, updated_at = now()
		WHERE league_id = ${leagueId} AND fantasy_week = ${week}
			AND status = 'started' AND claim_token = ${claimToken}
		RETURNING 1
	`) as unknown[];
	return rows.length === 1;
}

export async function markDeliveryUnknown(leagueId: string, week: number, claimToken: string, error: string, sql: SqlLike): Promise<void> {
	await sql`
		UPDATE fantasy_recap_runs
		SET status = 'delivery_unknown', last_error = ${error}, failure_stage = 'reply_delivery',
			failure_classification = 'unknown', updated_at = now()
		WHERE league_id = ${leagueId} AND fantasy_week = ${week}
			AND status = 'started' AND claim_token = ${claimToken}
	`;
}

/**
 * Operator observed the message in the group. Effective delivery time stays
 * the original attempt (the message arrived then, we just learned later).
 */
export async function confirmSentByOperator(leagueId: string, week: number, sql: SqlLike): Promise<boolean> {
	const rows = (await sql`
		UPDATE fantasy_recap_runs
		SET status = 'sent', delivery_source = 'operator', sent_at = COALESCE(send_attempt_at, now()),
			failure_stage = NULL, failure_classification = NULL, updated_at = now()
		WHERE league_id = ${leagueId} AND fantasy_week = ${week} AND status = 'delivery_unknown'
		RETURNING *
	`) as RunRow[];
	return rows.length === 1;
}

/**
 * Crash recovery as one guarded statement. Work interrupted before a recorded
 * send attempt is retryable; work interrupted after one remains delivery_unknown.
 * Legacy rows stamped attempts at claim time, so no final text also proves no send.
 */
export async function expireStaleLeases(leagueId: string, now: Date, reason: string, sql: SqlLike): Promise<RecapRun[]> {
	const rows = (await sql`
		UPDATE fantasy_recap_runs
		SET status = CASE WHEN send_attempt_at IS NULL OR final_text IS NULL THEN 'failed' ELSE 'delivery_unknown' END,
			last_error = CASE WHEN send_attempt_at IS NULL OR final_text IS NULL THEN 'recap processing interrupted before send' ELSE ${reason} END,
			failure_stage = CASE WHEN send_attempt_at IS NULL OR final_text IS NULL THEN NULL ELSE 'reply_delivery' END,
			failure_classification = 'execution_interrupted',
			updated_at = now()
		WHERE league_id = ${leagueId} AND status = 'started' AND lease_expires_at < ${now.toISOString()}
		RETURNING *
	`) as RunRow[];
	return rows.map(toRun);
}

/** Retry guard: nothing newer may be claimed/sent while an older week retries. */
export async function hasNewerActiveRun(leagueId: string, week: number, sql: SqlLike): Promise<boolean> {
	const rows = (await sql`
		SELECT 1 FROM fantasy_recap_runs
		WHERE league_id = ${leagueId} AND fantasy_week > ${week} AND status != 'failed'
		LIMIT 1
	`) as unknown[];
	return rows.length > 0;
}

/** Chat-context window anchor: the most recent sent run before this week. */
export async function latestSentRunBefore(leagueId: string, week: number, sql: SqlLike): Promise<RecapRun | null> {
	const rows = (await sql`
		SELECT * FROM fantasy_recap_runs
		WHERE league_id = ${leagueId} AND fantasy_week < ${week} AND status = 'sent'
		ORDER BY fantasy_week DESC LIMIT 1
	`) as RunRow[];
	return rows[0] ? toRun(rows[0]) : null;
}

/** Latest unresolved failure for bounded incident triage, not a monitoring signal. */
export async function latestActionableRun(leagueId: string, start: Date, end: Date, sql: SqlLike): Promise<RecapRun | null> {
	const rows = (await sql`
		SELECT * FROM fantasy_recap_runs
		WHERE league_id = ${leagueId} AND status IN ('failed', 'delivery_unknown')
			AND updated_at >= ${start.toISOString()} AND updated_at <= ${end.toISOString()}
		ORDER BY updated_at DESC LIMIT 1
	`) as RunRow[];
	return rows[0] ? toRun(rows[0]) : null;
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
	markFailed: (week: number, claimToken: string, error: string, stage: RecapFailureStage, classification: RecapFailureClassification) => Promise<boolean>;
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
		claimRun: (week, claimToken, leaseExpiresAt, traceId) => claimRun(leagueId, week, claimToken, leaseExpiresAt, traceId, sql),
		claimForRetry: async (week, claimToken, leaseExpiresAt) => {
			const rows = (await sql`
				UPDATE fantasy_recap_runs
				SET claim_token = ${claimToken}, lease_expires_at = ${leaseExpiresAt.toISOString()},
					send_attempt_at = NULL, status = 'started', last_error = NULL,
					latest_attempt_trace_id = NULL, failure_stage = NULL, failure_classification = NULL,
					updated_at = now()
				WHERE league_id = ${leagueId} AND fantasy_week = ${week} AND status IN ('failed', 'delivery_unknown')
				RETURNING final_text
			`) as { final_text: string }[];
			return rows.length === 1 ? rows[0]!.final_text : null;
		},
		recordAttemptText: (week, claimToken, finalText) => recordAttemptText(leagueId, week, claimToken, finalText, sql),
		markSent: (week, claimToken, handle) => markSent(leagueId, week, claimToken, handle, sql),
		markFailed: (week, claimToken, error, stage, classification) => markFailed(leagueId, week, claimToken, error, stage, classification, sql),
		markDeliveryUnknown: (week, claimToken, error) => markDeliveryUnknown(leagueId, week, claimToken, error, sql),
		confirmSentByOperator: week => confirmSentByOperator(leagueId, week, sql),
		expireStaleLeases: (now, reason) => expireStaleLeases(leagueId, now, reason, sql),
		hasNewerActiveRun: week => hasNewerActiveRun(leagueId, week, sql),
		latestSentRunBefore: week => latestSentRunBefore(leagueId, week, sql),
		alertUnmappedSenderOnce: async (senderHash) => {
			const rows = (await sql`
				INSERT INTO fantasy_unmapped_sender_alerts (sender_hash) VALUES (${senderHash})
				ON CONFLICT (sender_hash) DO NOTHING RETURNING sender_hash
			`) as unknown[];
			return rows.length === 1;
		},
	};
}
