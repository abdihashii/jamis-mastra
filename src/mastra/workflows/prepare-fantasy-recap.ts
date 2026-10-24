import type { Mastra } from '@mastra/core';
import type { EditorialOutcome } from '../../lib/fantasy/editorial-loop';
import type { RecapEvidencePacket } from '../../lib/fantasy/recap-evidence';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { editorialDraftSchema } from '../../lib/fantasy/editorial';
import { editorialOutcomeSchema, editorialReviewSchema, runEditorialLoop } from '../../lib/fantasy/editorial-loop';
import { FANTASY_EDITORIAL_LIMITS, FANTASY_EDITORIAL_WORKFLOW_ID } from '../../lib/fantasy/editorial-policy';
import { createFantasyFootballEditor } from '../agents/fantasy-football-editor';
import { createFantasyFootballPundit } from '../agents/fantasy-football-pundit';
import { specialistHandbackSchema } from '../agents/specialist-handback';
import { StorageFreeRuntime } from '../storage-free-runtime';
import { createSpecialistContext, createSpecialistInvocation, revokeSpecialistAuthority } from '../tools/invoke-specialist';

/** Private native execution only. No root registration, snapshots, scheduled restart, memory or delivery. */
export function createFantasyEditorialProcedure(parent: Mastra) {
	const mastra = new StorageFreeRuntime(parent);
	const inputSchema = z.object({ assignment: z.string().min(1).max(FANTASY_EDITORIAL_LIMITS.assignmentChars) }).strict();
	const allowedCallers = [{ kind: 'workflow', id: FANTASY_EDITORIAL_WORKFLOW_ID }] as const;
	const writer = createSpecialistInvocation({
		id: 'invoke_fantasy_pundit',
		agent: createFantasyFootballPundit({ mastra }),
		inputSchema,
		resultSchema: editorialDraftSchema,
		allowedCallers,
		project: input => input.assignment,
	});
	const editor = createSpecialistInvocation({
		id: 'invoke_fantasy_editor',
		agent: createFantasyFootballEditor(mastra),
		inputSchema,
		resultSchema: editorialReviewSchema,
		allowedCallers,
		project: input => input.assignment,
	});
	const writerStep = createStep(writer, { retries: 0 });
	const editorStep = createStep(editor, { retries: 0 });
	return async (packet: RecapEvidencePacket, signal?: AbortSignal): Promise<EditorialOutcome> => {
		let outcome: EditorialOutcome | undefined;
		const counts = { drafts: 0, reviews: 0 };
		const unavailable = (reason: string): EditorialOutcome => ({ status: 'blocked', evidenceId: packet.id, reason, candidateId: null, counts, issues: [] });
		if (signal?.aborted)
			return unavailable('canceled');
		const step = createStep({
			id: 'prepare_fantasy_editorial_candidate',
			inputSchema: z.object({ evidenceId: z.literal(packet.id) }).strict(),
			outputSchema: editorialOutcomeSchema,
			retries: 0,
			execute: async (context) => {
				outcome = await runEditorialLoop(packet, {
					write: async (assignment, abortSignal) => {
						counts.drafts++;
						// The native tool-step adapter retains the engine's actual workflow/caller context.
						const result = await writerStep.execute({
							...context,
							inputData: { assignment },
							abortSignal,
							bail: () => { throw new Error('Private invocation cannot bail'); },
						});
						const parsed = specialistHandbackSchema(editorialDraftSchema).safeParse(result);
						if (!parsed.success || parsed.data.case !== 'completed')
							throw new Error('Writer contribution unavailable');
						return parsed.data.result;
					},
					review: async (assignment, abortSignal) => {
						counts.reviews++;
						const result = await editorStep.execute({
							...context,
							inputData: { assignment },
							abortSignal,
							bail: () => { throw new Error('Private invocation cannot bail'); },
						});
						const parsed = specialistHandbackSchema(editorialReviewSchema).safeParse(result);
						if (!parsed.success || parsed.data.case !== 'completed')
							throw new Error('Reviewer contribution unavailable');
						return parsed.data.result;
					},
				}, { abortSignal: context.abortSignal });
				return outcome;
			},
		});
		const workflow = createWorkflow({
			id: FANTASY_EDITORIAL_WORKFLOW_ID,
			mastra,
			inputSchema: step.inputSchema,
			outputSchema: editorialOutcomeSchema,
			retryConfig: { attempts: 0, delay: 0 },
			options: { autoRestartActiveRuns: false, shouldPersistSnapshot: () => false },
		}).then(step).commit();
		const requestContext = createSpecialistContext({ kind: 'workflow', id: FANTASY_EDITORIAL_WORKFLOW_ID });
		let cancel: (() => void) | undefined;
		let canceled: Promise<unknown> | undefined;
		try {
			const run = await workflow.createRun({ shouldPersistSnapshot: () => false });
			cancel = () => {
				canceled ??= run.cancel().catch(() => undefined);
			};
			signal?.addEventListener('abort', cancel, { once: true });
			if (signal?.aborted)
				return unavailable('canceled');
			const result = await run.start({ inputData: { evidenceId: packet.id }, requestContext });
			if (signal?.aborted)
				return unavailable('canceled');
			if (result.status !== 'success' || !outcome || JSON.stringify(result.result) !== JSON.stringify(outcome))
				return unavailable('candidate_workflow_failed');
			return outcome;
		} catch {
			return unavailable(signal?.aborted ? 'canceled' : 'candidate_workflow_failed');
		} finally {
			if (cancel)
				signal?.removeEventListener('abort', cancel);
			await canceled;
			revokeSpecialistAuthority(requestContext);
		}
	};
}
