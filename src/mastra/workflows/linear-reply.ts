import type { TracingContext } from '@mastra/core/observability';
import type { LinearProposal } from '../../lib/linear-proposals';
import type { SqlLike } from '../../lib/operator-time-zone';

import { MastraError } from '@mastra/core/error';
import { RequestContext } from '@mastra/core/request-context';
import { createStep, createWorkflow, createWorkflowStateReader } from '@mastra/core/workflows';
import { z } from 'zod';
import { linearCreateOperationSchema, linearCreateOutcomeSchema } from '../../lib/linear';
import { isLatestLinearMessage, linearContinuationSchema, linearDecisionSchema, readLinearContinuation } from '../../lib/linear-proposals';

export const LINEAR_REPLY_WORKFLOW_ID = 'prepare_linear_reply';
export const LINEAR_OUTCOME_WAIT_ID = 'await_linear_outcome';

export const linearReplyInputSchema = z.object({
	dmId: z.string().min(1),
	sessionId: z.string().min(1),
	sourceMessageId: z.string().min(1),
	assignment: z.string().min(1).max(4000),
	source: z.object({
		subject: z.string().max(998),
		from: z.string().max(998),
		date: z.iso.datetime(),
		body: z.string().min(1).max(4000),
	}).strict(),
	operation: linearCreateOperationSchema,
}).strict();
export type LinearReplyInput = z.infer<typeof linearReplyInputSchema>;

const createdSchema = linearCreateOutcomeSchema.extend({
	status: z.literal('succeeded'),
	identifier: linearCreateOutcomeSchema.shape.identifier.unwrap(),
	url: linearCreateOutcomeSchema.shape.url.unwrap(),
});
const waitResultSchema = z.discriminatedUnion('status', [
	createdSchema,
	z.object({ status: z.enum(['declined', 'failed', 'uncertain']) }).strict(),
]);
const replyResultSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('ready'), operationId: z.uuid(), identifier: z.string(), url: z.url(), draft: z.string().min(1).max(12000) }).strict(),
	z.object({ status: z.literal('partial'), operationId: z.uuid(), identifier: z.string(), url: z.url(), gap: z.literal('draft_unavailable') }).strict(),
	z.object({ status: z.literal('stopped'), operationId: z.uuid(), reason: z.enum(['declined', 'failed', 'uncertain']) }).strict(),
]);

interface Authority {
	runId: string;
	input: LinearReplyInput;
	messageId: string;
	phase: 'start' | 'resume';
}

export interface LinearReplyOptions {
	sql: SqlLike;
	getActiveSession: (dmId: string) => Promise<string | null>;
	prepareReply: (input: Pick<LinearReplyInput, 'assignment' | 'source' | 'operation'> & { outcome: z.infer<typeof createdSchema> }, context: {
		runId: string;
		abortSignal: AbortSignal;
		tracingContext?: TracingContext;
	}) => Promise<string>;
}

/** Only application methods below mint authority; authenticated native routes cannot. */
export function createLinearReplyProcedure(options: LinearReplyOptions) {
	const authorities = new WeakMap<RequestContext, Authority>();
	const unavailable = () => new Error('Linear reply continuation is unavailable.');

	async function authorize(context: RequestContext, runId: string, input: LinearReplyInput) {
		const authority = authorities.get(context);
		if (!authority || authority.runId !== runId || JSON.stringify(authority.input) !== JSON.stringify(input))
			throw unavailable();
		// Native resume restores stored context before execute; none of it carries current authority.
		context.clear();
		if (await options.getActiveSession(input.dmId) !== input.sessionId
			|| !await isLatestLinearMessage(input.dmId, authority.messageId, options.sql)) {
			throw unavailable();
		}
		return authority;
	}

	async function readBound(input: LinearReplyInput, runId: string, messageId: string): Promise<LinearProposal> {
		const proposal = await readLinearContinuation(input.operation.id, options.sql);
		const continuation = linearContinuationSchema.safeParse(proposal?.continuation);
		const decision = linearDecisionSchema.safeParse(proposal?.decision);
		const operation = linearCreateOperationSchema.safeParse(proposal?.operation);
		if (!proposal || !continuation.success || continuation.data.runId !== runId
			|| proposal.dm_id !== input.dmId || proposal.session_id !== input.sessionId || proposal.source_message_id !== input.sourceMessageId
			|| !operation.success || JSON.stringify(operation.data) !== JSON.stringify(input.operation)
			|| !decision.success || decision.data.messageId !== messageId || decision.data.disposition === 'canceled') {
			throw unavailable();
		}
		return proposal;
	}

	const wait = createStep({
		id: LINEAR_OUTCOME_WAIT_ID,
		inputSchema: linearReplyInputSchema,
		outputSchema: waitResultSchema,
		resumeSchema: z.object({ operationId: z.uuid() }).strict(),
		suspendSchema: z.object({ operationId: z.uuid() }).strict(),
		retries: 0,
		execute: async ({ inputData, requestContext, runId, resumeData, suspend, abortSignal }) => {
			abortSignal.throwIfAborted();
			const authority = await authorize(requestContext, runId, inputData);
			if (!resumeData) {
				if (authority.phase !== 'start')
					throw unavailable();
				return suspend({ operationId: inputData.operation.id });
			}
			if (authority.phase !== 'resume' || resumeData.operationId !== inputData.operation.id)
				throw unavailable();
			const proposal = await readBound(inputData, runId, authority.messageId);
			if (proposal.state === 'canceled' && proposal.decision?.disposition === 'declined')
				return { status: 'declined' as const };
			if (proposal.decision?.disposition !== 'confirmed')
				throw unavailable();
			if (proposal.state === 'claimed' && !proposal.outcome)
				return suspend({ operationId: inputData.operation.id });
			const outcome = linearCreateOutcomeSchema.safeParse(proposal.outcome);
			if (!outcome.success || outcome.data.status !== proposal.state)
				throw unavailable();
			return outcome.data.status === 'succeeded' ? createdSchema.parse(outcome.data) : { status: outcome.data.status };
		},
	});

	const prepare = createStep({
		id: 'prepare_linked_reply',
		inputSchema: waitResultSchema,
		outputSchema: replyResultSchema,
		retries: 0,
		execute: async ({ inputData, getInitData, requestContext, runId, abortSignal, tracingContext }) => {
			const input = linearReplyInputSchema.parse(getInitData());
			const authority = await authorize(requestContext, runId, input);
			const proposal = await readBound(input, runId, authority.messageId);
			if (inputData.status !== 'succeeded')
				return { status: 'stopped' as const, operationId: input.operation.id, reason: inputData.status };
			const outcome = createdSchema.parse(proposal.outcome);
			if (proposal.state !== 'succeeded')
				throw unavailable();
			abortSignal.throwIfAborted();
			try {
				const draft = z.string().min(1).max(12000).parse(await options.prepareReply({ assignment: input.assignment, source: input.source, operation: input.operation, outcome }, { runId, abortSignal, tracingContext }));
				abortSignal.throwIfAborted();
				if (!draft.includes(outcome.url))
					throw unavailable();
				await authorize(requestContext, runId, input);
				return { status: 'ready' as const, operationId: input.operation.id, identifier: outcome.identifier, url: outcome.url, draft };
			}
			catch {
				abortSignal.throwIfAborted();
				await authorize(requestContext, runId, input);
				return { status: 'partial' as const, operationId: input.operation.id, identifier: outcome.identifier, url: outcome.url, gap: 'draft_unavailable' as const };
			}
		},
	});

	const workflow = createWorkflow({
		id: LINEAR_REPLY_WORKFLOW_ID,
		inputSchema: linearReplyInputSchema,
		outputSchema: replyResultSchema,
		retryConfig: { attempts: 0, delay: 0 },
		options: {
			validateInputs: true,
			autoRestartActiveRuns: false,
			shouldPersistSnapshot: () => true,
			onStart: async ({ requestContext, runId, getInitData }) => {
				await authorize(requestContext, runId, linearReplyInputSchema.parse(getInitData()));
			},
		},
	}).then(wait).then(prepare).commit();

	async function start(raw: LinearReplyInput) {
		const input = linearReplyInputSchema.parse(raw);
		const run = await workflow.createRun();
		const context = new RequestContext();
		authorities.set(context, { runId: run.runId, input, messageId: input.sourceMessageId, phase: 'start' });
		try {
			await run.start({ inputData: input, requestContext: context });
			const state = await workflow.getWorkflowRunById(run.runId);
			const suspended = state && createWorkflowStateReader(state).getSuspendedStep();
			if (state?.isFromInMemory || state?.status !== 'suspended' || suspended?.stepId !== LINEAR_OUTCOME_WAIT_ID
				|| suspended.suspendPayload?.operationId !== input.operation.id) {
				throw unavailable();
			}
			return linearContinuationSchema.parse({ workflowId: workflow.id, runId: run.runId, waitStep: wait.id });
		}
		finally { authorities.delete(context); }
	}

	async function resume(operationId: string, decisionMessageId: string) {
		z.uuid().parse(operationId);
		const proposal = await readLinearContinuation(operationId, options.sql);
		const continuation = linearContinuationSchema.parse(proposal?.continuation);
		const state = await workflow.getWorkflowRunById(continuation.runId);
		if (!state || state.isFromInMemory)
			throw unavailable();
		const reader = createWorkflowStateReader(state);
		const input = linearReplyInputSchema.parse(state.payload);
		if (input.operation.id !== operationId)
			throw unavailable();
		const context = new RequestContext();
		authorities.set(context, { runId: continuation.runId, input, messageId: decisionMessageId, phase: 'resume' });
		try {
			await authorize(context, continuation.runId, input);
			const bound = await readBound(input, continuation.runId, decisionMessageId);
			if (state.status === 'success') {
				const result = replyResultSchema.parse(reader.getResult());
				if (result.operationId !== operationId)
					throw unavailable();
				if (result.status === 'stopped') {
					if (result.reason === 'declined' ? bound.state !== 'canceled' || bound.decision?.disposition !== 'declined' : bound.state !== result.reason || bound.outcome?.status !== result.reason)
						throw unavailable();
				}
				else {
					const outcome = createdSchema.parse(bound.outcome);
					if (bound.state !== 'succeeded' || bound.decision?.disposition !== 'confirmed' || result.identifier !== outcome.identifier || result.url !== outcome.url)
						throw unavailable();
				}
				return state;
			}
			const suspended = reader.getSuspendedStep();
			if (state.status !== 'suspended' || suspended?.stepId !== wait.id || suspended.path.length !== 1
				|| suspended.suspendPayload?.operationId !== operationId) {
				throw unavailable();
			}
			const run = await workflow.createRun({ runId: continuation.runId });
			try {
				await run.resume({ step: wait, resumeData: { operationId }, requestContext: context });
			}
			catch (error) {
				if (!(error instanceof MastraError) || error.id !== 'WORKFLOW_RESUME_ALREADY_CLAIMED')
					throw error;
				// A competing resume owns execution; inspect its saved state without retrying.
			}
			return await workflow.getWorkflowRunById(continuation.runId);
		}
		finally { authorities.delete(context); }
	}

	async function cancel(runId: string) {
		const existing = await workflow.getWorkflowRunById(runId);
		if (!existing || existing.isFromInMemory)
			throw unavailable();
		const run = await workflow.createRun({ runId });
		await run.cancel();
		const state = await workflow.getWorkflowRunById(runId);
		if (!state || state.isFromInMemory || state.status !== 'canceled')
			throw new Error('Linear reply cancellation could not be persisted.');
	}

	return { workflow, start, resume, cancel };
}
