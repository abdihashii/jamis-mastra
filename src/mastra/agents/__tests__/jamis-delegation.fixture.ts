import type { Mastra } from '@mastra/core';
import type { SendblueMessagePayload } from 'chat-adapter-sendblue';
import type { SqlLike } from '../../../lib/operator-time-zone';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import { createTool, noopObserve } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { createSendblueAdapter } from 'chat-adapter-sendblue';
import { z } from 'zod';

import { handleSendblueDirectMessage } from '../../channels/sendblue';
import { calendarEventsTool } from '../../tools/calendar-events';
import { gmailSearchTool } from '../../tools/gmail-search';
import { forecastTool } from '../../tools/weather-tool';
import { createJamisAgent } from '../jamis';
import { boundaryModel, PRIVATE_ARCHITECTURE_SENTINEL } from './specialist-boundary.fixture';

const reading = { location: 'Chicago, Illinois', date: '2026-10-10', high: 66, low: 49, feelsLike: 62, condition: 'Clear', precipChancePercent: 0, precipitationMm: 0, windMph: 5, humidityPercent: 50 };
const weatherResult = { answer: 'The weather in Chicago, Illinois will be clear.', reading: { kind: 'forecast', ...reading } };
const need = { case: 'needs_help', need: { kind: 'input', question: 'Which city?', missing: ['location'] }, progress: null };
const event = { calendar: 'Fixture calendar', title: 'Dentist', start: '2026-10-10T14:00:00.000Z', end: '2026-10-10T15:00:00.000Z', operatorLocalStart: null, operatorLocalEnd: null, location: null };
const accountResult = { summary: 'Dentist is scheduled.', messages: [], events: [event], issues: [], coverage: [{ source: 'calendar', status: 'complete', gaps: [] }], research: null, replyText: null };

function fixtureJamis(mastra: Mastra, config: Parameters<typeof createJamisAgent>[0]) {
	return createJamisAgent({ mastra, tools: {}, workspace: undefined, memory: new Memory({ options: { semanticRecall: false, workingMemory: { enabled: false } } }), ...config });
}

function resultCase(value: unknown) {
	return value && typeof value === 'object' && 'case' in value ? value.case : undefined;
}

export async function runJamisDelegationFixture(mastra: Mastra) {
	const weatherContexts: RequestContext[] = [];
	let forecastCalls = 0;
	let calendarCalls = 0;
	const weatherPrompts: unknown[] = [];
	const weather = createTool({
		id: forecastTool.id,
		description: forecastTool.description!,
		inputSchema: forecastTool.inputSchema!,
		outputSchema: forecastTool.outputSchema!,
		execute: async (_, context) => {
			weatherContexts.push(context.requestContext);
			forecastCalls += 1;
			if (forecastCalls === 2)
				throw new Error('Weather service is unavailable.');
			return reading;
		},
	});
	const calendar = createTool({
		id: calendarEventsTool.id,
		description: calendarEventsTool.description!,
		inputSchema: calendarEventsTool.inputSchema!,
		outputSchema: calendarEventsTool.outputSchema!,
		execute: async () => {
			calendarCalls += 1;
			return { from: '2026-10-10T00:00:00.000Z', to: '2026-10-11T00:00:00.000Z', truncated: false, unavailableCalendars: [], events: [{ calendar: event.calendar, title: event.title, start: event.start, end: event.end }] };
		},
	});
	const jamis = fixtureJamis(mastra, {
		model: boundaryModel([
			{ tool: 'invoke_weather', input: { question: 'What is the weather outside tomorrow?' } },
			{ text: 'Which city?' },
			{ tool: 'invoke_weather', input: { question: 'Forecast for Chicago on 2026-10-10. The Operator supplied Chicago in answer to the location check.' } },
			{ text: weatherResult.answer },
			{ tool: 'invoke_personal_accounts', input: { question: 'Read my calendar for 2026-10-10.' } },
			{ tool: 'invoke_weather', input: { question: 'Forecast for Chicago on 2026-10-10.' } },
			{ text: 'Your dentist appointment is 14:00 to 15:00 UTC. I could not retrieve the Chicago forecast, so this is a calendar-only plan.' },
			{ tool: 'invoke_weather', input: { question: 'What is the weather outside?' } },
			{ text: 'Which city?' },
			{ text: 'I can help with that new request.' },
			{ tool: 'invoke_personal_accounts', input: { question: 'Read my Gmail and calendar for 2026-10-10.' } },
			{ text: 'I could not verify the full account result.' },
			{ tool: 'invoke_personal_accounts', input: { question: 'Read my Gmail and calendar for 2026-10-10 as a fresh assignment.' } },
			{ text: 'Your dentist appointment is 14:00 to 15:00 UTC. Gmail is unavailable, so this is a partial account summary.' },
		]),
		specialists: {
			weather: { tools: { forecastTool: weather }, model: boundaryModel([
				{ handback: need },
				{ tool: 'forecastTool', input: { location: 'Chicago', date: reading.date } },
				{ handback: { case: 'completed', result: weatherResult } },
				{ tool: 'forecastTool', input: { location: 'Chicago', date: reading.date } },
				{ handback: { case: 'blocked', reason: 'Weather service is unavailable.', progress: null } },
				{ handback: need },
			], options => weatherPrompts.push(options)) },
			personalAccounts: { tools: { calendarEventsTool: calendar, gmailSearchTool: createTool({ id: gmailSearchTool.id, description: gmailSearchTool.description!, inputSchema: gmailSearchTool.inputSchema!, outputSchema: gmailSearchTool.outputSchema!, execute: async () => {
				throw new Error('Gmail is unavailable.');
			} }) }, model: boundaryModel([
				{ tool: 'calendarEventsTool', input: { daysAhead: 2 } },
				{ handback: { case: 'completed', result: accountResult } },
				{ tool: 'gmailSearchTool', input: { query: 'is:unread' } },
				{ tool: 'calendarEventsTool', input: { daysAhead: 2 } },
				{ handback: { case: 'completed', result: accountResult } },
				{ tool: 'gmailSearchTool', input: { query: 'is:unread' } },
				{ tool: 'calendarEventsTool', input: { daysAhead: 2 } },
				{ handback: { case: 'partial', result: { ...accountResult, coverage: [...accountResult.coverage, { source: 'gmail', status: 'unavailable', gaps: ['Gmail evidence unavailable.'] }] }, gaps: ['Gmail evidence unavailable.'] } },
			]) },
			research: { tools: {}, model: boundaryModel([]) },
		},
	});
	mastra.addAgent(jamis, 'stage2-delegation-fixture');
	const clarification = await jamis.generate('What is the weather outside tomorrow?', { requestContext: new RequestContext() });
	assert.equal(clarification.text, 'Which city?');
	assert.equal(resultCase(clarification.toolResults[0]?.payload.result), 'needs_help');
	assert.equal(forecastCalls, 0);
	const completion = await jamis.generate([
		{ role: 'user', content: 'What is the weather outside tomorrow?' },
		{ role: 'assistant', content: clarification.text },
		{ role: 'user', content: 'Chicago, on 2026-10-10.' },
	], { requestContext: new RequestContext() });
	assert.equal(resultCase(completion.toolResults[0]?.payload.result), 'completed');
	assert.equal(completion.text, weatherResult.answer);
	assert.equal(forecastCalls, 1);
	assert.equal(weatherPrompts.length, 3, 'Clarification ends one invocation; completion runs fresh.');
	assert(!JSON.stringify(weatherPrompts[1]).includes('Which city?'), 'Fresh owner invocation must not resume a model transcript.');
	const partial = await jamis.generate('Plan 2026-10-10 using my calendar and Chicago weather.', { requestContext: new RequestContext() });
	assert.deepEqual(partial.toolCalls.map(call => call.payload.toolName), ['invoke_personal_accounts', 'invoke_weather']);
	assert.equal(resultCase(partial.toolResults[0]?.payload.result), 'completed');
	assert.equal(resultCase(partial.toolResults[1]?.payload.result), 'blocked');
	assert.match(partial.text, /dentist.*14:00.*15:00 UTC/i);
	assert.match(partial.text, /could not retrieve.*Chicago forecast.*calendar-only/i);
	assert.notEqual(weatherContexts[0], weatherContexts[1]);
	assert.equal(calendarCalls, 1);
	await jamis.generate('What is the weather outside?', { requestContext: new RequestContext() });
	const superseded = await jamis.generate([
		{ role: 'user', content: 'What is the weather outside?' },
		{ role: 'assistant', content: 'Which city?' },
		{ role: 'user', content: 'Help me write a birthday message instead.' },
	], { requestContext: new RequestContext() });
	assert.equal(superseded.toolCalls.length, 0);
	assert.equal(forecastCalls, 2);
	const invalidAccounts = await jamis.generate('Read my Gmail and calendar for 2026-10-10.', { requestContext: new RequestContext() });
	assert.notEqual(resultCase(invalidAccounts.toolResults[0]?.payload.result), 'completed', 'A throwing Gmail read cannot disappear from completion checks.');
	const partialAccounts = await jamis.generate('Read my Gmail and calendar for 2026-10-10 as a fresh assignment.', { requestContext: new RequestContext() });
	assert.equal(resultCase(partialAccounts.toolResults[0]?.payload.result), 'partial');
	assert.match(partialAccounts.text, /dentist.*Gmail is unavailable.*partial/i);
	assert.equal(calendarCalls, 3);
	const agents = await jamis.listAgents();
	assert.deepEqual(Object.keys(agents), ['fantasyBroadcastAgent']);
	assert(!Object.values(mastra.listAgents()).some(agent => ['weather-agent', 'research-agent', 'personal-accounts-agent'].includes(agent.id)));
	const tools = await jamis.listTools();
	assert(['invoke_weather', 'invoke_research', 'invoke_personal_accounts'].every(name => name in tools));
	assert(!Object.keys(await jamis.listTools()).includes('agent-weatherAgent'));
	const forged = new RequestContext();
	forged.setRaw('caller', { kind: 'agent', id: 'jamis' });
	await assert.rejects(() => tools.invoke_weather!.execute!({ question: 'Chicago forecast.' }, {
		requestContext: forged,
		agent: { agentId: 'jamis', toolCallId: 'forged', messages: [], suspend: async () => {} },
		observe: noopObserve,
	}), /not authorized/);
	assert.equal(forecastCalls, 2);
	return { locationCheck: true, freshWeatherCompletion: true, calendarWeatherPartial: true, accountFailurePartial: true, unrelatedSupersession: true, internalAgentsHidden: true, directAuthorityRejected: true, forecastCalls, calendarCalls };
}

export async function runJamisResearchFixture(mastra: Mastra) {
	const observations: unknown[] = [];
	const source = { title: 'Official fixture alerts', url: 'https://www.weather.gov/fixture-alerts', evidenceKind: 'scraped-webpage', evidence: 'The fixture area has no active alerts.', limitations: [] };
	const researchResult = { findings: [{ text: source.evidence, sourceNumbers: [1] }], sources: [source], limitations: [] };
	const search = createTool({ id: 'web-search', description: 'Discover a controlled public source.', inputSchema: z.object({ query: z.string() }), outputSchema: z.object({ results: z.array(z.object({ title: z.string(), url: z.string().url() })) }), execute: async (input) => {
		observations.push(input);
		return { results: [{ title: source.title, url: source.url }] };
	} });
	const scrape = createTool({
		id: 'web-scrape',
		description: 'Read controlled public source.',
		inputSchema: z.object({ url: z.string().url() }),
		outputSchema: z.object({ markdown: z.string() }),
		execute: async (input, context) => {
			observations.push(input, [...context.requestContext.entries()]);
			return { markdown: source.evidence };
		},
	});
	const answer = `${weatherResult.answer} There are no active alerts.[1]\nSources:\n[1] ${source.title}: ${source.url}`;
	const jamis = fixtureJamis(mastra, {
		model: boundaryModel([
			{ tool: 'invoke_weather', input: { question: 'Forecast for Chicago on 2026-10-10.' } },
			{ tool: 'invoke_research', input: { kind: 'operator_request' } },
			{ text: answer },
		]),
		specialists: {
			weather: { tools: { forecastTool: createTool({ id: forecastTool.id, description: forecastTool.description!, inputSchema: forecastTool.inputSchema!, outputSchema: forecastTool.outputSchema!, execute: async () => reading }) }, model: boundaryModel([
				{ tool: 'forecastTool', input: { location: 'Chicago', date: reading.date } },
				{ handback: { case: 'completed', result: weatherResult } },
			]) },
			research: { tools: { webSearch: search, webScrape: scrape }, model: boundaryModel([
				{ tool: 'webSearch', input: { query: 'Chicago official alerts' } },
				{ tool: 'webScrape', input: { url: source.url } },
				{ handback: { case: 'completed', result: researchResult } },
			], options => observations.push(options)) },
			personalAccounts: { tools: {}, model: boundaryModel([]) },
		},
	});
	mastra.addAgent(jamis, 'stage2-research-fixture');
	const context = new RequestContext();
	context.setRaw('privateSnapshot', PRIVATE_ARCHITECTURE_SENTINEL);
	const response = await jamis.generate([
		{ role: 'user', content: `Previous private conversation ${PRIVATE_ARCHITECTURE_SENTINEL}.` },
		{ role: 'assistant', content: 'Previous request finished.' },
		{ role: 'user', content: 'Give the Chicago forecast for 2026-10-10 and official alerts.' },
	], { requestContext: context });
	assert.deepEqual(response.toolCalls.map(call => call.payload.toolName), ['invoke_weather', 'invoke_research']);
	assert(response.toolResults.every(result => resultCase(result.payload.result) === 'completed'));
	assert.equal(response.text, answer);
	assert(!JSON.stringify(observations).includes(PRIVATE_ARCHITECTURE_SENTINEL));
	assert.match(response.text, /^The weather in Chicago, Illinois/);
	assert.match(response.text, /alerts\.\[1\]\nSources:\n\[1\] Official fixture alerts: https:\/\/www\.weather\.gov\/fixture-alerts$/);
	assert.equal((await jamis.getDefaultOptions()).toolCallConcurrency, 1);
	return { simpleReportOwner: 'jamis', citationsPreserved: true, privateContextIsolated: true };
}

export async function runJamisChannelFixture(mastra: Mastra, sql: SqlLike) {
	const replies: string[] = [];
	let forecastCalls = 0;
	const prompts: unknown[] = [];
	const adapter = createSendblueAdapter({ webhookSecret: 'stage2-fixture' });
	Object.assign(adapter, { isDM: (id: string) => !adapter.decodeThreadId(id).groupId });
	adapter.startTyping = async () => {};
	adapter.markRead = async () => {};
	adapter.fetchMessages = async () => {
		throw new Error('Platform history is unavailable in controlled DM acceptance.');
	};
	adapter.postMessage = async (threadId, message) => {
		const text = typeof message === 'string' ? message : 'markdown' in message ? message.markdown : 'text' in message ? message.text : undefined;
		assert.equal(typeof text, 'string');
		replies.push(text as string);
		const id = randomUUID();
		return { id, threadId, raw: { message_handle: id, status: 'SENT' } as SendblueMessagePayload };
	};
	const jamis = fixtureJamis(mastra, {
		memory: new Memory({ options: { semanticRecall: false, workingMemory: { enabled: false } } }),
		channels: {
			adapters: { sendblue: { adapter, gateway: false, toolDisplay: 'hidden' } },
			handlers: { onDirectMessage: (thread, message, defaultHandler, context) => handleSendblueDirectMessage(thread, message, defaultHandler, context, sql), onMention: false, onSubscribedMessage: false },
		},
		model: boundaryModel([
			{ tool: 'invoke_weather', input: { question: 'What is the weather outside tomorrow?' } },
			{ text: 'Which city?' },
			{ tool: 'invoke_weather', input: { question: 'Forecast for Chicago on 2026-10-10. The Operator answered the location check.' } },
			{ text: weatherResult.answer },
			{ tool: 'invoke_weather', input: { question: 'What is the weather outside?' } },
			{ text: 'Which city?' },
			{ text: 'Happy birthday. Have a good one.' },
			{ text: 'What would you like to know about Chicago?' },
			{ tool: 'invoke_personal_accounts', input: { question: 'Read my calendar for 2026-10-10.' } },
			{ tool: 'invoke_weather', input: { question: 'Forecast for Chicago on 2026-10-10.' } },
			{ text: 'Your dentist appointment is 14:00 to 15:00 UTC. I could not retrieve the Chicago forecast, so this is a calendar-only plan.' },
		], options => prompts.push(options)),
		specialists: {
			weather: { tools: { forecastTool: createTool({ id: forecastTool.id, description: forecastTool.description!, inputSchema: forecastTool.inputSchema!, outputSchema: forecastTool.outputSchema!, execute: async () => {
				forecastCalls += 1;
				if (forecastCalls === 2)
					throw new Error('Weather service is unavailable.');
				return reading;
			} }) }, model: boundaryModel([
				{ handback: need },
				{ tool: 'forecastTool', input: { location: 'Chicago', date: reading.date } },
				{ handback: { case: 'completed', result: weatherResult } },
				{ handback: need },
				{ tool: 'forecastTool', input: { location: 'Chicago', date: reading.date } },
				{ handback: { case: 'blocked', reason: 'Weather service is unavailable.', progress: null } },
			]) },
			research: { tools: {}, model: boundaryModel([]) },
			personalAccounts: { tools: { calendarEventsTool: createTool({ id: calendarEventsTool.id, description: calendarEventsTool.description!, inputSchema: calendarEventsTool.inputSchema!, outputSchema: calendarEventsTool.outputSchema!, execute: async () => ({ from: '2026-10-10T00:00:00.000Z', to: '2026-10-11T00:00:00.000Z', truncated: false, unavailableCalendars: [], events: [{ calendar: event.calendar, title: event.title, start: event.start, end: event.end }] }) }) }, model: boundaryModel([
				{ tool: 'calendarEventsTool', input: { daysAhead: 2 } },
				{ handback: { case: 'completed', result: accountResult } },
			]) },
		},
	});
	mastra.addAgent(jamis, 'stage2-channel-fixture');
	const channels = jamis.getChannels()!;
	await channels.initialize(mastra);
	try {
		for (const [index, content] of ['What is the weather outside tomorrow?', 'Chicago, on 2026-10-10.', 'What is the weather outside?', 'Write a birthday greeting instead.', 'Chicago', 'Plan 2026-10-10 using my calendar and Chicago weather.'].entries()) {
			const message = adapter.parseMessage({ message_handle: randomUUID(), content, from_number: process.env.JAMIS_ALLOWED_NUMBER!, to_number: '+15555550188', group_id: '', is_outbound: false, status: 'RECEIVED', service: 'iMessage', date_sent: new Date(Date.UTC(2026, 9, 10, 12, 0, index)).toISOString() } as SendblueMessagePayload);
			await channels.sdk!.processMessage(adapter, message.threadId, message);
			assert.equal(replies.length, index + 1, 'One controlled accepted reply per native DM.');
		}
		assert.deepEqual(replies, ['Which city?', weatherResult.answer, 'Which city?', 'Happy birthday. Have a good one.', 'What would you like to know about Chicago?', 'Your dentist appointment is 14:00 to 15:00 UTC. I could not retrieve the Chicago forecast, so this is a calendar-only plan.']);
		assert.equal(forecastCalls, 2);
		assert(JSON.stringify(prompts[2]).includes('Which city?'), 'The next DM receives the native session context.');
		return { nativeDmTurns: replies.length, controlledReplyAcceptances: replies.length, forecastCalls, clarificationAndSupersession: true, calendarWeatherPartial: true, externalMessages: 0 };
	}
	finally { await channels.sdk!.shutdown(); }
}

export async function runJamisNestedResearchFixture(mastra: Mastra) {
	const observations: unknown[] = [];
	const ownerPrompts: unknown[] = [];
	let sourceCalls = 0;
	const source = { title: 'United fixture policy', url: 'https://www.united.com/fixture-policy', evidenceKind: 'scraped-webpage', evidence: 'The fixture fare permits one personal item.', limitations: [] };
	const research = { findings: [{ text: source.evidence, sourceNumbers: [1] }], sources: [source], limitations: [] };
	const search = createTool({ id: 'web-search', description: 'Discover a controlled public policy.', inputSchema: z.object({ query: z.string() }), outputSchema: z.object({ results: z.array(z.object({ title: z.string(), url: z.string().url() })) }), execute: async (input, context) => {
		observations.push(input, [...context.requestContext.entries()]);
		return { results: [{ title: source.title, url: source.url }] };
	} });
	const message = { subject: 'United Basic Economy booking', from: 'booking@example.com', date: '2026-10-09T00:00:00.000Z', snippet: 'United Basic Economy', body: `United Basic Economy. Passenger details ${PRIVATE_ARCHITECTURE_SENTINEL}.` };
	const progress = { summary: 'The booking names United Basic Economy.', messages: [{ ...message, truncated: false }], events: [], issues: [], coverage: [{ source: 'gmail', status: 'complete', gaps: [] }], research: null, replyText: null };
	const refusal = 'Evidence status: insufficient. I could not verify the requested factual answer.';
	const researchNeed = { case: 'needs_help', need: { kind: 'input', question: 'Which public policy date?', missing: ['policy date'] }, progress: null };
	const gmail = createTool({ id: gmailSearchTool.id, description: gmailSearchTool.description!, inputSchema: gmailSearchTool.inputSchema!, outputSchema: gmailSearchTool.outputSchema!, execute: async () => ({ estimatedTotal: 1, messages: [message] }) });
	const scrape = createTool({ id: 'web-scrape', description: 'Read a controlled public policy.', inputSchema: z.object({ url: z.string().url() }), outputSchema: z.object({ markdown: z.string() }), execute: async (input, context) => {
		sourceCalls += 1;
		observations.push(input, [...context.requestContext.entries()]);
		return { markdown: source.evidence };
	} });
	const jamis = fixtureJamis(mastra, {
		model: boundaryModel([
			{ tool: 'invoke_personal_accounts', input: { question: `Check the public carry-on policy from my booking. Private context ${PRIVATE_ARCHITECTURE_SENTINEL}.` } },
			{ text: `${source.evidence}[1]\nSources:\n[1] ${source.title}: ${source.url}` },
			{ tool: 'invoke_personal_accounts', input: { question: 'Check the booking public policy for the requested date.' } },
			{ text: 'Which public policy date?' },
			{ tool: 'invoke_personal_accounts', input: { question: 'Check the booking public policy again as a fresh assignment.' } },
			{ text: 'I found the booking, but I could not verify the requested factual answer.' },
			{ tool: 'invoke_personal_accounts', input: { question: 'Check an unsupported private policy question.' } },
			{ text: 'That question cannot be sent to public research.' },
		]),
		specialists: {
			personalAccounts: { tools: { gmailSearchTool: gmail }, model: boundaryModel([
				{ tool: 'gmailSearchTool', input: { query: 'subject:booking', maxResults: 1 } },
				{ tool: 'invoke_research', input: { kind: 'carry_on_allowance', subjectId: 'united-basic-economy' } },
				{ handback: { case: 'completed', result: { ...progress, research } } },
				{ tool: 'gmailSearchTool', input: { query: 'subject:booking', maxResults: 1 } },
				{ tool: 'invoke_research', input: { kind: 'carry_on_allowance', subjectId: 'united-basic-economy' } },
				{ handback: { ...researchNeed, progress } },
				{ tool: 'gmailSearchTool', input: { query: 'subject:booking', maxResults: 1 } },
				{ tool: 'invoke_research', input: { kind: 'carry_on_allowance', subjectId: 'united-basic-economy' } },
				{ handback: { case: 'partial', result: progress, gaps: ['Public carry-on policy could not be verified.'] } },
				{ tool: 'invoke_research', input: { kind: 'carry_on_allowance', subjectId: PRIVATE_ARCHITECTURE_SENTINEL } },
				{ handback: { case: 'blocked', reason: 'This question cannot be expressed using the permitted public labels.', progress: null } },
			], options => ownerPrompts.push(options)) },
			research: { tools: { webSearch: search, webScrape: scrape }, model: boundaryModel([
				{ tool: 'webSearch', input: { query: 'United Basic Economy public carry-on allowance' } },
				{ tool: 'webScrape', input: { url: source.url } },
				{ handback: { case: 'completed', result: research } },
				{ handback: researchNeed },
				{ handback: { case: 'blocked', reason: refusal, progress: null } },
			], options => observations.push(options)) },
			weather: { tools: {}, model: boundaryModel([]) },
		},
	});
	mastra.addAgent(jamis, 'stage2-nested-research-fixture');
	const responses = [];
	for (const question of ['Check the carry-on policy for my booking.', 'Check the date-specific policy.', 'Check the public policy with a fresh read.', 'Check an unsupported private policy question.'])
		responses.push(await jamis.generate(question, { requestContext: new RequestContext() }));
	assert.deepEqual(responses.map(response => response.toolCalls.map(call => call.payload.toolName)), Array.from({ length: 4 }, () => ['invoke_personal_accounts']));
	assert.deepEqual(responses.map(response => resultCase(response.toolResults[0]?.payload.result)), ['completed', 'needs_help', 'partial', 'blocked']);
	assert.equal(responses[1]!.text, researchNeed.need.question);
	assert.equal(sourceCalls, 1);
	assert(!JSON.stringify(observations).includes(PRIVATE_ARCHITECTURE_SENTINEL));
	assert.equal(observations.filter(value => value && typeof value === 'object' && 'prompt' in value).length, 5, 'Unsupported private projection must not invoke Research.');
	assert(JSON.stringify(ownerPrompts).includes(source.evidence));
	assert(JSON.stringify(ownerPrompts).includes(researchNeed.need.question));
	assert(JSON.stringify(ownerPrompts).includes(refusal));
	return { nestedOwnerHandback: true, nestedNeedAndRefusal: true, privateContextIsolated: true, unsupportedProjectionDenied: true, sourceCalls };
}

export async function runJamisWeatherValidationFixture(mastra: Mastra) {
	const { location: _, ...missingLocation } = reading;
	const invalidReadings = [
		{ ...reading, location: 'Paris, France' },
		{ ...reading, date: '2026-10-11' },
		missingLocation,
	];
	for (const [index, invalid] of invalidReadings.entries()) {
		const jamis = fixtureJamis(mastra, {
			model: boundaryModel([{ tool: 'invoke_weather', input: { question: 'Forecast for Chicago on 2026-10-10.' } }, { text: 'I could not verify the forecast.' }]),
			specialists: {
				weather: { tools: { forecastTool: createTool({ id: forecastTool.id, description: forecastTool.description!, inputSchema: forecastTool.inputSchema!, outputSchema: forecastTool.outputSchema!, execute: async () => reading }) }, model: boundaryModel([
					{ tool: 'forecastTool', input: { location: 'Chicago', date: reading.date } },
					{ handback: { case: 'completed', result: { answer: `The weather in ${'location' in invalid ? invalid.location : 'Chicago, Illinois'} will be clear.`, reading: { kind: 'forecast', ...invalid } } } },
				]) },
				research: { tools: {}, model: boundaryModel([]) },
				personalAccounts: { tools: {}, model: boundaryModel([]) },
			},
		});
		mastra.addAgent(jamis, `stage2-invalid-weather-${index}`);
		const response = await jamis.generate('Forecast for Chicago on 2026-10-10.', { requestContext: new RequestContext() });
		assert.notEqual(resultCase(response.toolResults[0]?.payload.result), 'completed', 'Missing or mismatched evidence must not be accepted.');
		assert.equal(response.text, 'I could not verify the forecast.');
	}
	return { missingPlaceRejected: true, mismatchedPlaceRejected: true, mismatchedDateRejected: true };
}
