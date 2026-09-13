import { SQL } from 'bun';

import process from 'node:process';

import { isIanaTimeZone } from './time';

export interface SqlLike {
	(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
}

export interface OperatorTimeZone {
	timeZone: string;
	source: 'override' | 'default';
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

	const promise = sql`
		CREATE TABLE IF NOT EXISTS operator_time_zone (
			singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
			override_time_zone TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`
		.then(() => undefined)
		.catch((error) => {
			tableReady.delete(sql);
			throw error;
		});
	tableReady.set(sql, promise);
	return promise;
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
