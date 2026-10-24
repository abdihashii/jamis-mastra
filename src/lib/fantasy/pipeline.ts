import type { MemoryStorage } from '@mastra/core/storage';
import type { FantasyEditorialObserver } from '../../mastra/workflows/prepare-fantasy-recap';
import type { FantasyConfig } from './config';
import type { CoordinatorResult } from './coordinator';
import type { EditorialOutcome } from './editorial-loop';
import type { GenerationAttemptRef } from './generation-state';
import type { NflCalendarProof, NflReportingWindow } from './nfl-calendar';
import type { EvidenceOptions, RecapEvidencePacket } from './recap-evidence';
import type { SqlLike } from './recaps';
import type { SavedReportReference } from './runs';
import type { SavedReportReceipt } from './saved-report-delivery';
import { randomUUID } from 'node:crypto';
import { createGenerationCapture } from './generation-capture';
import { blockGenerationAttempt, claimGenerationAttempt, getGenerationRun, markGenerationNotified, recoverGenerationAttempt } from './generation-runs';
import { GENERATION_LIMITS, GENERATION_VERSION, generationSummary } from './generation-state';
import { parseNflCalendarProof } from './nfl-calendar';
import { collectRecapEvidence } from './recap-evidence';
import { ensureFantasyRecapsTable, recordApprovedReport } from './recaps';
import { claimSavedReportRetry, ensureFantasyRunsTable, expireStaleLeases, getRun, getSavedReportState, markSavedReportNotified, pauseSavedReportDelivery, recoverSavedReport, savedPartStatus } from './runs';
import { buildSavedReport, parseSavedReport } from './saved-report';
import { readSavedReportReceipt } from './saved-report-delivery';

export interface PipelineDeps {
	sql: SqlLike;
	memory: Pick<MemoryStorage, 'getThreadById' | 'listMessages'> | null;
	prepare: (packet: RecapEvidencePacket, signal: AbortSignal, observer: FantasyEditorialObserver) => Promise<EditorialOutcome>;
	publish: (ref: SavedReportReference, token: string, signal?: AbortSignal) => Promise<{ receipt: SavedReportReceipt }>;
	readNfl?: EvidenceOptions['readNfl'];
	sleeper?: EvidenceOptions['sleeper'];
	now?: () => Date;
	signal?: AbortSignal;
	notify: (text: string) => Promise<void>;
	legacyRetry: (week: number) => Promise<CoordinatorResult>;
}

/** Safe summaries only: never return packets, rejected prose, scopes, tokens or debug payloads. */
export type PipelineResult = CoordinatorResult & {
	reason?: string;
	generatorVersion?: typeof GENERATION_VERSION;
	attemptId?: string;
	reportId?: string;
	counts?: { nfl: number; drafts: number; reviews: number };
};

function calendarIdentity(proof: NflCalendarProof): string {
	// Provider ordering and a later verification time do not change the frozen reporting period.
	return JSON.stringify({ ...proof, retrievedAtUtc: undefined, games: [...proof.games].sort((a, b) => a.id.localeCompare(b.id)) });
}

/** One production composition shared by schedule and the trusted local CLI. */
export async function runRecapPipeline(request: {
	config: FantasyConfig;
	season: number;
	week: number;
	window: NflReportingWindow | (() => Promise<NflReportingWindow>);
	traceId?: string;
	restartAttemptId?: string;
}, deps: PipelineDeps): Promise<PipelineResult> {
	const { config, week } = request;
	const scope = { leagueId: config.sleeperLeagueId, groupId: config.sendblueGroupId, season: request.season, week };
	const sql = deps.sql;
	const enteredAt = performance.now();
	let reference: GenerationAttemptRef | null = null;
	let token: string | null = null;
	let publication: { ref: SavedReportReference; token: string } | null = null;
	let publicationInvoked = false;
	const safe = (outcome: CoordinatorResult['outcome'], reason?: string): PipelineResult => ({ outcome, week, generatorVersion: GENERATION_VERSION, ...(reason ? { reason } : {}) });
	async function summary(reason?: string): Promise<PipelineResult> {
		const state = await getGenerationRun(scope, sql);
		if (!state)
			return safe('failed', reason ?? 'generation_unavailable');
		const value = generationSummary(state.generation);
		return { ...safe('failed', reason ?? value.reasonCode ?? 'generation_blocked'), attemptId: value.attemptId, counts: value.counts };
	}
	async function notice(ref: GenerationAttemptRef): Promise<void> {
		try {
			if (await markGenerationNotified(ref, sql)) {
				await deps.notify(`[fantasy-recap] week ${week} generation is held. Inspect debug-export --week ${week} --attempt-id ${ref.attemptId}; restart --week ${week} --attempt-id ${ref.attemptId} explicitly grants a new attempt. Nothing was published.`);
			}
		} catch { /* A notification failure never resets the attempt or authorizes publication. */ }
	}
	async function deliveryNotice(ref: SavedReportReference): Promise<void> {
		try {
			const state = await markSavedReportNotified(ref, sql);
			if (!state)
				return;
			const index = state.progress.parts.findIndex(attempts => savedPartStatus(attempts) === 'unknown');
			const attempt = index < 0 ? null : state.progress.parts[index]!.at(-1);
			const selector = `--week ${week} --report-id ${ref.reportId}`;
			const action = attempt
				? `Check the group: confirm-sent ${selector} --part ${index + 1} --attempt-id ${attempt.id} records receipt only; if absent, retry ${selector} --operator-verified-absent --part ${index + 1} --attempt-id ${attempt.id}.`
				: `An explicit retry ${selector} is required to continue the held report.`;
			await deps.notify(`[fantasy-recap] week ${week} delivery is held. ${action} Accepted parts will not be repeated.`);
		} catch { /* Notification failure cannot change an effect receipt or cause another send. */ }
	}
	try {
		await ensureFantasyRunsTable(sql);
		await ensureFantasyRecapsTable(sql);
		for (const interrupted of await expireStaleLeases(scope.leagueId, new Date(), 'legacy_delivery_interrupted', sql)) {
			if (interrupted.status === 'delivery_unknown') {
				try {
					await deps.notify(`[fantasy-recap] week ${interrupted.fantasyWeek} legacy delivery is unknown. Check the group before confirm-sent or an explicitly verified-absent retry.`);
				} catch { /* Notification failure cannot authorize another delivery. */ }
			}
		}
		const [row] = await sql`SELECT saved_report, part_delivery, editorial_attempt FROM fantasy_recap_runs WHERE league_id = ${scope.leagueId} AND fantasy_week = ${week}` as Array<{ saved_report: unknown; part_delivery: unknown; editorial_attempt: unknown }>;
		const legacy = await getRun(scope.leagueId, week, sql);
		// Saved artifacts are routed before evidence, NFL research or writer/editor composition.
		if (row && (row.saved_report != null || row.part_delivery != null)) {
			if (request.restartAttemptId)
				return safe('failed', 'restart_has_publication');
			const report = parseSavedReport(row.saved_report);
			if (report.scope.leagueId !== scope.leagueId || report.scope.groupId !== scope.groupId || report.scope.season !== scope.season || report.scope.week !== week)
				return safe('failed', 'saved_report_scope_mismatch');
			const ref = { ...scope, reportId: report.id };
			await recoverSavedReport(ref, sql);
			const saved = await getSavedReportState(ref, sql);
			if (!saved)
				return safe('failed', 'saved_report_unavailable');
			if (saved.status === 'sent')
				return { ...safe('noop-already-sent'), reportId: report.id };
			if (saved.status === 'delivery_unknown' || saved.progress.recoveryRequired) {
				await deliveryNotice(ref);
				return { ...safe('blocked-delivery-unknown'), reportId: report.id };
			}
			const retryToken = randomUUID();
			if (!await claimSavedReportRetry(ref, retryToken, new Date(Date.now() + GENERATION_LIMITS.leaseMs), { source: 'automatic' }, sql))
				return { ...safe('blocked-active-claim'), reportId: report.id };
			publication = { ref, token: retryToken };
			publicationInvoked = true;
			const { receipt } = await deps.publish(ref, retryToken, deps.signal);
			await deliveryNotice(ref);
			return { ...safe(receipt.status === 'blocked' ? 'blocked-active-claim' : receipt.status), reportId: report.id };
		}
		if (row?.editorial_attempt != null)
			await getGenerationRun(scope, sql);
		if (legacy?.status === 'sent')
			return safe('noop-already-sent');
		if (legacy?.status === 'delivery_unknown')
			return safe('blocked-delivery-unknown');
		if (legacy?.finalText) {
			if (request.restartAttemptId)
				return safe('failed', 'restart_has_publication');
			return deps.legacyRetry(week);
		}
		await recoverGenerationAttempt(scope, sql);
		const prior = await getGenerationRun(scope, sql);
		if (prior?.generation.current.phase === 'blocked' && !request.restartAttemptId) {
			await notice({ ...scope, attemptId: prior.generation.current.id });
			return summary();
		}
		const restarting = request.restartAttemptId && prior?.generation.current.id === request.restartAttemptId
			? prior.generation.current
			: null;
		if (restarting && !restarting.calendarProof)
			return safe('failed', 'reporting_calendar_missing');
		const reporting = typeof request.window === 'function' ? await request.window() : request.window;
		if (reporting.status !== 'ready') {
			const unclosed = ['calendar_period_unclosed', 'calendar_games_unclosed'].includes(reporting.reason);
			return safe(unclosed ? 'noop-no-completed-week' : 'failed', reporting.reason);
		}
		const window = reporting.window;
		let calendarProof = parseNflCalendarProof(reporting.source, scope.season, week, window);
		if (restarting) {
			const retained = parseNflCalendarProof(restarting.calendarProof, scope.season, week, restarting.window);
			if (JSON.stringify(window) !== JSON.stringify(restarting.window)
				|| calendarIdentity(calendarProof) !== calendarIdentity(retained)) {
				return safe('failed', 'reporting_calendar_changed');
			}
			calendarProof = retained;
		}
		token = randomUUID();
		reference = await claimGenerationAttempt(scope, window, token, request.traceId ?? null, sql, request.restartAttemptId, calendarProof);
		if (!reference)
			return safe('blocked-active-claim', 'generation_claim_unavailable');
		const owned = await getGenerationRun(scope, sql);
		if (!owned || owned.claimToken !== token || owned.generation.current.id !== reference.attemptId)
			return safe('blocked-active-claim', 'generation_claim_unobservable');
		// Conservative monotonic budget includes claim/acknowledgement time. DB guards remain authoritative.
		const remaining = Math.min(GENERATION_LIMITS.workMs, Date.parse(owned.generation.current.workDeadlineAtUtc) - Date.parse(owned.nowUtc)) - Math.ceil(performance.now() - enteredAt);
		if (remaining <= 0)
			throw new Error('generation_work_deadline');
		const signal = AbortSignal.any([AbortSignal.timeout(remaining), ...(deps.signal ? [deps.signal] : [])]);
		const capture = createGenerationCapture(reference, token, sql);
		signal.throwIfAborted();
		const packet = await collectRecapEvidence({ config, week, window, calendarProof }, {
			memory: deps.memory,
			sleeper: deps.sleeper,
			now: deps.now,
			abortSignal: signal,
			readNfl: deps.readNfl
				? capture.readNfl(async (...args) => {
						signal.throwIfAborted();
						const result = await deps.readNfl!(...args);
						signal.throwIfAborted();
						return result;
					})
				: undefined,
		});
		capture.assertHealthy();
		await capture.packet(packet);
		signal.throwIfAborted();
		if (!packet.admission.canDraft || packet.status === 'blocked') {
			const current = await getGenerationRun(scope, sql);
			const retryable = current?.generation.current.paidWorkAtUtc === null;
			await blockGenerationAttempt(reference, token, 'evidence_blocked', sql, retryable);
			if (!retryable)
				await notice(reference);
			return summary('evidence_blocked');
		}
		const outcome = await deps.prepare(packet, signal, capture.observer);
		capture.assertHealthy();
		if (outcome.status !== 'approved') {
			await blockGenerationAttempt(reference, token, 'editorial_blocked', sql);
			await notice(reference);
			return summary('editorial_blocked');
		}
		signal.throwIfAborted();
		const report = buildSavedReport(packet, outcome);
		publication = { ref: { ...scope, reportId: report.id }, token };
		if (!await recordApprovedReport(report, token, sql))
			throw new Error('generation_approval_unavailable');
		publicationInvoked = true;
		const { receipt } = await deps.publish(publication.ref, token, signal);
		await deliveryNotice(publication.ref);
		return { ...safe(receipt.status === 'blocked' ? 'blocked-active-claim' : receipt.status), attemptId: reference.attemptId, reportId: report.id, counts: { nfl: packet.nfl.length, ...outcome.counts } };
	} catch {
		if (publication) {
			try {
				await pauseSavedReportDelivery(publication.ref, publication.token, null, sql);
			} catch { /* An unobserved effect remains conservative under the durable owner. */ }
			const receipt = await readSavedReportReceipt(publication.ref, sql);
			await deliveryNotice(publication.ref);
			if (receipt.totalParts || publicationInvoked)
				return { ...safe(receipt.status === 'blocked' ? publicationInvoked ? 'delivery_unknown' : 'blocked-active-claim' : receipt.status, 'publication_interrupted'), reportId: publication.ref.reportId };
		}
		if (reference && token) {
			try {
				await blockGenerationAttempt(reference, token, deps.signal?.aborted ? 'generation_canceled' : 'generation_unavailable', sql);
				await notice(reference);
				return await summary();
			} catch { /* A lost owner/acknowledgement cannot grant another budget or a second send. */ }
		}
		return safe('failed', 'recap_pipeline_unavailable');
	}
}
