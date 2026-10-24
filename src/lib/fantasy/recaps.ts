import type { SavedReport } from './saved-report';
import type { WeekFacts } from './week-facts';

import { SQL } from 'bun';
import process from 'node:process';
import { getSavedReportState, initialSavedReportProgress } from './runs';
import { parseSavedReport, SAVED_REPORT_VERSION } from './saved-report';

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
	if (record.generatorVersion === SAVED_REPORT_VERSION)
		throw new Error('reserved_report_version');
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
		SELECT
			${record.leagueId},
			${record.fantasyWeek},
			${record.generatorVersion},
			${record.model},
			${record.finalText},
			${record.facts}
		WHERE
			NOT EXISTS (
				SELECT
					1
				FROM
					fantasy_recap_runs
				WHERE
					league_id = ${record.leagueId}
					AND fantasy_week = ${record.fantasyWeek}
					AND (
						saved_report IS NOT NULL
						OR part_delivery IS NOT NULL
					)
			)
		ON CONFLICT (league_id, fantasy_week, generator_version, model) DO UPDATE
		SET
			final_text = EXCLUDED.final_text,
			facts = EXCLUDED.facts,
			updated_at = now()
	`;
}

/** Stores claimed text and generation history atomically; stale runners write neither. */
export async function recordClaimedGeneration(
	record: RecapGenerationRecord,
	claimToken: string,
	sql: SqlLike = getFantasySql(),
): Promise<boolean> {
	if (record.generatorVersion === SAVED_REPORT_VERSION)
		return false;
	const rows = await sql`
		WITH
			claimed AS (
				UPDATE fantasy_recap_runs
				SET
					final_text = ${record.finalText},
					updated_at = now()
				WHERE
					league_id = ${record.leagueId}
					AND fantasy_week = ${record.fantasyWeek}
					AND status = 'started'
					AND claim_token = ${claimToken}
					AND saved_report IS NULL
					AND part_delivery IS NULL
				RETURNING
					1
			)
		INSERT INTO
			fantasy_recap_generations (
				league_id,
				fantasy_week,
				generator_version,
				model,
				final_text,
				facts
			)
		SELECT
			${record.leagueId},
			${record.fantasyWeek},
			${record.generatorVersion},
			${record.model},
			${record.finalText},
			${record.facts}
		FROM
			claimed
		ON CONFLICT (league_id, fantasy_week, generator_version, model) DO UPDATE
		SET
			final_text = EXCLUDED.final_text,
			facts = EXCLUDED.facts,
			updated_at = now()
		RETURNING
			1
	`;
	return rows.length === 1;
}

/** Server-internal save, after buildSavedReport validated both gates; an ID is not authority. */
export async function recordApprovedReport(value: SavedReport, claimToken: string, sql: SqlLike): Promise<boolean> {
	const report = parseSavedReport(value);
	const { scope } = report;
	const text = report.parts.join('\n\n');
	const history = { version: report.version, report };
	try {
		const rows = await sql`
			WITH
				eligible AS MATERIALIZED (
					SELECT
						league_id,
						fantasy_week,
						lease_expires_at
					FROM
						fantasy_recap_runs
					WHERE
						league_id = ${scope.leagueId}
						AND fantasy_week = ${scope.week}
						AND status = 'started'
						AND claim_token = ${claimToken}
						AND lease_expires_at > clock_timestamp()
						AND (
							(
								saved_report IS NULL
								AND part_delivery IS NULL
								AND final_text IS NULL
							)
							OR (
								saved_report = ${report}
								AND part_delivery IS NOT NULL
								AND final_text = ${text}
							)
						)
					FOR UPDATE
				),
				history AS (
					INSERT INTO
						fantasy_recap_generations (
							league_id,
							fantasy_week,
							generator_version,
							model,
							final_text,
							facts
						)
					SELECT
						${scope.leagueId},
						${scope.week},
						${report.version},
						${report.writer.model},
						${text},
						${history}
					FROM
						eligible
					WHERE
						eligible.lease_expires_at > clock_timestamp()
					ON CONFLICT (league_id, fantasy_week, generator_version, model) DO UPDATE
					SET
						updated_at = fantasy_recap_generations.updated_at
					WHERE
						fantasy_recap_generations.final_text = EXCLUDED.final_text
						AND fantasy_recap_generations.facts = EXCLUDED.facts
					RETURNING
						1
				)
			UPDATE fantasy_recap_runs target
			SET
				saved_report = ${report},
				part_delivery = COALESCE(target.part_delivery, ${initialSavedReportProgress(report)}),
				final_text = ${text},
				updated_at = now()
			FROM
				eligible,
				history
			WHERE
				target.league_id = eligible.league_id
				AND target.fantasy_week = eligible.fantasy_week
			RETURNING
				1
		`;
		return rows.length === 1;
	} catch {
		// A lost acknowledgement can hide a committed atomic save. Check both owners, never rewrite.
		try {
			const state = await getSavedReportState({ ...scope, reportId: report.id }, sql);
			if (!state || state.claimToken !== claimToken || !state.leaseCurrent || state.status !== 'started')
				return false;
			const rows = await sql`
				SELECT
					1
				FROM
					fantasy_recap_generations
				WHERE
					league_id = ${scope.leagueId}
					AND fantasy_week = ${scope.week}
					AND generator_version = ${report.version}
					AND model = ${report.writer.model}
					AND final_text = ${text}
					AND facts = ${history}
			`;
			return rows.length === 1;
		} catch {
			return false;
		}
	}
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
		SELECT
			generator_version,
			model,
			final_text,
			created_at,
			updated_at
		FROM
			fantasy_recap_generations
		WHERE
			league_id = ${leagueId}
			AND fantasy_week = ${fantasyWeek}
		ORDER BY
			updated_at DESC
	` as RecapGenerationRow[];
}
