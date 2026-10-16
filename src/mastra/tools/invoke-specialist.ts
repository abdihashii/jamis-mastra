import type { Agent } from '@mastra/core/agent';
import type { Processor } from '@mastra/core/processors';
import type { ToolExecutionContext } from '@mastra/core/tools';
import type { SpecialistFailure, SpecialistHandback } from '../agents/specialist-handback';
import type { SpecialistClarification } from '../specialist-clarification';
import type { GmailSearchResult } from './gmail-search';

import { randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import { createTool, isValidationError } from '@mastra/core/tools';
import { z } from 'zod';

import { specialistHandbackSchema } from '../agents/specialist-handback';
import { specialistClarificationSchema } from '../specialist-clarification';
import { linearReplySourceSchema } from '../workflows/linear-reply';

export type SpecialistCaller
	= | { kind: 'agent'; id: 'jamis' | 'weather-agent' | 'personal-accounts-agent' | 'fantasy-broadcast-agent' }
		| { kind: 'workflow'; id: 'prepare_linear_reply' };

const targets = {
	invoke_fantasy_broadcast: 'fantasy-broadcast-agent',
	invoke_weather: 'weather-agent',
	invoke_research: 'research-agent',
	invoke_personal_accounts: 'personal-accounts-agent',
} as const;
type InvocationId = keyof typeof targets;
interface Authority {
	caller: SpecialistCaller;
	pendingOperationId?: string;
	operatorRequest?: string;
	researchResults: Map<string, unknown>;
	clarification?: SpecialistClarification;
	nextClarification?: SpecialistClarification;
	saveClarification?: (clarification: SpecialistClarification) => Promise<void>;
	gmailReads?: Array<{ result: GmailSearchResult; messageRefs: string[] }>;
	originalAccountsRequest?: string;
}
const authorities = new WeakMap<RequestContext, Authority>();

// Only trusted application entry code calls this. Serialized request context cannot recreate it.
export function createSpecialistContext(caller: SpecialistCaller, pendingOperationId?: string): RequestContext {
	const context = new RequestContext();
	authorities.set(context, { caller: { ...caller }, pendingOperationId, researchResults: new Map() });
	return context;
}

export function revokeSpecialistAuthority(context: RequestContext): void {
	authorities.delete(context);
}

/** Source receipts stay in the current Accounts invocation, never serialized context. */
export function recordAccountsGmailRead(context: RequestContext | undefined, result: GmailSearchResult): GmailSearchResult & { messageRefs?: string[] } {
	const authority = context && authorities.get(context);
	if (authority?.caller.kind !== 'agent' || authority.caller.id !== 'personal-accounts-agent')
		return result;
	const messageRefs = result.messages.map(() => randomUUID());
	(authority.gmailReads ??= []).push({ result: structuredClone(result), messageRefs: [...messageRefs] });
	return { ...result, messageRefs };
}

function accountsGmailReceipt(context: RequestContext | undefined, reference: string) {
	const authority = context && authorities.get(context);
	if (authority?.caller.kind === 'agent' && authority.caller.id === 'personal-accounts-agent') {
		for (const read of authority.gmailReads ?? []) {
			const index = read.messageRefs.indexOf(reference);
			if (index !== -1)
				return { authority, read: read.result, message: read.result.messages[index]! };
		}
	}
	throw new Error('Accounts email reference is unavailable in this invocation.');
}

export function resolveAccountsGmailReferences(context: RequestContext, references: string[]) {
	if (new Set(references).size !== references.length)
		throw new Error('Accounts email references contain duplicates.');
	return references.map(reference => structuredClone(accountsGmailReceipt(context, reference).message));
}

export function requireAccountsReplySource(context: ToolExecutionContext, reference: string) {
	if (context.agent?.agentId !== 'personal-accounts-agent')
		throw new Error('Linked reply requires the native Accounts caller.');
	const { authority, read, message } = accountsGmailReceipt(context.requestContext, reference);
	const source = linearReplySourceSchema.strip().safeParse(message);
	if (read.messages.length !== 1 || !source.success || source.data.body.endsWith('\n... (truncated)')) {
		throw new Error('Linked reply requires one usable email read by the current Accounts invocation.');
	}
	const assignment = z.string().min(1).max(4000).safeParse(authority.originalAccountsRequest);
	if (!assignment.success)
		throw new Error('The original Accounts task is unavailable. Restate it before a fresh proposal.');
	return { source: source.data, assignment: assignment.data };
}

/** Native Jamis entry owns the caller identity; tool arguments and serialized context cannot mint it. */
export function createJamisSpecialistProcessor(channelRequest: (context: RequestContext) => string | undefined, clarification?: {
	take: (context: RequestContext) => SpecialistClarification | undefined;
	save: (context: RequestContext, clarification: SpecialistClarification) => Promise<void>;
}) {
	return {
		id: 'authorize_jamis_specialists',
		processInput: ({ messageList, requestContext }) => {
			if (!requestContext)
				throw new Error('Specialist invocation requires a request context.');
			// get.input excludes recalled memory, context injections, and model/tool responses.
			const current = messageList.get.input.db().filter(message => message.role === 'user').at(-1);
			const channelInput = channelRequest(requestContext);
			const operatorRequest = channelInput
				?? current?.content.parts.filter(part => part.type === 'text').map(part => part.text).join('');
			authorities.set(requestContext, {
				caller: { kind: 'agent', id: 'jamis' },
				operatorRequest,
				researchResults: new Map(),
				clarification: clarification?.take(requestContext),
				saveClarification: clarification && channelInput !== undefined ? state => clarification.save(requestContext, state) : undefined,
			});
			return messageList;
		},
		processOutputResult: async ({ messageList, requestContext }) => {
			try {
				const authority = requestContext && authorities.get(requestContext);
				if (authority?.nextClarification)
					await authority.saveClarification?.(authority.nextClarification);
				return messageList;
			} finally {
				if (requestContext)
					revokeSpecialistAuthority(requestContext);
			}
		},
	} satisfies Processor;
}

function callerKey(caller: SpecialistCaller) {
	return `${caller.kind}:${caller.id}`;
}

function allowedEdge(caller: SpecialistCaller, target: InvocationId) {
	return caller.kind === 'workflow'
		? target === 'invoke_personal_accounts'
		: caller.id === 'jamis' || target === 'invoke_research';
}

function requireAuthority(context: ToolExecutionContext | undefined, allowed: Set<string>) {
	const authority = context?.requestContext && authorities.get(context.requestContext);
	const nativeId = authority?.caller.kind === 'agent' ? context?.agent?.agentId : context?.workflow?.workflowId;
	if (!authority || nativeId !== authority.caller.id || !allowed.has(callerKey(authority.caller)))
		throw new Error('Specialist invocation is not authorized.');
	return authority;
}

function throwIfCanceled(signal?: AbortSignal) {
	if (signal?.aborted)
		throw new DOMException('Specialist invocation was canceled.', signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError');
}

function recordClarification<R>(authority: Authority, owner: InvocationId, assignment: string, handback: SpecialistHandback<R>, originalAccountsRequest?: string) {
	if (authority.nextClarification?.owner === owner)
		authority.nextClarification = undefined;
	if (authority.saveClarification && handback.case === 'needs_help' && handback.need.kind === 'input') {
		authority.nextClarification = specialistClarificationSchema.parse({
			owner,
			need: handback.need,
			publicAssignment: owner === 'invoke_research' ? assignment : null,
			...(owner === 'invoke_personal_accounts' ? { originalAccountsRequest } : {}),
			researchResults: [...authority.researchResults].map(([assignment, handback]) => ({ assignment, handback })),
		});
	}
	return handback;
}

export function createSpecialistInvocation<I extends Record<string, unknown>, R extends Record<string, unknown>>(config: {
	id: InvocationId;
	agent: Agent;
	inputSchema: z.ZodType<I, I>;
	resultSchema: z.ZodType<R, R>;
	modelHandback?: { schema: z.ZodType; resolve: (value: unknown, context: RequestContext) => unknown };
	allowedCallers: readonly SpecialistCaller[];
	project: (input: I, context: { caller: SpecialistCaller; operatorRequest?: string; clarification?: SpecialistClarification }) => string | { case: 'blocked'; reason: string; progress: null };
	continueClarification?: (input: I) => boolean;
	run?: <T>(execute: () => Promise<T>) => Promise<T>;
	pendingOperationId?: () => string | undefined;
	validate?: (handback: SpecialistHandback<R>, context: { input: I; requestContext: RequestContext; pendingOperationId?: string; toolResults: Array<{ payload: { toolName: string; result: unknown; args?: unknown; isError?: boolean } }> }) => void | Promise<void>;
}) {
	if (config.agent.id !== targets[config.id] || config.allowedCallers.some(caller => !allowedEdge(caller, config.id)))
		throw new Error('Unsupported specialist invocation configuration.');
	const allowed = new Set(config.allowedCallers.map(callerKey));
	const handbackSchema = specialistHandbackSchema(config.resultSchema);
	// Strict providers require an object root; the union remains the native tool result.
	const envelopeSchema = z.object({ handback: config.modelHandback?.schema ?? handbackSchema }).strict();
	return createTool({
		id: config.id,
		description: `${config.agent.getDescription() || config.agent.name} Return a bounded typed contribution or specific need to the task owner.`,
		inputSchema: config.inputSchema,
		outputSchema: handbackSchema,
		execute: async (input, context) => {
			const authority = requireAuthority(context, allowed);
			throwIfCanceled(context.abortSignal);
			let calleeContext: RequestContext | undefined;
			try {
				const pending = config.continueClarification?.(input as I) ? authority.clarification : undefined;
				if (config.continueClarification?.(input as I)
					&& (authority.caller.kind !== 'agent' || authority.caller.id !== 'jamis' || pending?.owner !== config.id)) {
					return recordClarification(authority, config.id, '', handbackSchema.parse({ case: 'blocked', reason: 'That specialist clarification is no longer available. Restate the task before a fresh attempt.', progress: null }));
				}
				if (authority.caller.kind === 'agent' && authority.caller.id === 'jamis')
					authority.clarification = undefined;
				for (const receipt of pending?.researchResults ?? [])
					authority.researchResults.set(receipt.assignment, receipt.handback);
				const projected = config.project(input as I, { ...authority, clarification: pending });
				const assignment = typeof projected === 'string' && pending?.researchResults.length && config.id !== 'invoke_research'
					? `${projected}\n\nPreviously validated public Research contributions for this clarification (reuse these, do not repeat their retrieval):\n${JSON.stringify(pending.researchResults)}`
					: projected;
				if (typeof assignment !== 'string')
					return recordClarification(authority, config.id, '', handbackSchema.parse(assignment));
				if (!assignment.trim() || assignment.length > 16_000)
					throw new Error('Specialist assignment is invalid.');
				if (config.id === 'invoke_research' && authority.researchResults.has(assignment))
					return recordClarification(authority, config.id, assignment, handbackSchema.parse(authority.researchResults.get(assignment)));
				const requestContext = config.id === 'invoke_research'
					? new RequestContext()
					: createSpecialistContext({ kind: 'agent', id: config.agent.id as 'weather-agent' | 'personal-accounts-agent' | 'fantasy-broadcast-agent' }, authority.pendingOperationId);
				calleeContext = requestContext;
				const childAuthority = authorities.get(requestContext);
				if (childAuthority)
					childAuthority.researchResults = authority.researchResults;
				if (childAuthority && config.id === 'invoke_personal_accounts') {
					childAuthority.originalAccountsRequest = pending
						? pending.originalAccountsRequest ? `${pending.originalAccountsRequest}\n\nOperator clarification:\n${authority.operatorRequest}` : undefined
						: authority.operatorRequest;
				}
				const generate = () => config.agent.generate(assignment, {
					requestContext,
					abortSignal: context.abortSignal,
					tracingContext: context.tracingContext,
					maxSteps: 5,
					toolCallConcurrency: 1,
					structuredOutput: { schema: envelopeSchema, errorStrategy: 'strict' },
				});
				const response = await (config.run ? config.run(generate) : generate());
				throwIfCanceled(context.abortSignal);
				if (isValidationError(response.object))
					throw new Error('Specialist handback is invalid.');
				const modelHandback = envelopeSchema.parse(response.object).handback;
				const handback = handbackSchema.parse(config.modelHandback ? config.modelHandback.resolve(modelHandback, requestContext) : modelHandback);
				const pendingOperationId = config.pendingOperationId?.() ?? authority.pendingOperationId;
				if (handback.case === 'needs_help' && handback.need.kind === 'approval' && handback.need.operationId !== pendingOperationId)
					throw new Error('Specialist approval does not match the pending operation.');
				// Native generate omits thrown tools from toolResults; attempted reads still constrain completion.
				const returnedCalls = new Set(response.toolResults.map(({ payload }) => payload.toolCallId));
				const toolResults = [
					...response.toolResults,
					...(config.id !== 'invoke_research' ? pending?.researchResults ?? [] : []).map(receipt => ({ payload: { toolName: 'invoke_research', result: receipt.handback } })),
					...response.toolCalls.filter(({ payload }) => !returnedCalls.has(payload.toolCallId)).map(({ payload }) => ({
						payload: { toolCallId: payload.toolCallId, toolName: payload.toolName, args: payload.args, result: null, isError: true },
					})),
				];
				await config.validate?.(handback, { input: input as I, requestContext, pendingOperationId, toolResults });
				throwIfCanceled(context.abortSignal);
				if (config.id === 'invoke_research')
					authority.researchResults.set(assignment, handback);
				return recordClarification(authority, config.id, assignment, handback, childAuthority?.originalAccountsRequest);
			} finally {
				if (calleeContext)
					revokeSpecialistAuthority(calleeContext);
				throwIfCanceled(context.abortSignal);
			}
		},
	});
}

// Progress comes from independently validated evidence, never the rejected model object.
export async function normalizeSpecialistResult<R extends Record<string, unknown>>(
	resultSchema: z.ZodType<R, R>,
	run: () => Promise<unknown>,
	progress?: unknown,
): Promise<SpecialistHandback<R> | SpecialistFailure<R>> {
	try {
		const value = await run();
		if (isValidationError(value))
			throw new Error('Tool validation failed.');
		return specialistHandbackSchema(resultSchema).parse(value);
	} catch (error) {
		if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
			throw error;
		const parsed = resultSchema.safeParse(progress);
		return { case: 'failed', reason: 'Specialist execution or handback validation failed.', progress: parsed.success ? parsed.data : null };
	}
}
