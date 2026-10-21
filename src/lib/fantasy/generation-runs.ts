import type { ChatWindow } from './chat-archive';
import type { GenerationAttemptRef, GenerationCall, GenerationCallKind, GenerationDebugOutput, GenerationState } from './generation-state';
import type { NflCalendarProof } from './nfl-calendar';
import type { RecapEvidencePacket } from './recap-evidence';
import type { SqlLike } from './recaps';
import type { RunStatus } from './runs';
import type { SavedReport, SavedReportScope } from './saved-report';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildEditorialCandidate } from './editorial';
import { editorialReviewSchema } from './editorial-loop';
import { FANTASY_EDITORIAL_LIMITS } from './editorial-policy';
import { GENERATION_LIMITS, generationReference, initialGenerationState, parseGenerationState, purgeExpiredGenerationDebug, retainedGenerationDebug } from './generation-state';
import { parseNflCalendarProof } from './nfl-calendar';
import { hasNewerActiveRun, withFantasyLeagueLock } from './runs';
import { buildSavedReport } from './saved-report';

const safeCode = z.string().regex(/^[a-z][a-z0-9_:.-]{0,99}$/);
const sameScope = (a: SavedReportScope, b: SavedReportScope) => a.leagueId === b.leagueId && a.groupId === b.groupId && a.season === b.season && a.week === b.week;
const counter = { nfl: 'nfl', writer: 'drafts', reviewer: 'reviews' } as const;
const lateCall = (call: GenerationCall) => call.settledAtUtc !== null && Date.parse(call.settledAtUtc) >= Date.parse(call.deadlineAtUtc);

/** Private owner state, never a monitoring, agent-tool or HTTP response. */
export interface GenerationRunState {
	generation: GenerationState;
	status: RunStatus;
	claimToken: string | null;
	leaseStamp: string | null;
	leaseCurrent: boolean;
	nowUtc: string;
	publicationExists: boolean;
}

export async function getGenerationRun(scope: SavedReportScope, sql: SqlLike): Promise<GenerationRunState | null> {
	const [row] = await sql`
		SELECT
			editorial_attempt,
			status,
			claim_token,
			lease_expires_at::text AS lease_stamp,
			lease_expires_at > clock_timestamp() AS lease_current,
			clock_timestamp() AS db_now,
			(
				saved_report IS NOT NULL
				OR part_delivery IS NOT NULL
				OR final_text IS NOT NULL
				OR send_attempt_at IS NOT NULL
			) AS publication_exists
		FROM
			fantasy_recap_runs
		WHERE
			league_id = ${scope.leagueId}
			AND fantasy_week = ${scope.week}
	` as Array<{ editorial_attempt: unknown; status: RunStatus; claim_token: string | null; lease_stamp: string | null; lease_current: boolean; db_now: Date; publication_exists: boolean }>;
	if (!row || row.editorial_attempt == null)
		return null;
	const generation = parseGenerationState(row.editorial_attempt);
	if (!sameScope(generation.current.scope, scope) || !['started', 'failed', 'delivery_unknown', 'sent'].includes(row.status)
		|| (generation.current.phase !== 'approved' && row.publication_exists)
		|| (['blocked', 'source_retryable'].includes(generation.current.phase) && row.status !== 'failed')
		|| (['collecting', 'editorial'].includes(generation.current.phase) && row.status !== 'started')) {
		throw new Error('invalid_generation_state');
	}
	return { generation, status: row.status, claimToken: row.claim_token, leaseStamp: row.lease_stamp, leaseCurrent: row.lease_current === true, nowUtc: row.db_now.toISOString(), publicationExists: row.publication_exists };
}

function owned(before: GenerationRunState | null, ref: GenerationAttemptRef, token: string): before is GenerationRunState {
	return !!before && before.generation.current.id === ref.attemptId && before.status === 'started'
		&& before.claimToken === token && before.leaseCurrent && !before.publicationExists
		&& ['collecting', 'editorial'].includes(before.generation.current.phase)
		&& before.nowUtc < before.generation.current.workDeadlineAtUtc;
}

async function replaceGeneration(before: GenerationRunState, next: GenerationState, sql: SqlLike, options: {
	status?: RunStatus;
	live?: boolean;
	diagnostic?: boolean;
} = {}): Promise<boolean> {
	const after = parseGenerationState(next);
	const scope = before.generation.current.scope;
	if (options.diagnostic) {
		const rows = await sql`
			UPDATE fantasy_recap_runs
			SET
				editorial_attempt = ${after}
			WHERE
				league_id = ${scope.leagueId}
				AND fantasy_week = ${scope.week}
				AND editorial_attempt = ${before.generation}
			RETURNING
				1
		`;
		return rows.length === 1;
	}
	const status = options.status ?? before.status;
	const rows = await sql`
		UPDATE fantasy_recap_runs
		SET
			editorial_attempt = ${after},
			status = ${status},
			last_error = ${status === 'failed' ? `generation:${after.current.reasonCode}` : null},
			failure_stage = ${status === 'failed' ? 'model' : null},
			failure_classification = ${status === 'failed' ? 'execution_failed' : null},
			updated_at = now()
		WHERE
			league_id = ${scope.leagueId}
			AND fantasy_week = ${scope.week}
			AND editorial_attempt = ${before.generation}
			AND status = ${before.status}
			AND claim_token IS NOT DISTINCT FROM ${before.claimToken}
			AND lease_expires_at IS NOT DISTINCT FROM ${before.leaseStamp}::timestamptz
			AND saved_report IS NULL
			AND part_delivery IS NULL
			AND final_text IS NULL
			AND send_attempt_at IS NULL
			AND (
				${options.live ?? false} = false
				OR lease_expires_at > clock_timestamp()
			)
		RETURNING
			1
	`;
	return rows.length === 1;
}

/** A fresh token/id is minted by the application, never reconstructed to resume uncertain work. */
export async function claimGenerationAttempt(
	scope: SavedReportScope,
	window: ChatWindow,
	token: string,
	traceId: string | null,
	sql: SqlLike,
	expectedBlockedAttempt?: string,
	calendarProof?: NflCalendarProof,
): Promise<GenerationAttemptRef | null> {
	if (!token.trim())
		return null;
	try {
		return await withFantasyLeagueLock(scope.leagueId, sql, async (tx) => {
			if (await hasNewerActiveRun(scope.leagueId, scope.week, tx))
				return null;
			const [clock] = await tx`SELECT clock_timestamp() AS db_now` as { db_now: Date }[];
			if (Date.parse(window.endAtUtc) > clock!.db_now.getTime())
				return null;
			const initial = initialGenerationState(
				scope,
				window,
				randomUUID(),
				clock!.db_now.toISOString(),
				calendarProof,
			);
			const lease = new Date(clock!.db_now.getTime() + GENERATION_LIMITS.leaseMs).toISOString();
			if (!expectedBlockedAttempt) {
				const inserted = await tx`
					INSERT INTO
						fantasy_recap_runs (
							league_id,
							fantasy_week,
							status,
							claim_token,
							lease_expires_at,
							latest_attempt_trace_id,
							editorial_attempt
						)
					VALUES
						(
							${scope.leagueId},
							${scope.week},
							'started',
							${token},
							${lease},
							${traceId},
							${initial}
						)
					ON CONFLICT (league_id, fantasy_week) DO NOTHING
					RETURNING
						1
				`;
				if (inserted.length === 1)
					return generationReference(initial);
			}
			const before = await getGenerationRun(scope, tx);
			if (before) {
				if (before.status !== 'failed' || before.publicationExists
					|| (expectedBlockedAttempt
						? before.generation.current.id !== expectedBlockedAttempt || before.generation.current.phase !== 'blocked'
						: before.generation.current.phase !== 'source_retryable')) {
					return null;
				}
				if (expectedBlockedAttempt) {
					const previous = before.generation.current;
					if (previous.calendarProof === undefined || initial.current.calendarProof === undefined
						|| previous.window.startAtUtc !== initial.current.window.startAtUtc
						|| previous.window.endAtUtc !== initial.current.window.endAtUtc) {
						return null;
					}
					const priorProof = parseNflCalendarProof(
						previous.calendarProof,
						scope.season,
						scope.week,
						previous.window,
					);
					const nextProof = parseNflCalendarProof(
						initial.current.calendarProof,
						scope.season,
						scope.week,
						initial.current.window,
					);
					if (JSON.stringify(priorProof) !== JSON.stringify(nextProof))
						return null;
				}
				initial.prior = [...before.generation.prior, before.generation.current];
				initial.debug = { ...before.generation.debug, ...initial.debug };
				const checked = parseGenerationState(initial);
				const rows = await tx`
					UPDATE fantasy_recap_runs
					SET
						editorial_attempt = ${checked},
						status = 'started',
						claim_token = ${token},
						lease_expires_at = ${lease},
						latest_attempt_trace_id = ${traceId},
						last_error = NULL,
						failure_stage = NULL,
						failure_classification = NULL,
						updated_at = now()
					WHERE
						league_id = ${scope.leagueId}
						AND fantasy_week = ${scope.week}
						AND editorial_attempt = ${before.generation}
						AND status = 'failed'
						AND saved_report IS NULL
						AND part_delivery IS NULL
						AND final_text IS NULL
						AND send_attempt_at IS NULL
					RETURNING
						1
				`;
				return rows.length === 1 ? generationReference(checked) : null;
			}
			if (expectedBlockedAttempt)
				return null;
			// Only an unsaved, definitely failed legacy row can enter the new contract.
			const rows = await tx`
				UPDATE fantasy_recap_runs
				SET
					editorial_attempt = ${initial},
					status = 'started',
					claim_token = ${token},
					lease_expires_at = ${lease},
					latest_attempt_trace_id = ${traceId},
					last_error = NULL,
					failure_stage = NULL,
					failure_classification = NULL,
					updated_at = now()
				WHERE
					league_id = ${scope.leagueId}
					AND fantasy_week = ${scope.week}
					AND status = 'failed'
					AND editorial_attempt IS NULL
					AND saved_report IS NULL
					AND part_delivery IS NULL
					AND final_text IS NULL
					AND send_attempt_at IS NULL
				RETURNING
					1
			`;
			return rows.length === 1 ? generationReference(initial) : null;
		});
	} catch {
		// An uncertain claim acknowledgement never authorizes a paid call.
		return null;
	}
}

/** Call ordinals are expected by the caller: a recreated loop starting at one cannot resume a used budget. */
export async function reserveGenerationCall(ref: GenerationAttemptRef, token: string, kind: GenerationCallKind, ordinal: number, sql: SqlLike) {
	if (!['nfl', 'writer', 'reviewer'].includes(kind) || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > 3)
		return null;
	const enteredAt = performance.now();
	try {
		const reserved = await withFantasyLeagueLock(ref.leagueId, sql, async (tx) => {
			const before = await getGenerationRun(ref, tx);
			if (!owned(before, ref, token) || before.generation.current.calendarProof === undefined
				|| await hasNewerActiveRun(ref.leagueId, ref.week, tx)) {
				return null;
			}
			const next = structuredClone(before.generation);
			const current = next.current;
			const key = counter[kind];
			if (current.counts[key] + 1 !== ordinal || current.calls.some(call => call.state === 'reserved' || lateCall(call))
				|| (kind === 'nfl' && current.phase !== 'collecting') || (kind === 'reviewer' && (!current.candidateId || current.counts.reviews >= current.counts.drafts))) {
				return null;
			}
			if (kind !== 'nfl') {
				const bundle = retainedGenerationDebug(next, current.id, before.nowUtc);
				if (!bundle?.bundle.packetJson)
					return null;
				const packet = JSON.parse(bundle.bundle.packetJson) as RecapEvidencePacket;
				if (!packet.admission.canDraft || packet.status === 'blocked')
					return null;
				current.phase = 'editorial';
				current.editorialDeadlineAtUtc ??= new Date(Math.min(Date.parse(current.workDeadlineAtUtc), Date.parse(before.nowUtc) + FANTASY_EDITORIAL_LIMITS.totalMs)).toISOString();
				if (current.editorialDeadlineAtUtc <= before.nowUtc)
					return null;
			}
			current.paidWorkAtUtc ??= before.nowUtc;
			const deadline = kind === 'nfl'
				? current.workDeadlineAtUtc
				: new Date(Math.min(Date.parse(current.editorialDeadlineAtUtc!), Date.parse(before.nowUtc) + FANTASY_EDITORIAL_LIMITS.callMs)).toISOString();
			const call = { id: randomUUID(), kind, ordinal, state: 'reserved' as const, atUtc: before.nowUtc, deadlineAtUtc: deadline, settledAtUtc: null, code: null };
			current.calls.push(call);
			current.counts[key]++;
			if (!await replaceGeneration(before, next, tx, { live: true }))
				return null;
			return { id: call.id, remainingMs: Math.max(0, Date.parse(deadline) - Date.parse(before.nowUtc)) };
		});
		if (!reserved)
			return null;
		// Deduct the entire round trip conservatively, including a delayed COMMIT acknowledgement.
		const remainingMs = reserved.remainingMs - Math.ceil(performance.now() - enteredAt);
		return remainingMs > 0 ? { id: reserved.id, remainingMs } : null;
	} catch {
		// Losing this acknowledgement consumes the intent, not permission to reconstruct its dispatch.
		return null;
	}
}

export async function captureGenerationPacket(ref: GenerationAttemptRef, token: string, packet: RecapEvidencePacket, sql: SqlLike): Promise<boolean> {
	return withFantasyLeagueLock(ref.leagueId, sql, async (tx) => {
		const before = await getGenerationRun(ref, tx);
		if (!owned(before, ref, token))
			return false;
		const next = structuredClone(before.generation);
		const bundle = next.debug[ref.attemptId];
		if (!bundle || before.nowUtc >= next.current.debugExpiresAtUtc || !Object.isFrozen(packet))
			return false;
		const serialized = JSON.stringify(packet);
		if (bundle.packetJson !== null)
			return bundle.packetJson === serialized;
		bundle.packetJson = serialized;
		next.current.evidenceId = packet.id;
		return replaceGeneration(before, next, tx, { live: true });
	});
}

/** Data from a reserved call may arrive late, but cannot restore an owner, deadline or publication authority. */
export async function recordGenerationOutput(ref: GenerationAttemptRef, callId: string, contributionCase: GenerationDebugOutput['contributionCase'], value: unknown, sql: SqlLike, failureCode = 'execution_failed'): Promise<boolean> {
	if (!safeCode.safeParse(failureCode).success)
		return false;
	for (let retry = 0; retry < 3; retry++) {
		try {
			const saved = await withFantasyLeagueLock(ref.leagueId, sql, async (tx) => {
				const before = await getGenerationRun(ref, tx);
				if (!before)
					return false;
				const next = structuredClone(before.generation);
				const attempt = [next.current, ...next.prior].find(item => item.id === ref.attemptId);
				const call = attempt?.calls.find(item => item.id === callId);
				const bundle = next.debug[ref.attemptId];
				if (!attempt || !call || !bundle || before.nowUtc >= attempt.debugExpiresAtUtc)
					return false;
				const valueJson = value == null ? null : JSON.stringify(value);
				const existing = bundle.outputs.find(item => item.callId === callId);
				if (existing)
					return existing.valueJson === valueJson && existing.contributionCase === contributionCase;
				bundle.outputs.push({ callId, kind: call.kind, ordinal: call.ordinal, contributionCase, valueJson, atUtc: before.nowUtc });
				call.state = contributionCase === 'failed' ? 'failed' : 'completed';
				call.settledAtUtc = before.nowUtc;
				call.code = lateCall(call) ? 'call_deadline_exceeded' : contributionCase === 'completed' ? null : contributionCase === 'failed' ? failureCode : `contribution:${contributionCase}`;
				if (call.kind === 'writer' && attempt === next.current && ['collecting', 'editorial'].includes(attempt.phase)) {
					attempt.candidateId = null;
					if (contributionCase === 'completed' && !lateCall(call) && bundle.packetJson && value != null) {
						const built = buildEditorialCandidate(JSON.parse(bundle.packetJson), value);
						if (built.status === 'candidate')
							attempt.candidateId = built.candidate.id;
					}
				}
				return replaceGeneration(before, next, tx, { diagnostic: true });
			});
			return saved;
		} catch { /* Re-read a possibly committed output, never repeat the external call. */ }
	}
	return false;
}

export async function blockGenerationAttempt(ref: GenerationAttemptRef, token: string, reason: string, sql: SqlLike, sourceRetryable = false): Promise<boolean> {
	const code = safeCode.parse(reason);
	return withFantasyLeagueLock(ref.leagueId, sql, async (tx) => {
		const before = await getGenerationRun(ref, tx);
		if (!before || before.generation.current.id !== ref.attemptId || before.status !== 'started'
			|| before.claimToken !== token || !before.leaseCurrent || before.publicationExists
			|| !['collecting', 'editorial'].includes(before.generation.current.phase)) {
			return false;
		}
		const next = structuredClone(before.generation);
		if (sourceRetryable && (next.current.paidWorkAtUtc !== null || next.current.calls.length > 0))
			return false;
		next.current.phase = sourceRetryable ? 'source_retryable' : 'blocked';
		next.current.reasonCode = code;
		return replaceGeneration(before, next, tx, { status: 'failed', live: true });
	});
}

export async function recoverGenerationAttempt(scope: SavedReportScope, sql: SqlLike): Promise<void> {
	await withFantasyLeagueLock(scope.leagueId, sql, async (tx) => {
		const before = await getGenerationRun(scope, tx);
		if (!before || before.status !== 'started' || before.leaseCurrent || before.publicationExists)
			return;
		const next = structuredClone(before.generation);
		next.current.phase = 'blocked';
		next.current.reasonCode = 'generation_interrupted';
		await replaceGeneration(before, next, tx, { status: 'failed' });
	});
}

export async function markGenerationNotified(ref: GenerationAttemptRef, sql: SqlLike): Promise<boolean> {
	return withFantasyLeagueLock(ref.leagueId, sql, async (tx) => {
		const before = await getGenerationRun(ref, tx);
		if (!before || before.generation.current.id !== ref.attemptId || before.generation.current.notifiedAtUtc !== null)
			return false;
		const next = structuredClone(before.generation);
		next.current.notifiedAtUtc = before.nowUtc;
		return replaceGeneration(before, next, tx, { diagnostic: true });
	});
}

/** Read-only export lookup. Missing or expired payload never becomes an empty successful bundle. */
export async function readGenerationDebug(ref: GenerationAttemptRef, sql: SqlLike) {
	const before = await getGenerationRun(ref, sql);
	return before ? retainedGenerationDebug(before.generation, ref.attemptId, before.nowUtc) : null;
}

export async function findGenerationReference(leagueId: string, week: number, groupId: string, attemptId: string, sql: SqlLike): Promise<GenerationAttemptRef | null> {
	const [row] = await sql`SELECT editorial_attempt FROM fantasy_recap_runs WHERE league_id = ${leagueId} AND fantasy_week = ${week}` as { editorial_attempt: unknown }[];
	if (!row || row.editorial_attempt == null)
		return null;
	const state = parseGenerationState(row.editorial_attempt);
	const attempt = [state.current, ...state.prior].find(item => item.id === attemptId);
	return attempt && attempt.scope.leagueId === leagueId && attempt.scope.groupId === groupId && attempt.scope.week === week
		? { ...attempt.scope, attemptId }
		: null;
}

/** No report/history deletion: expiry clears only new private payloads, preserving every audit summary. */
export async function purgeGenerationDebug(sql: SqlLike): Promise<number> {
	const rows = await sql`SELECT league_id, fantasy_week, editorial_attempt FROM fantasy_recap_runs WHERE editorial_attempt IS NOT NULL` as { league_id: string; fantasy_week: number; editorial_attempt: unknown }[];
	let removed = 0;
	for (const row of rows) {
		const parsed = parseGenerationState(row.editorial_attempt);
		const scope = parsed.current.scope;
		if (scope.leagueId !== row.league_id || scope.week !== row.fantasy_week)
			throw new Error('invalid_generation_state');
		await withFantasyLeagueLock(scope.leagueId, sql, async (tx) => {
			const before = await getGenerationRun(scope, tx);
			if (!before)
				return;
			const next = purgeExpiredGenerationDebug(before.generation, before.nowUtc);
			const count = Object.keys(before.generation.debug).length - Object.keys(next.debug).length;
			if (count > 0 && await replaceGeneration(before, next, tx, { diagnostic: true }))
				removed += count;
		});
	}
	return removed;
}

function freeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Called under the same run lock by approved storage, not a model-authored approval flag. */
export function generationApprovalState(before: GenerationRunState, report: SavedReport): GenerationState | null {
	try {
		const next = parseGenerationState(before.generation);
		const meta = next.current;
		const bundle = next.debug[meta.id];
		if (meta.calendarProof === undefined || !before.leaseCurrent || before.status !== 'started' || before.publicationExists || meta.phase !== 'editorial'
			|| before.nowUtc >= meta.workDeadlineAtUtc || !meta.editorialDeadlineAtUtc || before.nowUtc >= meta.editorialDeadlineAtUtc
			|| !sameScope(meta.scope, report.scope) || meta.evidenceId !== report.evidenceId || meta.candidateId !== report.candidateId
			|| !bundle?.packetJson || meta.calls.some(call => lateCall(call) || (call.kind !== 'nfl' && call.state !== 'completed'))) {
			return null;
		}
		const packet = freeze(JSON.parse(bundle.packetJson)) as RecapEvidencePacket;
		const writer = bundle.outputs.find(output => output.kind === 'writer' && output.ordinal === meta.counts.drafts && output.contributionCase === 'completed');
		const reviewer = bundle.outputs.find(output => output.kind === 'reviewer' && output.ordinal === meta.counts.reviews && output.contributionCase === 'completed');
		if (!writer?.valueJson || !reviewer?.valueJson)
			return null;
		const built = buildEditorialCandidate(packet, JSON.parse(writer.valueJson));
		if (built.status !== 'candidate')
			return null;
		const review = editorialReviewSchema.parse(JSON.parse(reviewer.valueJson));
		const expected = buildSavedReport(packet, { status: 'approved', evidenceId: packet.id, candidate: built.candidate, review, counts: { drafts: meta.counts.drafts, reviews: meta.counts.reviews } });
		if (JSON.stringify(expected) !== JSON.stringify(report))
			return null;
		next.current.phase = 'approved';
		next.current.reportId = report.id;
		next.current.reasonCode = null;
		return parseGenerationState(next);
	} catch { return null; }
}
