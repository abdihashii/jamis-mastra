import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { SqlLike } from './recaps';
import type { SavedReportReference } from './runs';
import type { SavedReportReceipt } from './saved-report-delivery';

interface PartSelection { part: number; attemptId: string }
export type SavedReportRecoveryRequest = { week: number; reportId: string } & (
	| { command: 'retry'; absent?: PartSelection }
	| { command: 'confirm-sent'; part: number; attemptId: string }
);
export interface SavedReportRecoveryResult {
	status: SavedReportReceipt['status'] | 'confirmed';
	week: number;
	reportId: string;
	acceptedParts: number;
	totalParts: number;
	recoveryRequired: boolean;
	unresolved: PartSelection | null;
}

/** A partial new selector must never fall through to legacy whole-message recovery. */
export function parseSavedReportRecovery(command: string, flags: string[]): SavedReportRecoveryRequest | null {
	if (!flags.some(flag => ['--report-id', '--part', '--attempt-id'].includes(flag.split('=')[0]!)))
		return null;
	const invalid = () => {
		throw new Error('invalid_saved_report_recovery_arguments');
	};
	if (command !== 'retry' && command !== 'confirm-sent')
		return invalid();
	const values = new Map<string, string>();
	for (let index = 0; index < flags.length; index++) {
		const flag = flags[index]!;
		if (!['--week', '--report-id', '--part', '--attempt-id', '--operator-verified-absent'].includes(flag)
			|| values.has(flag)) {
			return invalid();
		}
		if (flag === '--operator-verified-absent') {
			values.set(flag, 'true');
		} else {
			const value = flags[++index];
			if (!value || value.startsWith('--'))
				return invalid();
			values.set(flag, value);
		}
	}
	const week = values.get('--week') ?? '';
	const reportId = values.get('--report-id') ?? '';
	const part = values.get('--part');
	const attemptId = values.get('--attempt-id');
	const absent = values.has('--operator-verified-absent');
	if (!/^(?:[1-9]|1\d|2[0-2])$/.test(week) || !/^report-[a-f0-9]{64}$/.test(reportId)
		|| (part !== undefined && !/^[1-3]$/.test(part))
		|| (attemptId !== undefined && !z.uuid().safeParse(attemptId).success)
		|| (part !== undefined) !== (attemptId !== undefined)) {
		return invalid();
	}
	if (command === 'confirm-sent') {
		if (absent || part === undefined || attemptId === undefined)
			return invalid();
		return { command, week: Number(week), reportId, part: Number(part), attemptId };
	}
	if (absent !== (part !== undefined))
		return invalid();
	return {
		command,
		week: Number(week),
		reportId,
		...(absent ? { absent: { part: Number(part), attemptId: attemptId! } } : {}),
	};
}

export function unavailableSavedReportRecovery(request: SavedReportRecoveryRequest): SavedReportRecoveryResult {
	return {
		status: 'blocked',
		week: request.week,
		reportId: request.reportId,
		acceptedParts: 0,
		totalParts: 0,
		recoveryRequired: true,
		unresolved: null,
	};
}

/** No source lookup or publication composition belongs on the record-only confirmation path. */
export async function runSavedReportRecovery(
	request: SavedReportRecoveryRequest,
	deps: {
		leagueId: string;
		groupId: string;
		sql: SqlLike;
		publish?: (reference: SavedReportReference, claimToken: string) => Promise<{ receipt: SavedReportReceipt }>;
	},
): Promise<SavedReportRecoveryResult> {
	const unavailable = unavailableSavedReportRecovery(request);
	let readResult = async () => unavailable;
	try {
		const runs = await import('./runs');
		const { readSavedReportReceipt } = await import('./saved-report-delivery');
		const { sql } = deps;
		const ref = await runs.findSavedReportReference(
			deps.leagueId,
			request.week,
			deps.groupId,
			request.reportId,
			sql,
		);
		if (!ref)
			return unavailable;
		const summarize = async (
			receipt: SavedReportReceipt,
			confirmed = false,
		): Promise<SavedReportRecoveryResult> => {
			let recoveryRequired = receipt.status !== 'sent';
			let unresolved: PartSelection | null = null;
			try {
				const state = await runs.getSavedReportState(ref, sql);
				if (state) {
					recoveryRequired = state.progress.recoveryRequired;
					const index = state.progress.parts.findIndex(attempts => ['sending', 'unknown'].includes(runs.savedPartStatus(attempts)));
					const attempt = state.progress.parts[index]?.at(-1);
					if (attempt)
						unresolved = { part: index + 1, attemptId: attempt.id };
				}
			} catch { /* An unreadable hold cannot authorize a retry. */ }
			return {
				status: confirmed && receipt.status !== 'sent' ? 'confirmed' : receipt.status,
				week: request.week,
				reportId: request.reportId,
				acceptedParts: receipt.acceptedParts,
				totalParts: receipt.totalParts,
				recoveryRequired,
				unresolved,
			};
		};
		readResult = async () => summarize(await readSavedReportReceipt(ref, sql));
		await runs.recoverSavedReport(ref, sql);
		if (request.command === 'confirm-sent') {
			const before = await runs.getSavedReportState(ref, sql);
			if (!before)
				return unavailable;
			const totalParts = before.report.parts.length;
			let acceptedParts = before.progress.parts.filter(attempts => runs.savedPartStatus(attempts) === 'accepted').length;
			let confirmed = false;
			try {
				confirmed = await runs.confirmSavedReportPart(ref, request.part, request.attemptId, sql);
				if (confirmed)
					acceptedParts++;
			} catch {
				const state = await runs.getSavedReportState(ref, sql);
				confirmed = state?.progress.parts[request.part - 1]?.some(attempt => attempt.id === request.attemptId
					&& attempt.state === 'accepted' && attempt.source === 'operator') ?? false;
				if (state)
					acceptedParts = Math.max(acceptedParts, state.progress.parts.filter(attempts => runs.savedPartStatus(attempts) === 'accepted').length);
			}
			let receipt = await readSavedReportReceipt(ref, sql);
			if (confirmed && receipt.totalParts === 0) {
				// An acknowledged confirmation cannot disappear just because a later read is unavailable.
				receipt = { status: acceptedParts === totalParts ? 'sent' : 'failed', reportId: ref.reportId, acceptedParts, totalParts };
			}
			return summarize(confirmed ? receipt : { ...receipt, status: 'blocked' }, confirmed);
		}
		if (!deps.publish)
			return summarize({ ...await readSavedReportReceipt(ref, sql), status: 'blocked' });
		const claimToken = randomUUID();
		try {
			await runs.claimSavedReportRetry(ref, claimToken, new Date(Date.now() + 15 * 60 * 1000), {
				source: 'operator',
				...(request.absent ? { absent: request.absent } : {}),
			}, sql);
		} catch { /* A committed claim may have lost its acknowledgement. Reconcile this token, never claim again. */ }
		const state = await runs.getSavedReportState(ref, sql);
		if (!state || state.status !== 'started' || state.claimToken !== claimToken || !state.leaseCurrent
			|| state.progress.recoveryRequired || state.progress.operationId !== null) {
			return summarize({ ...await readSavedReportReceipt(ref, sql), status: 'blocked' });
		}
		let receipt: SavedReportReceipt;
		try {
			({ receipt } = await deps.publish(ref, claimToken));
		} catch {
			// Only an unreserved owned claim can be stopped; a started effect remains authoritative.
			await runs.pauseSavedReportDelivery(ref, claimToken, null, sql);
			receipt = await readSavedReportReceipt(ref, sql);
		}
		return summarize(receipt);
	} catch {
		return readResult().catch(() => unavailable);
	}
}
