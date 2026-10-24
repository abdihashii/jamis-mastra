import type { Mastra } from '@mastra/core/mastra';

import { createTool, noopObserve } from '@mastra/core/tools';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { SqlLike } from '../../../lib/operator-time-zone';
import type { LinearReplyInput, LinearReplyOptions } from '../linear-reply';

import { claimLinearCreate, finishLinearCreate, notifyLinearOutcome, postLinearCreateProposal, readLinearContinuation, readLinearProposal, receiveLinearMessage } from '../../../lib/linear/linear-proposals';
import { boundaryModel } from '../../agents/__tests__/specialist-boundary.fixture';
import { createPersonalAccountsAgent } from '../../agents/personal-accounts-agent';
import { createSpecialistContext, createSpecialistInvocation, normalizeSpecialistResult } from '../../tools/invoke-specialist';
import { createLinearReplyProcedure, LINEAR_REPLY_WORKFLOW_ID } from '../linear-reply';

export function linearReplyFixtureInput(): LinearReplyInput {
	return {
		dmId: randomUUID(),
		sessionId: randomUUID(),
		sourceMessageId: randomUUID(),
		assignment: 'Create the exact issue, then prepare a plain text reply linking it.',
		source: { subject: 'Synthetic request', from: 'public@example.com', date: '2026-10-08T00:00:00.000Z', body: 'PRIVATE_ARCHITECTURE_SENTINEL. Please track the public example.' },
		operation: { id: randomUUID(), teamId: '11111111-1111-4111-8111-111111111111', title: 'Synthetic example', description: 'Controlled fixture only.', stateId: '44444444-4444-4444-8444-444444444444', stateName: 'Backlog' },
	};
}

/** No provider or channel client is installed in this fixture. */
export async function runLinearReplyFixture(mastra: Mastra, sql: SqlLike) {
	const input = linearReplyFixtureInput();
	const issueUrl = 'https://linear.app/fixture/issue/JAM-999';
	let evidenceReads = 0;
	let drafts = 0;
	let proposalPosts = 0;
	let mutationAttempts = 0;
	const inspectSource = createTool({
		id: 'read_reply_source',
		description: 'Read the already retained synthetic source evidence.',
		inputSchema: z.object({}).strict(),
		outputSchema: z.object({ available: z.literal(true) }),
		execute: async () => {
			evidenceReads++;
			return { available: true as const };
		},
	});
	const agent = createPersonalAccountsAgent({
		mastra,
		tools: { read_reply_source: inspectSource },
		model: boundaryModel([
			{ tool: 'read_reply_source', input: {} },
			{ handback: { case: 'completed', result: { replyText: `I have recorded this at ${issueUrl}.` } } },
		]),
	});
	const resultSchema = z.object({ replyText: z.string().min(1).max(12000) }).strict();
	const invoke = createSpecialistInvocation({
		id: 'invoke_personal_accounts',
		agent,
		inputSchema: z.object({ assignment: z.string(), source: z.string(), issueUrl: z.url() }).strict(),
		resultSchema,
		allowedCallers: [{ kind: 'workflow', id: LINEAR_REPLY_WORKFLOW_ID }],
		project: assignment => JSON.stringify(assignment),
	});
	const options: LinearReplyOptions = {
		sql,
		getActiveSession: async () => input.sessionId,
		prepareReply: async (prepared, context) => {
			drafts++;
			assert.deepEqual(prepared.source, input.source);
			const result = await normalizeSpecialistResult(resultSchema, async () => invoke.execute!({
				assignment: prepared.assignment,
				source: JSON.stringify(prepared.source),
				issueUrl: prepared.outcome.url,
			}, {
				requestContext: createSpecialistContext({ kind: 'workflow', id: LINEAR_REPLY_WORKFLOW_ID }),
				abortSignal: context.abortSignal,
				tracingContext: context.tracingContext,
				workflow: {
					workflowId: LINEAR_REPLY_WORKFLOW_ID,
					runId: context.runId,
					state: {},
					setState: () => { throw new Error('No fixture state write'); },
					suspend: async () => { throw new Error('No fixture suspension'); },
				},
				observe: noopObserve,
			}));
			assert.equal(result.case, 'completed');
			if (result.case !== 'completed')
				throw new Error('Fixture draft unavailable');
			return result.result.replyText;
		},
	};
	const first = createLinearReplyProcedure(options);
	mastra.addWorkflow(first.workflow);
	await receiveLinearMessage(input.dmId, input.sourceMessageId, sql);
	const continuation = await first.start(input);
	assert.equal(
		await postLinearCreateProposal(
			input.operation,
			input.dmId,
			input.sessionId,
			input.sourceMessageId,
			async () => {
				proposalPosts++;
			},
			sql,
			continuation,
		),
		true,
	);
	const proposal = await readLinearProposal(input.dmId, sql);
	assert.ok(proposal);
	const decisionMessageId = randomUUID();
	await receiveLinearMessage(input.dmId, decisionMessageId, sql);
	assert.equal(await claimLinearCreate(proposal, input.sessionId, decisionMessageId, true, sql), true);
	mutationAttempts++;
	await finishLinearCreate(input.operation.id, { status: 'succeeded', identifier: 'JAM-999', url: issueUrl }, sql);
	await notifyLinearOutcome((await readLinearProposal(input.dmId, sql))!, async () => {}, sql);
	assert.equal(await readLinearProposal(input.dmId, sql), null);
	assert.ok(await readLinearContinuation(input.operation.id, sql));
	const recovered = createLinearReplyProcedure(options);
	// addWorkflow ignores an existing registry key; the stored workflow ID stays canonical.
	mastra.addWorkflow(recovered.workflow, `fixture-recovery-${randomUUID()}`);
	const result = await recovered.resume(input.operation.id, decisionMessageId);
	assert.equal(result?.status, 'suspended');
	const prepared = recovered.result(result);
	assert.ok(prepared.status === 'ready');
	assert.equal(prepared.url, issueUrl);
	const replay = await recovered.resume(input.operation.id, decisionMessageId);
	assert.deepEqual(recovered.result(replay), recovered.result(result));
	assert.equal((await recovered.acknowledge(input.operation.id, decisionMessageId))?.status, 'success');
	assert.equal(drafts, 1);
	assert.equal(evidenceReads, 1);
	assert.equal(proposalPosts, 1);
	assert.equal(mutationAttempts, 1);
	return {
		storedOutcomeRecovery: true,
		typedDraft: true,
		drafts,
		evidenceReads,
		proposalPosts,
		controlledMutationAttempts: mutationAttempts,
		duplicateMutations: 0,
		outboundMessages: 0,
	};
}
