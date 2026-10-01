import { SQL } from 'bun';

import process from 'node:process';

import { isIanaTimeZone } from './time';

export interface SqlLike {
	(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
	begin?: <T>(operation: (sql: SqlLike) => Promise<T>) => Promise<T>;
}

export interface OperatorTimeZone {
	timeZone: string;
	source: 'override' | 'default';
}

export interface PendingOperatorTimeZoneProposal {
	messageId: string;
	threadId: string;
}

export interface PendingOperatorTimeZoneNotification {
	messageId: string;
	overrideTimeZone: string | null;
	threadId: string;
}

export interface ConsumedOperatorTimeZoneChange {
	applied: boolean;
	consumedProposal: boolean;
	overrideTimeZone: string | null;
}

let cachedSql: SQL | null = null;
const tableReady = new WeakMap<SqlLike, Promise<void>>();

function getSql(): SQL {
	cachedSql ??= new SQL(process.env.DATABASE_URL ?? 'postgres://localhost:5432/mastra');
	return cachedSql;
}

export function ensureOperatorTimeZoneTable(sql: SqlLike = getSql()): Promise<void> {
	const existing = tableReady.get(sql);
	if (existing)
		return existing;

	const promise = (async () => {
		await sql`
			CREATE TABLE IF NOT EXISTS operator_time_zone (
				singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
				override_time_zone TEXT,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`;
		await sql`
			ALTER TABLE operator_time_zone
				ADD COLUMN IF NOT EXISTS proposal_time_zone TEXT,
				ADD COLUMN IF NOT EXISTS proposal_thread_id TEXT,
				ADD COLUMN IF NOT EXISTS proposal_message_id TEXT,
				ADD COLUMN IF NOT EXISTS proposal_message_at TIMESTAMPTZ,
				ADD COLUMN IF NOT EXISTS last_message_thread_id TEXT,
				ADD COLUMN IF NOT EXISTS last_message_id TEXT,
				ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ,
				ADD COLUMN IF NOT EXISTS notification_thread_id TEXT,
				ADD COLUMN IF NOT EXISTS notification_message_id TEXT,
				ADD COLUMN IF NOT EXISTS notification_override_time_zone TEXT
		`;
		await sql`
			INSERT INTO operator_time_zone (singleton)
			VALUES (TRUE)
			ON CONFLICT (singleton) DO NOTHING
		`;
	})()
		.catch((error) => {
			tableReady.delete(sql);
			throw error;
		});
	tableReady.set(sql, promise);
	return promise;
}

export async function withOperatorTimeZoneTransaction<T>(
	operation: (sql: SqlLike) => Promise<T>,
	sql: SqlLike = getSql(),
): Promise<T> {
	await ensureOperatorTimeZoneTable(sql);
	if (!sql.begin)
		return await operation(sql);
	return await sql.begin(async (transaction) => {
		tableReady.set(transaction, Promise.resolve());
		try {
			return await operation(transaction);
		}
		finally {
			tableReady.delete(transaction);
		}
	});
}

export async function resolveOperatorTimeZone(defaultTimeZone: string, sql: SqlLike = getSql()): Promise<OperatorTimeZone> {
	await ensureOperatorTimeZoneTable(sql);
	const rows = await sql`SELECT override_time_zone FROM operator_time_zone WHERE singleton = TRUE` as { override_time_zone: string | null }[];
	const override = rows[0]?.override_time_zone;

	return override
		? { timeZone: override, source: 'override' }
		: { timeZone: defaultTimeZone, source: 'default' };
}

export async function setOperatorTimeZoneOverride(timeZone: string | null, sql: SqlLike = getSql()): Promise<void> {
	const override = timeZone?.trim() || null;
	if (override && !isIanaTimeZone(override)) {
		throw new Error(`Invalid operator time zone: "${override}".`);
	}

	await ensureOperatorTimeZoneTable(sql);
	await sql`
		INSERT INTO operator_time_zone (singleton, override_time_zone)
		VALUES (TRUE, ${override})
		ON CONFLICT (singleton) DO UPDATE
		SET override_time_zone = EXCLUDED.override_time_zone, updated_at = now()
	`;
}

export async function readPendingOperatorTimeZoneProposal(sql: SqlLike = getSql()): Promise<PendingOperatorTimeZoneProposal | null> {
	await ensureOperatorTimeZoneTable(sql);
	const rows = await sql`
		SELECT proposal_thread_id, proposal_message_id
		FROM operator_time_zone
		WHERE singleton = TRUE AND proposal_message_at IS NOT NULL
	` as Array<{ proposal_message_id: string; proposal_thread_id: string }>;
	return rows[0]
		? { messageId: rows[0].proposal_message_id, threadId: rows[0].proposal_thread_id }
		: null;
}

export async function readPendingOperatorTimeZoneNotification(sql: SqlLike = getSql()): Promise<PendingOperatorTimeZoneNotification | null> {
	await ensureOperatorTimeZoneTable(sql);
	const rows = await sql`
		SELECT notification_thread_id, notification_message_id, notification_override_time_zone
		FROM operator_time_zone
		WHERE singleton = TRUE AND notification_message_id IS NOT NULL
	` as Array<{
		notification_message_id: string;
		notification_override_time_zone: string | null;
		notification_thread_id: string;
	}>;
	return rows[0]
		? {
				messageId: rows[0].notification_message_id,
				overrideTimeZone: rows[0].notification_override_time_zone,
				threadId: rows[0].notification_thread_id,
			}
		: null;
}

export async function clearPendingOperatorTimeZoneNotification(
	threadId: string,
	messageId: string,
	sql: SqlLike = getSql(),
): Promise<void> {
	await ensureOperatorTimeZoneTable(sql);
	await sql`
		UPDATE operator_time_zone
		SET notification_thread_id = NULL,
			notification_message_id = NULL,
			notification_override_time_zone = NULL,
			updated_at = now()
		WHERE singleton = TRUE
			AND notification_thread_id = ${threadId}
			AND notification_message_id = ${messageId}
	`;
}

export async function clearOperatorTimeZoneConversation(sql: SqlLike = getSql()): Promise<void> {
	await ensureOperatorTimeZoneTable(sql);
	await sql`
		UPDATE operator_time_zone
		SET proposal_time_zone = NULL,
			proposal_thread_id = NULL,
			proposal_message_id = NULL,
			proposal_message_at = NULL,
			last_message_thread_id = NULL,
			last_message_id = NULL,
			last_message_at = NULL,
			updated_at = now()
		WHERE singleton = TRUE
	`;
}

export async function saveOperatorTimeZoneProposal(
	timeZone: string | null,
	threadId: string,
	messageId: string,
	messageAt: Date,
	sql: SqlLike = getSql(),
): Promise<boolean> {
	const proposal = timeZone === null ? null : timeZone.trim();
	if (proposal !== null && !isIanaTimeZone(proposal)) {
		throw new Error(`Invalid operator time zone: "${proposal}".`);
	}
	if (!threadId || !messageId)
		throw new Error('Operator time zone proposals require source thread and message IDs.');
	if (!Number.isFinite(messageAt.getTime()))
		throw new Error('Operator time zone proposals require a valid source message timestamp.');

	await ensureOperatorTimeZoneTable(sql);
	const rows = await sql`
		UPDATE operator_time_zone
		SET proposal_time_zone = ${proposal},
			proposal_thread_id = ${threadId},
			proposal_message_id = ${messageId},
			proposal_message_at = ${messageAt},
			updated_at = now()
		WHERE singleton = TRUE
			AND last_message_thread_id = ${threadId}
			AND last_message_id = ${messageId}
			AND last_message_at = ${messageAt}
			AND notification_message_id IS NULL
		RETURNING proposal_time_zone
	`;
	return rows.length === 1;
}

export async function consumePendingOperatorTimeZoneChange(
	threadId: string,
	messageId: string,
	messageAt: Date,
	confirm: boolean,
	sql: SqlLike = getSql(),
): Promise<ConsumedOperatorTimeZoneChange | null> {
	if (!threadId || !messageId || !Number.isFinite(messageAt.getTime()))
		return null;
	await ensureOperatorTimeZoneTable(sql);
	const rows = await sql`
		WITH previous AS (
			SELECT proposal_time_zone, proposal_thread_id, proposal_message_at
			FROM operator_time_zone
			WHERE singleton = TRUE
				AND notification_message_id IS NULL
				AND (last_message_at IS NULL OR ${messageAt} > last_message_at)
			FOR UPDATE
		), changed AS (
			UPDATE operator_time_zone AS state
			SET override_time_zone = CASE
					WHEN ${confirm}
						AND previous.proposal_message_at IS NOT NULL
						AND previous.proposal_thread_id = ${threadId}
					THEN previous.proposal_time_zone
					ELSE state.override_time_zone
				END,
				proposal_time_zone = NULL,
				proposal_thread_id = NULL,
				proposal_message_id = NULL,
				proposal_message_at = NULL,
				last_message_thread_id = ${threadId},
				last_message_id = ${messageId},
				last_message_at = ${messageAt},
				notification_thread_id = CASE
					WHEN ${confirm}
						AND previous.proposal_message_at IS NOT NULL
						AND previous.proposal_thread_id = ${threadId}
					THEN ${threadId}
				END,
				notification_message_id = CASE
					WHEN ${confirm}
						AND previous.proposal_message_at IS NOT NULL
						AND previous.proposal_thread_id = ${threadId}
					THEN ${messageId}
				END,
				notification_override_time_zone = CASE
					WHEN ${confirm}
						AND previous.proposal_message_at IS NOT NULL
						AND previous.proposal_thread_id = ${threadId}
					THEN previous.proposal_time_zone
				END,
				updated_at = now()
			FROM previous
			WHERE state.singleton = TRUE
			RETURNING
				previous.proposal_message_at IS NOT NULL AS consumed_proposal,
				${confirm}
					AND previous.proposal_message_at IS NOT NULL
					AND previous.proposal_thread_id = ${threadId} AS applied,
				previous.proposal_time_zone
		)
		SELECT consumed_proposal, applied, proposal_time_zone
		FROM changed
	` as Array<{
		applied: boolean;
		consumed_proposal: boolean;
		proposal_time_zone: string | null;
	}>;
	const row = rows[0];
	return row
		? {
				applied: row.applied,
				consumedProposal: row.consumed_proposal,
				overrideTimeZone: row.applied ? row.proposal_time_zone : null,
			}
		: null;
}
