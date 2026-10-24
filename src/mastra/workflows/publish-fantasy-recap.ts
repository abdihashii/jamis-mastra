import type { Mastra } from '@mastra/core';

import { createTool } from '@mastra/core/tools';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import type { SendOutcome } from '../../lib/fantasy/deliver';
import type { SqlLike } from '../../lib/fantasy/recaps';
import type { SavedReportReference } from '../../lib/fantasy/runs';
import type { SavedReportReceipt } from '../../lib/fantasy/saved-report-delivery';
import type { BroadcasterResult } from '../agents/broadcaster';
import type { SpecialistFailure, SpecialistHandback } from '../agents/specialist-handback';

import { FANTASY_BROADCAST_LIMITS, FANTASY_PUBLICATION_WORKFLOW_ID, SAVED_REPORT_DELIVERY_TOOL_ID, savedReportDeliveryArgumentsSchema } from '../../lib/fantasy/broadcast-policy';
import { getSavedReportState, pauseSavedReportDelivery } from '../../lib/fantasy/runs';
import { dispatchSavedReport, readSavedReportReceipt } from '../../lib/fantasy/saved-report-delivery';
import { broadcasterResultSchema, createBroadcaster } from '../agents/broadcaster';
import { specialistHandbackSchema } from '../agents/specialist-handback';
import { StorageFreeRuntime } from '../storage-free-runtime';
import {
	createSpecialistContext,
	createSpecialistInvocation,
	normalizeSpecialistResult,
	requireBroadcasterDeliveryAuthority,
	revokeSpecialistAuthority,
} from '../tools/invoke-specialist';

const receiptSchema = z.object({
	status: z.enum(['sent', 'failed', 'delivery_unknown', 'blocked']),
	reportId: z.string(),
	acceptedParts: z.number().int().min(0).max(3),
	totalParts: z.number().int().min(0).max(3),
	reason: z.string().max(100).optional(),
}).strict();
export interface PublicationResult {
	contribution: SpecialistHandback<BroadcasterResult> | SpecialistFailure<BroadcasterResult>;
	receipt: SavedReportReceipt;
}
function failed(): SpecialistFailure<never> {
	return {
		case: 'failed',
		reason: 'Specialist execution or handback validation failed.',
		progress: null,
	};
}

const publicationHandbackSchema = z.union([
	specialistHandbackSchema(broadcasterResultSchema),
	z.object({ case: z.literal('failed'), reason: z.literal('Specialist execution or handback validation failed.'), progress: z.null() }).strict(),
]);

/** Server-internal publication only. Preparation/preview never receives this procedure or grant. */
export function createFantasyPublicationProcedure(parent: Mastra, config: {
	leagueId: string;
	groupId: string;
	sql: SqlLike;
	sendExact: (groupId: string, text: string) => Promise<SendOutcome>;
}) {
	const mastra = new StorageFreeRuntime(parent);
	const { leagueId, groupId, sql, sendExact } = config;
	return async (value: SavedReportReference, claimToken: string, callerSignal?: AbortSignal): Promise<PublicationResult> => {
		const reference = Object.freeze({ ...value });
		const denied = (reason: string): PublicationResult => ({ contribution: failed(), receipt: {
			status: 'blocked',
			reportId: reference.reportId,
			acceptedParts: 0,
			totalParts: 0,
			reason,
		} });
		if (reference.leagueId !== leagueId || reference.groupId !== groupId)
			return denied('publication_scope_mismatch');
		try {
			const state = await getSavedReportState(reference, sql);
			if (!state || state.status !== 'started' || state.claimToken !== claimToken || !state.leaseCurrent
				|| state.progress.recoveryRequired || state.progress.operationId !== null) {
				return { contribution: failed(), receipt: await readSavedReportReceipt(reference, sql, 'publication_not_eligible') };
			}
			if (callerSignal?.aborted) {
				await pauseSavedReportDelivery(reference, claimToken, null, sql);
				return { contribution: failed(), receipt: await readSavedReportReceipt(reference, sql, 'canceled') };
			}
		} catch {
			return denied('saved_report_unavailable');
		}
		const signal = AbortSignal.any([AbortSignal.timeout(FANTASY_BROADCAST_LIMITS.callMs), ...(callerSignal ? [callerSignal] : [])]);
		let delivery: Promise<SavedReportReceipt> | undefined;
		let receipt: SavedReportReceipt | undefined;
		let contribution: PublicationResult['contribution'] = failed();
		const requestContext = createSpecialistContext({ kind: 'workflow', id: FANTASY_PUBLICATION_WORKFLOW_ID });
		let cancel: (() => void) | undefined;
		let canceled: Promise<unknown> | undefined;
		try {
			const tool = createTool({
				id: SAVED_REPORT_DELIVERY_TOOL_ID,
				description: 'Perform the single application-bound saved-report delivery operation and return its authoritative receipt.',
				inputSchema: savedReportDeliveryArgumentsSchema,
				outputSchema: receiptSchema,
				execute: async (_, context) => {
					requireBroadcasterDeliveryAuthority(context);
					// Memoize before dispatch can enter any asynchronous owner or sender.
					delivery ??= Promise.resolve().then(() => dispatchSavedReport(reference, claimToken, sql, sendExact, context.abortSignal ?? signal));
					return delivery;
				},
			});
			const invocation = createSpecialistInvocation({
				id: 'invoke_broadcaster',
				agent: createBroadcaster({ mastra, deliveryTool: tool }),
				inputSchema: z.object({}).strict(),
				resultSchema: broadcasterResultSchema,
				allowedCallers: [{ kind: 'workflow', id: FANTASY_PUBLICATION_WORKFLOW_ID }],
				project: () => 'Perform the one bound saved-report delivery operation. Copy reportId and status from its receipt into your structured handback.',
				validate: async (handback) => {
					const actual = delivery && await delivery;
					if (handback.case === 'completed' || handback.case === 'partial') {
						if (!actual || handback.result.reportId !== actual.reportId || handback.result.status !== actual.status)
							throw new Error('Broadcaster contribution does not match delivery.');
					}
				},
			});
			const nativeStep = createStep(invocation, { retries: 0 });
			const workflow = createWorkflow({
				id: FANTASY_PUBLICATION_WORKFLOW_ID,
				mastra,
				inputSchema: z.object({ reportId: z.literal(reference.reportId) }).strict(),
				outputSchema: publicationHandbackSchema,
				retryConfig: { attempts: 0, delay: 0 },
				options: { autoRestartActiveRuns: false, shouldPersistSnapshot: () => false },
			}).then(createStep({
				id: 'publish_saved_fantasy_report',
				inputSchema: z.object({ reportId: z.literal(reference.reportId) }).strict(),
				outputSchema: publicationHandbackSchema,
				retries: 0,
				execute: async (context) => {
					try {
						const result = await normalizeSpecialistResult(broadcasterResultSchema, () => nativeStep.execute({
							...context,
							inputData: {},
							bail: () => { throw new Error('Private publication cannot bail'); },
						}));
						return publicationHandbackSchema.parse(result);
					} catch {
						return failed();
					}
				},
			})).commit();
			const run = await workflow.createRun({ shouldPersistSnapshot: () => false });
			cancel = () => {
				canceled ??= run.cancel().catch(() => undefined);
			};
			signal.addEventListener('abort', cancel, { once: true });
			if (!signal.aborted) {
				contribution = await normalizeSpecialistResult(broadcasterResultSchema, async () => {
					const result = await run.start({ inputData: { reportId: reference.reportId }, requestContext });
					if (result.status !== 'success')
						throw new Error('Publication contribution unavailable');
					return result.result;
				});
			}
		} catch { /* The model contribution never establishes or erases a transport effect. */ } finally {
			if (cancel)
				signal.removeEventListener('abort', cancel);
			revokeSpecialistAuthority(requestContext);
			await canceled;
			try {
				if (delivery)
					receipt = await delivery;
				if (!delivery || signal.aborted)
					await pauseSavedReportDelivery(reference, claimToken, null, sql);
			} catch { /* Reconcile existing durable state without ever starting another dispatch. */ }
		}
		const reconciled = await readSavedReportReceipt(reference, sql, contribution.case === 'failed' ? 'broadcaster_unavailable' : undefined);
		// A later unavailable read cannot retract an already observed authoritative result.
		return { contribution, receipt: receipt?.status === 'sent' || (receipt && reconciled.status === 'blocked') ? receipt : reconciled };
	};
}
