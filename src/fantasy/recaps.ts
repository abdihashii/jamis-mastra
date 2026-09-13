import type { WeekFacts } from './analysis';

import { SQL } from 'bun';

import process from 'node:process';

export interface RecapGenerationRecord {
	leagueId: string;
	fantasyWeek: number;
	generatorVersion: string;
	model: string;
	finalText: string;
	facts: WeekFacts;
}

/** A Bun SQL client or a test shim with the same tagged-template call shape. */
export interface SqlLike {
	(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
}

let cachedSql: SQL | null = null;

export function getFantasySql(): SQL {
	cachedSql ??= new SQL(process.env.DATABASE_URL ?? 'postgres://localhost:5432/mastra');
	return cachedSql;
}

/**
 * Idempotent DDL; called at boot of any process that touches generation.
 * Version history is the guarantee: one row per (league, week, version, model),
 * so regenerating after a prompt change appends instead of overwriting. Send
 * lifecycle lands as its own table in stage 4.
 */
export async function ensureFantasyRecapsTable(sql: SqlLike = getFantasySql()): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS fantasy_recap_generations (
			league_id TEXT NOT NULL,
			fantasy_week INTEGER NOT NULL,
			generator_version TEXT NOT NULL,
			model TEXT NOT NULL,
			final_text TEXT NOT NULL,
			facts JSONB NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			PRIMARY KEY (league_id, fantasy_week, generator_version, model)
		)
	`;
}

/** Upserts preview history without participating in the delivery state machine. */
export async function recordGeneration(record: RecapGenerationRecord, sql: SqlLike = getFantasySql()): Promise<void> {
	await sql`
		INSERT INTO fantasy_recap_generations (league_id, fantasy_week, generator_version, model, final_text, facts)
		VALUES (${record.leagueId}, ${record.fantasyWeek}, ${record.generatorVersion}, ${record.model}, ${record.finalText}, ${record.facts})
		ON CONFLICT (league_id, fantasy_week, generator_version, model)
		DO UPDATE SET final_text = EXCLUDED.final_text, facts = EXCLUDED.facts, updated_at = now()
	`;
}

/** Stores claimed text and generation history atomically; stale runners write neither. */
export async function recordClaimedGeneration(record: RecapGenerationRecord, claimToken: string, sql: SqlLike = getFantasySql()): Promise<boolean> {
	const rows = await sql`
		WITH claimed AS (
			UPDATE fantasy_recap_runs
			SET final_text = ${record.finalText}, updated_at = now()
			WHERE league_id = ${record.leagueId} AND fantasy_week = ${record.fantasyWeek}
				AND status = 'started' AND claim_token = ${claimToken}
			RETURNING 1
		)
		INSERT INTO fantasy_recap_generations (league_id, fantasy_week, generator_version, model, final_text, facts)
		SELECT ${record.leagueId}, ${record.fantasyWeek}, ${record.generatorVersion}, ${record.model}, ${record.finalText}, ${record.facts}
		FROM claimed
		ON CONFLICT (league_id, fantasy_week, generator_version, model)
		DO UPDATE SET final_text = EXCLUDED.final_text, facts = EXCLUDED.facts, updated_at = now()
		RETURNING 1
	`;
	return rows.length === 1;
}

export interface RecapGenerationRow {
	model: string;
	generator_version: string;
	final_text: string;
	created_at: string;
	updated_at: string;
}

export async function listGenerations(
	leagueId: string,
	fantasyWeek: number,
	sql: SqlLike = getFantasySql(),
): Promise<RecapGenerationRow[]> {
	return await sql`
		SELECT generator_version, model, final_text, created_at, updated_at
		FROM fantasy_recap_generations
		WHERE league_id = ${leagueId} AND fantasy_week = ${fantasyWeek}
		ORDER BY updated_at DESC
	` as RecapGenerationRow[];
}
