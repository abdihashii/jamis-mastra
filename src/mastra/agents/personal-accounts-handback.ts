import type { RequestContext } from '@mastra/core/request-context';
import type { SpecialistHandback } from './specialist-handback';

import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import { linearReadResultSchema } from '../../lib/linear/linear';
import { resolveAccountsGmailReferences } from '../tools/invoke-specialist';
import { researchResultSchema } from './research-handback';
import { specialistHandbackSchema } from './specialist-handback';

const text = z.string().min(1);
export const personalAccountsResultSchema = z.object({
	summary: text,
	messages: z.array(z.object({ subject: z.string(), from: z.string(), date: z.string().datetime(), snippet: z.string(), body: z.string().max(12_000).nullable(), truncated: z.boolean() }).strict()).max(20),
	events: z.array(z.object({ calendar: text, title: text, start: text, end: text, operatorLocalStart: text.nullable(), operatorLocalEnd: text.nullable(), location: z.string().nullable() }).strict()).max(50),
	issues: z.array(z.object({ identifier: text, url: z.string().url(), status: text }).strict()).max(50),
	coverage: z.array(z.object({ source: z.enum(['gmail', 'calendar', 'linear']), status: z.enum(['complete', 'empty', 'ambiguous', 'truncated', 'unavailable', 'denied']), gaps: z.array(text).max(10) }).strict()).max(3),
	research: researchResultSchema.nullable(),
	replyText: text.nullable(),
}).strict();

export const personalAccountsModelHandbackSchema = specialistHandbackSchema(personalAccountsResultSchema.omit({ messages: true }).extend({
	messageRefs: z.array(z.uuid()).max(20).describe('Exact messageRefs from Gmail tool results in this invocation. Native code supplies the original records. Include every retrieved message for completed results.'),
}));

export function resolvePersonalAccountsHandback(value: unknown, context: RequestContext) {
	const handback = personalAccountsModelHandbackSchema.parse(value);
	const result = 'result' in handback ? handback.result : handback.progress;
	if (!result)
		return handback;
	const { messageRefs, ...rest } = result;
	const resolved = { ...rest, messages: resolveAccountsGmailReferences(context, messageRefs).map(message => ({
		...message,
		body: message.body ?? null,
		truncated: message.body?.endsWith('\n... (truncated)') ?? false,
	})) };
	return 'result' in handback ? { ...handback, result: resolved } : { ...handback, progress: resolved };
}

const gmailResultSchema = z.object({
	estimatedTotal: z.number().nonnegative(),
	messages: z.array(personalAccountsResultSchema.shape.messages.element.omit({ truncated: true }).extend({ body: z.string().optional() })),
});
const calendarResultSchema = z.object({
	truncated: z.boolean(),
	unavailableCalendars: z.array(z.object({ calendar: z.string(), status: z.union([z.literal(403), z.literal(404)]) })),
	events: z.array(personalAccountsResultSchema.shape.events.element.extend({
		operatorLocalStart: z.string().nullish(),
		operatorLocalEnd: z.string().nullish(),
		location: z.string().nullish(),
	}).strip()),
});
const researchHandbackSchema = specialistHandbackSchema(researchResultSchema);

export function validatePersonalAccountsHandback(
	handback: SpecialistHandback<z.infer<typeof personalAccountsResultSchema>>,
	{ toolResults, pendingOperationId }: { toolResults: Array<{ payload: { toolName: string; result: unknown; isError?: boolean } }>; pendingOperationId?: string },
) {
	const payloads = toolResults.map(({ payload }) => payload);
	const proposed = payloads.some(payload => payload.toolName === 'linearCreateProposalTool' && !payload.isError
		&& z.object({ status: z.literal('proposed') }).safeParse(payload.result).success);
	if (handback.case === 'needs_help' && handback.need.kind === 'approval') {
		if (!proposed || !pendingOperationId || handback.need.operationId !== pendingOperationId)
			throw new Error('Accounts approval does not match a posted proposal.');
	} else if (proposed) {
		throw new Error('A posted proposal still needs its recorded approval decision.');
	}
	const result = 'result' in handback ? handback.result : handback.progress;
	if (!result)
		return;
	const gmailCalls = payloads.filter(payload => payload.toolName === 'gmailSearchTool');
	const calendarCalls = payloads.filter(payload => payload.toolName === 'calendarEventsTool');
	const linearCalls = payloads.filter(payload => payload.toolName === 'linearReadTool');
	const gmail = gmailCalls.flatMap((payload) => {
		const parsed = payload.isError ? null : gmailResultSchema.safeParse(payload.result);
		return parsed?.success ? [parsed.data] : [];
	});
	const calendar = calendarCalls.flatMap((payload) => {
		const parsed = payload.isError ? null : calendarResultSchema.safeParse(payload.result);
		return parsed?.success ? [parsed.data] : [];
	});
	const linear = linearCalls.flatMap((payload) => {
		const parsed = payload.isError ? null : linearReadResultSchema.safeParse(payload.result);
		return parsed?.success ? [parsed.data] : [];
	});
	const messages = gmail.flatMap(read => read.messages.map(message => ({
		...message,
		body: message.body ?? null,
		truncated: message.body?.endsWith('\n... (truncated)') ?? false,
	})));
	const events = calendar.flatMap(read => read.events.map(event => ({
		...event,
		operatorLocalStart: event.operatorLocalStart ?? null,
		operatorLocalEnd: event.operatorLocalEnd ?? null,
		location: event.location ?? null,
	})));
	const issues = linear.filter(read => ['ok', 'ambiguous'].includes(read.status)).flatMap(read => [...(read.issues ?? []), ...(read.issue ? [read.issue] : [])]).map(issue => ({ identifier: issue.identifier, url: issue.url, status: issue.state.name }));
	if (result.messages.some(message => !messages.some(read => isDeepStrictEqual(message, read)))
		|| result.events.some(event => !events.some(read => isDeepStrictEqual(event, read)))
		|| result.issues.some(issue => !issues.some(read => isDeepStrictEqual(issue, read)))) {
		throw new Error('Accounts records do not match retrieved evidence.');
	}
	if (handback.case === 'completed' && (messages.some(read => !result.messages.some(message => isDeepStrictEqual(message, read)))
		|| events.some(read => !result.events.some(event => isDeepStrictEqual(event, read)))
		|| issues.some(read => !result.issues.some(issue => isDeepStrictEqual(issue, read))))) {
		throw new Error('Accounts completion cannot omit retrieved records.');
	}

	const coverage = new Map(result.coverage.map(item => [item.source, item]));
	if (coverage.size !== result.coverage.length)
		throw new Error('Accounts coverage contains duplicate services.');
	const checkCoverage = (source: 'gmail' | 'calendar' | 'linear', calls: number, status: z.infer<typeof personalAccountsResultSchema>['coverage'][number]['status'], ambiguous = false) => {
		const entry = coverage.get(source);
		if (calls === 0 ? entry !== undefined : !entry || (entry.status !== status && !(ambiguous && entry.status === 'ambiguous')))
			throw new Error('Accounts coverage does not match the queried service.');
		if (entry && !['complete', 'empty'].includes(entry.status) && (entry.gaps.length === 0 || handback.case === 'completed'))
			throw new Error('Incomplete Accounts coverage needs explicit gaps.');
	};
	checkCoverage('gmail', gmailCalls.length, gmail.length !== gmailCalls.length || messages.some(message => message.body === null)
		? 'unavailable'
		: gmail.some(read => read.estimatedTotal > read.messages.length) || messages.some(message => message.truncated)
			? 'truncated'
			: messages.length ? 'complete' : 'empty', messages.length > 1);
	const unreadCalendars = calendar.flatMap(read => read.unavailableCalendars);
	checkCoverage('calendar', calendarCalls.length, calendar.length !== calendarCalls.length || unreadCalendars.length
		? 'unavailable'
		: calendar.some(read => read.truncated) ? 'truncated' : events.length ? 'complete' : 'empty');
	for (const unread of unreadCalendars) {
		if (!coverage.get('calendar')?.gaps.some(gap => gap.includes(unread.calendar) && gap.includes(String(unread.status))))
			throw new Error('Accounts must identify unread selected calendars.');
	}
	checkCoverage('linear', linearCalls.length, linear.some(read => read.status === 'denied')
		? 'denied'
		: linear.length !== linearCalls.length || linear.some(read => ['unavailable', 'not_found'].includes(read.status))
			? 'unavailable'
			: linear.some(read => read.status === 'ambiguous')
				? 'ambiguous'
				: linear.some(read => read.partial || read.nextCursor || read.issue?.truncated || read.comments?.some(comment => comment.truncated))
					? 'truncated'
					: issues.length || linear.some(read => read.comments?.length || read.attachments?.length) ? 'complete' : 'empty');

	const researchCalls = payloads.filter(payload => payload.toolName === 'invoke_research');
	const research = researchCalls.filter(payload => !payload.isError).flatMap((payload) => {
		const parsed = researchHandbackSchema.safeParse(payload.result);
		return parsed.success ? [parsed.data] : [];
	});
	if (result.research && !research.some(read => 'result' in read && isDeepStrictEqual(read.result, result.research)))
		throw new Error('Accounts Research does not match a validated contribution.');
	if (handback.case === 'completed' && (research.length !== researchCalls.length || research.some(read => read.case !== 'completed')))
		throw new Error('Accounts must retain an unresolved Research need or gap.');
	if (handback.case === 'completed' && result.coverage.length === 0 && result.research === null)
		throw new Error('Accounts completion requires retrieved evidence.');
}
