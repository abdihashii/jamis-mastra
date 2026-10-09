import type { z } from 'zod';

import type { personalAccountsResultSchema } from '../personal-accounts-handback';

import type { researchResultSchema } from '../research-handback';
import { describe, expect, test } from 'bun:test';
import { validatePersonalAccountsHandback } from '../personal-accounts-handback';
import { insufficientResearchReason, validateResearchHandback } from '../research-handback';
import { createResearchQuestionProjector, publicFareLabels, researchQuestionSchema } from '../research-question';
import { validateWeatherHandback, weatherResultSchema } from '../weather-handback';

function tool(toolName: string, result: unknown, args?: unknown, isError = false) {
	return { payload: { toolName, result, args, isError } };
}

const page = { title: 'Official guidance', url: 'https://example.gov/guidance', evidenceKind: 'scraped-webpage' as const, evidence: 'Go indoors when thunder is heard.', limitations: [] };
function researchResult(): z.infer<typeof researchResultSchema> {
	return { findings: [{ text: page.evidence, sourceNumbers: [1] }], sources: [{ ...page }], limitations: [] };
}
function sourceOutput(overrides: Record<string, unknown> = {}) {
	return { status: 'success', adminActionUrl: null, gaps: [], evidence: [], candidates: [], ...overrides };
}
const webReads = [
	tool('webSearch', { results: [{ title: page.title, url: page.url }] }),
	tool('webScrape', { markdown: `# Official guidance\n${page.evidence}` }, { url: page.url }),
];

describe('Research handback provenance', () => {
	test('accepts only a cited page that was actually read with its original title and passage', () => {
		const result = researchResult();
		expect(() => validateResearchHandback({ case: 'completed', result }, { toolResults: webReads })).not.toThrow();
		for (const toolResults of [webReads.slice(0, 1), [webReads[0]!, tool('webScrape', { markdown: page.evidence }, { url: 'https://other.example/page' })], [webReads[0]!, tool('webScrape', { markdown: page.evidence }, { url: page.url }, true)]])
			expect(() => validateResearchHandback({ case: 'completed', result }, { toolResults })).toThrow();
		result.sources[0]!.title = 'Invented source title';
		expect(() => validateResearchHandback({ case: 'completed', result }, { toolResults: webReads })).toThrow();
		result.sources[0] = { ...page, evidence: 'An unread claim.' };
		expect(() => validateResearchHandback({ case: 'completed', result }, { toolResults: webReads })).toThrow();
	});

	test('structured candidates cannot substitute for retrieved content', () => {
		const result = researchResult();
		const candidate = sourceOutput({ status: 'partial', candidates: [{ title: page.title, url: page.url }], gaps: ['webpage_requires_scrape'] });
		expect(() => validateResearchHandback({ case: 'completed', result }, { toolResults: [tool('researchSourceRetrieve', candidate)] })).toThrow();
		expect(() => validateResearchHandback({ case: 'completed', result }, { toolResults: [tool('researchSourceRetrieve', candidate), webReads[1]!] })).not.toThrow();
	});

	test('abstract evidence preserves its kind, license, attribution, and partial source gaps', () => {
		const source = { ...page, evidenceKind: 'abstract-only' as const, limitations: ['abstract-only', 'CC-BY-4.0', 'Fixture authors'] };
		const result = { ...researchResult(), sources: [source], limitations: ['partial_results'] };
		const toolResults = [tool('researchSourceRetrieve', sourceOutput({ status: 'partial', gaps: ['partial_results'], evidence: [{ title: source.title, url: source.url, content: source.evidence, evidenceKind: source.evidenceKind, license: 'CC-BY-4.0', attribution: 'Fixture authors' }] }))];
		expect(() => validateResearchHandback({ case: 'partial', result, gaps: ['Source returned partial_results.'] }, { toolResults })).not.toThrow();
		expect(() => validateResearchHandback({ case: 'completed', result }, { toolResults })).toThrow();
		result.sources[0]!.limitations = ['abstract-only'];
		expect(() => validateResearchHandback({ case: 'partial', result, gaps: ['partial_results'] }, { toolResults })).toThrow();
	});

	test('terms metadata permits only the exact returned access URL with no findings', () => {
		const adminActionUrl = 'https://www.firecrawl.dev/app/settings?tab=data-sources';
		const toolResults = [tool('researchSourceDiscover', sourceOutput({ status: 'terms_required', adminActionUrl }))];
		const blocked = { case: 'blocked' as const, reason: `Evidence status: insufficient. Source access requires administrator review: ${adminActionUrl}`, progress: null };
		expect(() => validateResearchHandback(blocked, { toolResults })).not.toThrow();
		expect(() => validateResearchHandback({ ...blocked, reason: blocked.reason.replace('tab=data-sources', 'tab=other') }, { toolResults })).toThrow();
		expect(() => validateResearchHandback({ ...blocked, progress: researchResult() }, { toolResults })).toThrow();
		expect(() => validateResearchHandback({ case: 'completed', result: researchResult() }, { toolResults: [...webReads, ...toolResults] })).toThrow();
		expect(() => validateResearchHandback({ case: 'blocked', reason: insufficientResearchReason, progress: null }, { toolResults: [tool('researchSourceRetrieve', sourceOutput({ status: 'terms_required' }))] })).not.toThrow();
	});

	test('insufficient evidence refuses factual claims and invented administrator URLs', () => {
		expect(() => validateResearchHandback({ case: 'blocked', reason: insufficientResearchReason, progress: null }, { toolResults: [] })).not.toThrow();
		expect(() => validateResearchHandback({ case: 'blocked', reason: 'That source does not exist.', progress: null }, { toolResults: [] })).toThrow();
		expect(() => validateResearchHandback({ case: 'blocked', reason: insufficientResearchReason, progress: researchResult() }, { toolResults: [] })).toThrow();
	});
});

const event = { calendar: 'Personal', title: 'Dentist', start: '2026-10-10T14:00:00.000Z', end: '2026-10-10T15:00:00.000Z', operatorLocalStart: '2026-10-10T09:00:00-05:00', operatorLocalEnd: '2026-10-10T10:00:00-05:00', location: null };
function accountsResult(): z.infer<typeof personalAccountsResultSchema> {
	return { summary: 'Retrieved account evidence.', messages: [], events: [], issues: [], coverage: [], research: null, replyText: null };
}

describe('Accounts handback provenance and coverage', () => {
	test('matches exact available calendar records and does not complete unread coverage', () => {
		const toolResults = [tool('calendarEventsTool', { events: [event], truncated: false, unavailableCalendars: [{ calendar: 'Work', status: 403 }] })];
		const result = { ...accountsResult(), events: [event], coverage: [{ source: 'calendar' as const, status: 'unavailable' as const, gaps: ['Work: 403, selected calendar unread.'] }] };
		expect(() => validatePersonalAccountsHandback({ case: 'partial', result, gaps: ['Missing Work calendar.'] }, { toolResults })).not.toThrow();
		expect(() => validatePersonalAccountsHandback({ case: 'completed', result }, { toolResults })).toThrow();
		result.events[0] = { ...event, start: '2026-10-10T13:00:00.000Z' };
		expect(() => validatePersonalAccountsHandback({ case: 'partial', result, gaps: ['Missing Work calendar.'] }, { toolResults })).toThrow();
	});

	test('cannot claim a complete or empty window after dropping returned events', () => {
		const toolResults = [tool('calendarEventsTool', { events: [event], truncated: false, unavailableCalendars: [] })];
		const result = accountsResult();
		result.coverage = [{ source: 'calendar', status: 'complete', gaps: [] }];
		expect(() => validatePersonalAccountsHandback({ case: 'completed', result }, { toolResults })).toThrow();
		result.events = [event];
		expect(() => validatePersonalAccountsHandback({ case: 'completed', result }, { toolResults })).not.toThrow();
		result.coverage[0]!.status = 'empty';
		expect(() => validatePersonalAccountsHandback({ case: 'completed', result }, { toolResults })).toThrow();
	});

	test('preserves Gmail truncation, unavailable bodies, and ambiguous candidates', () => {
		const message = { subject: 'Booking', from: '', date: '2026-10-09T00:00:00.000Z', snippet: 'Booking details', body: 'Bounded body\n... (truncated)' };
		const result = accountsResult();
		result.messages = [{ ...message, truncated: true }];
		result.coverage = [{ source: 'gmail', status: 'truncated', gaps: ['The body and query results are truncated.'] }];
		const toolResults = [tool('gmailSearchTool', { estimatedTotal: 2, messages: [message] })];
		expect(() => validatePersonalAccountsHandback({ case: 'partial', result, gaps: ['Incomplete email.'] }, { toolResults })).not.toThrow();
		result.messages[0]!.truncated = false;
		expect(() => validatePersonalAccountsHandback({ case: 'partial', result, gaps: ['Incomplete email.'] }, { toolResults })).toThrow();
		const candidates = [message, { ...message, subject: 'Another booking', body: 'Another email' }];
		result.messages = candidates.map(message => ({ ...message, truncated: message.body.endsWith('\n... (truncated)') }));
		result.coverage = [{ source: 'gmail', status: 'ambiguous', gaps: ['Choose the exact booking email.'] }];
		expect(() => validatePersonalAccountsHandback({ case: 'needs_help', need: { kind: 'input', question: 'Which booking?', missing: ['Exact email'] }, progress: result }, { toolResults: [tool('gmailSearchTool', { estimatedTotal: 2, messages: candidates })] })).not.toThrow();
		expect(() => validatePersonalAccountsHandback({ case: 'completed', result }, { toolResults: [tool('gmailSearchTool', { estimatedTotal: 2, messages: candidates })] })).toThrow();
		result.messages = [{ ...message, body: null, truncated: false }];
		result.coverage = [{ source: 'gmail', status: 'unavailable', gaps: ['Plain text body unavailable.'] }];
		const { body: _body, ...noBody } = message;
		expect(() => validatePersonalAccountsHandback({ case: 'partial', result, gaps: ['Only metadata was retrieved.'] }, { toolResults: [tool('gmailSearchTool', { estimatedTotal: 1, messages: [noBody] })] })).not.toThrow();
	});

	test('Linear issues and page gaps match actual reads, with no created-issue invention', () => {
		const issue = { id: '11111111-1111-4111-8111-111111111111', identifier: 'JAM-77', title: 'Typed delegation', url: 'https://linear.app/team/issue/JAM-77', state: { name: 'In Progress', type: 'started' }, updatedAt: '2026-10-09T00:00:00.000Z', team: { id: '22222222-2222-4222-8222-222222222222' } };
		const toolResults = [tool('linearReadTool', { status: 'ambiguous', partial: true, nextCursor: 'next', issues: [issue] })];
		const result = accountsResult();
		result.issues = [{ identifier: issue.identifier, url: issue.url, status: issue.state.name }];
		result.coverage = [{ source: 'linear', status: 'ambiguous', gaps: ['Choose exact identifier; another candidate page is available.'] }];
		expect(() => validatePersonalAccountsHandback({ case: 'needs_help', need: { kind: 'input', question: 'Which issue?', missing: ['Exact identifier'] }, progress: result }, { toolResults })).not.toThrow();
		result.issues[0]!.url = 'https://linear.app/team/issue/JAM-999';
		expect(() => validatePersonalAccountsHandback({ case: 'partial', result, gaps: ['Ambiguous issue.'] }, { toolResults })).toThrow();
	});

	test('requires an actual posted proposal and its runtime operation for approval', () => {
		const operationId = '33333333-3333-4333-8333-333333333333';
		const handback = { case: 'needs_help' as const, need: { kind: 'approval' as const, operationId }, progress: null };
		const toolResults = [tool('linearCreateProposalTool', { status: 'proposed' })];
		expect(() => validatePersonalAccountsHandback(handback, { toolResults, pendingOperationId: operationId })).not.toThrow();
		expect(() => validatePersonalAccountsHandback(handback, { toolResults })).toThrow();
		expect(() => validatePersonalAccountsHandback(handback, { toolResults: [tool('linearCreateProposalTool', { status: 'unavailable' })], pendingOperationId: operationId })).toThrow();
		expect(() => validatePersonalAccountsHandback({ case: 'completed', result: accountsResult() }, { toolResults, pendingOperationId: operationId })).toThrow();
	});

	test('nested research must match its validated contribution and retain a need', () => {
		const result = { ...accountsResult(), research: researchResult() };
		const toolResults = [tool('invoke_research', { case: 'completed', result: researchResult() })];
		expect(() => validatePersonalAccountsHandback({ case: 'completed', result }, { toolResults })).not.toThrow();
		result.research.findings[0]!.text = 'Invented finding';
		expect(() => validatePersonalAccountsHandback({ case: 'completed', result }, { toolResults })).toThrow();
		result.research = researchResult();
		expect(() => validatePersonalAccountsHandback({ case: 'completed', result }, { toolResults: [tool('invoke_research', { case: 'partial', result: researchResult(), gaps: ['Missing exception.'] })] })).toThrow();
	});

	test('failed reads and nested Research cannot disappear behind a useful calendar result', () => {
		const result = accountsResult();
		result.events = [event];
		result.coverage = [{ source: 'calendar', status: 'complete', gaps: [] }];
		const calendar = tool('calendarEventsTool', { events: [event], truncated: false, unavailableCalendars: [] });
		for (const toolName of ['gmailSearchTool', 'invoke_research']) {
			const toolResults = [calendar, tool(toolName, undefined, undefined, true)];
			expect(() => validatePersonalAccountsHandback({ case: 'completed', result }, { toolResults })).toThrow();
			const partial = { ...result, coverage: [...result.coverage] };
			if (toolName === 'gmailSearchTool')
				partial.coverage.push({ source: 'gmail', status: 'unavailable', gaps: ['Gmail read failed.'] });
			expect(() => validatePersonalAccountsHandback({ case: 'partial', result: partial, gaps: ['The requested contribution failed.'] }, { toolResults })).not.toThrow();
		}
	});
});

test('Weather completion retains exact resolved place/date and requires successful evidence', () => {
	const reading = { location: 'Chicago, Illinois', date: '2026-10-10', high: 66, low: 49, feelsLike: 62, condition: 'Clear', precipChancePercent: 0, precipitationMm: null, windMph: 5, humidityPercent: 50 };
	const result = weatherResultSchema.parse({ answer: 'The weather in Chicago, Illinois will be clear on 2026-10-10.', reading: { kind: 'forecast', ...reading } });
	const toolResults = [tool('forecastTool', reading, { date: reading.date })];
	expect(() => validateWeatherHandback({ case: 'completed', result }, { toolResults })).not.toThrow();
	expect(() => validateWeatherHandback({ case: 'completed', result }, { toolResults: [tool('forecastTool', reading, { date: '2026-10-11' })] })).toThrow();
	expect(() => validateWeatherHandback({ case: 'completed', result }, { toolResults: [tool('forecastTool', reading, { date: reading.date }, true)] })).toThrow();
	result.answer = 'The weather in Chicago, Illinoisish is clear.';
	expect(() => validateWeatherHandback({ case: 'completed', result }, { toolResults })).toThrow();
});

test('public questions use application labels and never forward unsupported private input', () => {
	const project = createResearchQuestionProjector(publicFareLabels);
	expect(project({ kind: 'carry_on_allowance', subjectId: 'united-basic-economy' })).toContain('United Basic Economy');
	expect(project({ kind: 'carry_on_allowance', subjectId: 'private-booking-reference' })).toMatchObject({ case: 'blocked', progress: null });
	expect(project({ kind: 'operator_request' })).toMatchObject({ case: 'blocked', progress: null });
	expect(researchQuestionSchema.safeParse({ kind: 'operator_request', question: 'Private text' }).success).toBe(false);
	expect(researchQuestionSchema.safeParse({ kind: 'carry_on_allowance', subjectId: 'united-basic-economy', airline: 'private text' }).success).toBe(false);
});
