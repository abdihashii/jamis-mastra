import type { Agent } from '@mastra/core/agent';
import type { ToolExecutionContext } from '@mastra/core/tools';
import type { SpecialistFailure, SpecialistHandback } from '../agents/specialist-handback';

import { RequestContext } from '@mastra/core/request-context';
import { createTool, isValidationError } from '@mastra/core/tools';
import { z } from 'zod';

import { specialistHandbackSchema } from '../agents/specialist-handback';

export type SpecialistCaller
	= | { kind: 'agent'; id: 'jamis' | 'weather-agent' | 'personal-accounts-agent' }
		| { kind: 'workflow'; id: 'prepare_linear_reply' };

const targets = {
	invoke_weather: 'weather-agent',
	invoke_research: 'research-agent',
	invoke_personal_accounts: 'personal-accounts-agent',
} as const;
type InvocationId = keyof typeof targets;
interface Authority {
	caller: SpecialistCaller;
	pendingOperationId?: string;
}
const authorities = new WeakMap<RequestContext, Authority>();

// Only trusted application entry code calls this. Serialized request context cannot recreate it.
export function createSpecialistContext(caller: SpecialistCaller, pendingOperationId?: string): RequestContext {
	const context = new RequestContext();
	authorities.set(context, { caller: { ...caller }, pendingOperationId });
	return context;
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

export function createSpecialistInvocation<I extends Record<string, unknown>, R extends Record<string, unknown>>(config: {
	id: InvocationId;
	agent: Agent;
	inputSchema: z.ZodType<I, I>;
	resultSchema: z.ZodType<R, R>;
	allowedCallers: readonly SpecialistCaller[];
	project: (input: I) => string | { case: 'blocked'; reason: string; progress: null };
	validate?: (handback: SpecialistHandback<R>, context: { input: I; requestContext: RequestContext; toolResults: Array<{ payload: { toolName: string; result: unknown } }> }) => void | Promise<void>;
}) {
	if (config.agent.id !== targets[config.id] || config.allowedCallers.some(caller => !allowedEdge(caller, config.id)))
		throw new Error('Unsupported specialist invocation configuration.');
	const allowed = new Set(config.allowedCallers.map(callerKey));
	const handbackSchema = specialistHandbackSchema(config.resultSchema);
	// Strict providers require an object root; the union remains the native tool result.
	const envelopeSchema = z.object({ handback: handbackSchema }).strict();
	return createTool({
		id: config.id,
		description: `Request a bounded contribution from ${config.agent.name}. Return its typed result or specific need to the task owner.`,
		inputSchema: config.inputSchema,
		outputSchema: handbackSchema,
		execute: async (input, context) => {
			const authority = requireAuthority(context, allowed);
			throwIfCanceled(context.abortSignal);
			try {
				const assignment = config.project(input as I);
				if (typeof assignment !== 'string')
					return handbackSchema.parse(assignment);
				if (!assignment.trim() || assignment.length > 16_000)
					throw new Error('Specialist assignment is invalid.');
				const requestContext = config.id === 'invoke_research'
					? new RequestContext()
					: createSpecialistContext({ kind: 'agent', id: config.agent.id as 'weather-agent' | 'personal-accounts-agent' }, authority.pendingOperationId);
				const response = await config.agent.generate(assignment, {
					requestContext,
					abortSignal: context.abortSignal,
					tracingContext: context.tracingContext,
					maxSteps: 5,
					toolCallConcurrency: 1,
					structuredOutput: { schema: envelopeSchema, errorStrategy: 'strict' },
				});
				throwIfCanceled(context.abortSignal);
				if (isValidationError(response.object))
					throw new Error('Specialist handback is invalid.');
				const { handback } = envelopeSchema.parse(response.object);
				if (handback.case === 'needs_help' && handback.need.kind === 'approval' && handback.need.operationId !== authority.pendingOperationId)
					throw new Error('Specialist approval does not match the pending operation.');
				await config.validate?.(handback, { input: input as I, requestContext, toolResults: response.toolResults });
				return handback;
			}
			finally {
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
	}
	catch (error) {
		if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
			throw error;
		const parsed = resultSchema.safeParse(progress);
		return { case: 'failed', reason: 'Specialist execution or handback validation failed.', progress: parsed.success ? parsed.data : null };
	}
}
