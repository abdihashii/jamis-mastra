import type { SendOutcome } from './deliver';
import type { SqlLike } from './recaps';
import type { SavedReportReference } from './runs';

import {
	beginSavedReportPart,
	getSavedReportState,
	pauseSavedReportDelivery,
	recordSavedReportPart,
	recoverSavedReport,
	reserveSavedReportDelivery,
	savedPartStatus,
} from './runs';

export interface SavedReportReceipt {
	status: 'sent' | 'failed' | 'delivery_unknown' | 'blocked';
	reportId: string;
	acceptedParts: number;
	totalParts: number;
	reason?: string;
}

/** Contribution text is never a delivery receipt. Only this existing-row state is authoritative. */
export async function readSavedReportReceipt(reference: SavedReportReference, sql: SqlLike, reason?: string): Promise<SavedReportReceipt> {
	try {
		const state = await getSavedReportState(reference, sql);
		if (state) {
			const outstanding = state.progress.parts.some(attempts => ['sending', 'unknown'].includes(savedPartStatus(attempts)));
			return {
				status: state.status === 'started' ? outstanding ? 'delivery_unknown' : 'blocked' : state.status,
				reportId: state.report.id,
				acceptedParts: state.progress.parts.filter(attempts => savedPartStatus(attempts) === 'accepted').length,
				totalParts: state.report.parts.length,
				...(reason ? { reason } : {}),
			};
		}
	} catch { /* Never export SQL, report text, target IDs or raw transport errors. */ }
	return { status: 'blocked', reportId: reference.reportId, acceptedParts: 0, totalParts: 0, reason: 'saved_report_unavailable' };
}

/** Server-internal operation. The later checked Broadcaster binds its reference, claim and exact sender. */
export async function dispatchSavedReport(
	reference: SavedReportReference,
	claimToken: string,
	sql: SqlLike,
	sendExact: (groupId: string, text: string) => Promise<SendOutcome>,
	signal?: AbortSignal,
): Promise<SavedReportReceipt> {
	let operationId: string | null = null;
	let transportAttempted = false;
	try {
		await recoverSavedReport(reference, sql);
		if (signal?.aborted)
			return readSavedReportReceipt(reference, sql, 'canceled');
		operationId = await reserveSavedReportDelivery(reference, claimToken, sql);
		if (!operationId)
			return readSavedReportReceipt(reference, sql, 'delivery_not_eligible');
		for (let count = 0; count < 3; count++) {
			if (signal?.aborted) {
				await pauseSavedReportDelivery(reference, claimToken, operationId, sql);
				return readSavedReportReceipt(reference, sql, 'canceled');
			}
			const part = await beginSavedReportPart(reference, claimToken, operationId, sql);
			if (!part)
				return readSavedReportReceipt(reference, sql, 'delivery_not_eligible');
			if (signal?.aborted) {
				await recordSavedReportPart(reference, part.part, part.attemptId, { kind: 'failed' }, sql, true);
				return readSavedReportReceipt(reference, sql, 'canceled');
			}
			// An in-flight request may already be accepted. Await its bounded sender and record truth even after
			// cancellation.
			let outcome: SendOutcome;
			try {
				transportAttempted = true;
				outcome = await sendExact(reference.groupId, part.text);
			} catch {
				outcome = { kind: 'unknown', error: 'saved_part_transport_unobservable' };
			}
			if (outcome?.kind !== 'failed' && (outcome?.kind !== 'sent' || typeof outcome.handle !== 'string'
				|| !outcome.handle.trim() || outcome.handle.length > 500)) {
				outcome = { kind: 'unknown', error: 'saved_part_transport_unobservable' };
			}
			const recorded = await recordSavedReportPart(reference, part.part, part.attemptId, outcome, sql);
			if (!recorded) {
				const receipt = await readSavedReportReceipt(reference, sql, 'part_receipt_unobservable');
				return receipt.status === 'sent' ? receipt : { ...receipt, status: 'delivery_unknown' };
			}
			if (outcome.kind !== 'sent')
				return readSavedReportReceipt(reference, sql);
			const state = await getSavedReportState(reference, sql);
			if (state?.status !== 'started')
				return readSavedReportReceipt(reference, sql);
		}
		return readSavedReportReceipt(reference, sql);
	} catch {
		if (operationId) {
			try {
				const state = await getSavedReportState(reference, sql);
				const index = state?.progress.parts.findIndex(attempts => attempts.some(attempt => attempt.operationId === operationId && attempt.state === 'sending')) ?? -1;
				const attempt = state?.progress.parts[index]?.find(attempt => attempt.operationId === operationId && attempt.state === 'sending');
				if (attempt)
					await recordSavedReportPart(reference, index + 1, attempt.id, { kind: 'unknown' }, sql);
				else
					await pauseSavedReportDelivery(reference, claimToken, operationId, sql);
			} catch { /* Durable dispatch marker remains conservative across a restart. */ }
		}
		const receipt = await readSavedReportReceipt(reference, sql, 'delivery_state_unobservable');
		return transportAttempted && receipt.status !== 'sent' ? { ...receipt, status: 'delivery_unknown' } : receipt;
	}
}
