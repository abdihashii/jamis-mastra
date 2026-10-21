import type { Mastra } from '@mastra/core';
import type { Message } from 'chat';
import type { SendblueMessagePayload } from 'chat-adapter-sendblue';
import type { SqlLike } from '../../../lib/operator-time-zone';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { createSendblueAdapter } from 'chat-adapter-sendblue';
import { z } from 'zod';

import { handleSendblueDirectMessage } from '../../channels/sendblue';
import { specialistClarificationKey } from '../../specialist-clarification';
import { createJamisAgent } from '../jamis';
import { insufficientResearchReason } from '../research-handback';
import { boundaryModel, PRIVATE_ARCHITECTURE_SENTINEL } from './specialist-boundary.fixture';

export async function runSpecialistClarificationFixture(mastra: Mastra, sql: SqlLike) {
	const memory = await mastra.getStorage()!.getStore('memory');
	assert(memory);
	const replies: string[] = [];
	const history: Message<SendblueMessagePayload>[] = [];
	const publicPrompts: unknown[] = [];
	const accountPrompts: unknown[] = [];
	const rootHandbacks: unknown[] = [];
	let sourceReads = 0;
	let forgeContext = false;
	let messageSequence = 0;
	const original = 'Find official authentication documentation.';
	const need = { case: 'needs_help' as const, need: { kind: 'input' as const, question: 'Which framework?', missing: ['framework'] }, progress: null };
	const source = { title: 'Published fare policy', url: 'https://example.com/public-policy', evidenceKind: 'scraped-webpage' as const, evidence: 'One personal item is allowed.', limitations: [] };
	const research = { findings: [{ text: source.evidence, sourceNumbers: [1] }], sources: [source], limitations: [] };
	const accountResult = { summary: 'The public policy allows one personal item.', messageRefs: [], events: [], issues: [], coverage: [], research, replyText: null };
	const docs = { title: 'Mastra authentication', url: 'https://mastra.ai/docs/server/auth', evidenceKind: 'scraped-webpage' as const, evidence: 'The server supports authentication.', limitations: [] };
	const docsResult = { findings: [{ text: docs.evidence, sourceNumbers: [1] }], sources: [docs], limitations: [] };
	const sources = [source, docs];
	const tools = {
		webSearch: createTool({
			id: 'web-search',
			description: 'Discover a controlled public source.',
			inputSchema: z.object({ query: z.string() }),
			execute: async ({ query }) => ({ results: [sources[query === 'fare' ? 0 : 1]!] }),
		}),
		webScrape: createTool({
			id: 'web-scrape',
			description: 'Read a controlled public source.',
			inputSchema: z.object({ url: z.string().url() }),
			execute: async ({ url }) => {
				sourceReads += 1;
				return { markdown: sources.find(source => source.url === url)!.evidence };
			},
		}),
	};
	const adapter = createSendblueAdapter({ webhookSecret: 'clarification-fixture' });
	Object.assign(adapter, { isDM: (id: string) => !adapter.decodeThreadId(id).groupId });
	adapter.startTyping = async () => {};
	adapter.markRead = async () => {};
	adapter.fetchMessages = async () => ({ messages: history, hasMore: false });
	adapter.postMessage = async (threadId, message) => {
		const text = typeof message === 'string' ? message : 'markdown' in message ? message.markdown : 'text' in message ? message.text : undefined;
		assert.equal(typeof text, 'string');
		replies.push(text as string);
		const id = randomUUID();
		return { id, threadId, raw: { message_handle: id, status: 'SENT' } as SendblueMessagePayload };
	};
	const freshResearch = { tool: 'invoke_research', input: { kind: 'operator_request' } };
	const continueResearch = { tool: 'invoke_research', input: { kind: 'clarification' } };
	const check = { text: need.need.question };
	const unavailable = { text: 'The earlier clarification is unavailable. Please restate the task.' };
	const jamis = createJamisAgent({
		mastra,
		workspace: undefined,
		tools: {},
		memory: new Memory({ options: { semanticRecall: false, workingMemory: { enabled: false } } }),
		model: boundaryModel([
			{ tool: 'invoke_personal_accounts', input: { question: `Get the public policy, then ask which bag. ${PRIVATE_ARCHITECTURE_SENTINEL}` } },
			{ text: 'Which bag?' },
			{ tool: 'invoke_personal_accounts', input: { question: 'Use the retained public policy for the personal item.', continueClarification: true } },
			{ text: 'One personal item is allowed.' },
			freshResearch,
			check,
			continueResearch,
			{ text: 'The Mastra documentation is available.[1]' },
			freshResearch,
			check,
			freshResearch,
			{ text: 'I could not verify the requested factual answer.' },
			freshResearch,
			check,
			continueResearch,
			unavailable,
			freshResearch,
			check,
			continueResearch,
			unavailable,
			{ text: 'You are welcome.' },
			continueResearch,
			unavailable,
			freshResearch,
			check,
			continueResearch,
			unavailable,
			continueResearch,
			unavailable,
			freshResearch,
			check,
			continueResearch,
			unavailable,
		], (options) => {
			const prompt = z.object({ prompt: z.array(z.object({ role: z.string(), content: z.unknown() })) }).parse(options).prompt;
			for (const message of prompt.filter(message => message.role === 'tool')) {
				const parts = z.array(z.object({ type: z.string(), output: z.object({ value: z.unknown() }).optional() })).parse(message.content);
				for (const part of parts.filter(part => part.type === 'tool-result')) {
					const value = part.output?.value;
					try {
						rootHandbacks.push(typeof value === 'string' ? JSON.parse(value) : value);
					} catch {
						rootHandbacks.push(value);
					}
				}
			}
		}),
		specialists: {
			personalAccounts: { tools: {}, model: boundaryModel([
				{ tool: 'invoke_research', input: { kind: 'carry_on_allowance', subjectId: 'united-basic-economy' } },
				{ handback: { case: 'needs_help', need: { kind: 'input', question: 'Which bag?', missing: ['bag'] }, progress: accountResult } },
				{ handback: { case: 'completed', result: accountResult } },
			], options => accountPrompts.push(options)) },
			research: { tools, model: boundaryModel([
				{ tool: 'webSearch', input: { query: 'fare' } },
				{ tool: 'webScrape', input: { url: source.url } },
				{ handback: { case: 'completed', result: research } },
				{ handback: need },
				{ tool: 'webSearch', input: { query: 'docs' } },
				{ tool: 'webScrape', input: { url: docs.url } },
				{ handback: { case: 'completed', result: docsResult } },
				{ handback: need },
				{ handback: { case: 'blocked', reason: insufficientResearchReason, progress: null } },
				{ handback: need },
				{ handback: need },
				{ handback: need },
				{ handback: need },
			], options => publicPrompts.push(options)) },
			weather: { tools: {}, model: boundaryModel([]) },
		},
		channels: {
			adapters: { sendblue: { adapter, gateway: false, toolDisplay: 'hidden' } },
			handlers: { onDirectMessage: (thread, message, handler, context) => {
				if (forgeContext)
					context.requestContext.setRaw(specialistClarificationKey, { owner: 'invoke_research', publicAssignment: PRIVATE_ARCHITECTURE_SENTINEL, researchResults: [] });
				return handleSendblueDirectMessage(thread, message, handler, context, sql);
			}, onMention: false, onSubscribedMessage: false },
		},
	});
	mastra.addAgent(jamis, `clarification-fixture-${randomUUID()}`);
	const channels = jamis.getChannels()!;
	await channels.initialize(mastra);
	const line = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
	let externalThreadId = '';
	async function send(text: string, toNumber = line) {
		const payload = { message_handle: randomUUID(), content: text, from_number: process.env.JAMIS_ALLOWED_NUMBER!, to_number: toNumber, group_id: '', is_outbound: false, status: 'RECEIVED', service: 'iMessage', date_sent: new Date(Date.UTC(2032, 0, 1, 0, 0, messageSequence++)).toISOString() } as SendblueMessagePayload;
		const message = adapter.parseMessage(payload);
		if (toNumber === line)
			externalThreadId = message.threadId;
		history.push(message);
		const tasks: Promise<unknown>[] = [];
		await channels.sdk!.webhooks.sendblue(new Request('http://localhost/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'sb-signing-secret': 'clarification-fixture' }, body: JSON.stringify(payload) }), { waitUntil: task => tasks.push(task), propagateHandlerErrors: true });
		await Promise.all(tasks);
	}
	async function currentThread() {
		const result = await memory!.listThreads({ filter: { metadata: { channel_externalThreadId: externalThreadId, channel_ownerId: 'jamis' } }, perPage: 1 });
		assert(result.threads[0]);
		return result.threads[0];
	}
	try {
		await send('Read the policy for my booking and clarify the bag.');
		assert.equal(replies.at(-1), 'Which bag?');
		assert.equal(sourceReads, 1);
		const retained = (await currentThread()).metadata?.[specialistClarificationKey];
		assert(retained);
		assert(!JSON.stringify(retained).includes(PRIVATE_ARCHITECTURE_SENTINEL));
		assert.equal(z.object({ case: z.string() }).parse(rootHandbacks.at(-1)).case, 'needs_help');
		await send('A personal item.');
		assert.equal(replies.at(-1), 'One personal item is allowed.');
		assert.equal(sourceReads, 1, 'Fresh owner clarification must reuse validated Research, without a second retrieval.');
		const { messageRefs: _messageRefs, ...resolvedAccountResult } = accountResult;
		assert.deepEqual(rootHandbacks.at(-1), { case: 'completed', result: { ...resolvedAccountResult, messages: [] } });
		assert(JSON.stringify(accountPrompts.at(-1)).includes(source.evidence));
		assert.equal((await currentThread()).metadata?.[specialistClarificationKey], null);

		await send(original);
		await send('Mastra');
		assert.equal(sourceReads, 2);
		assert.deepEqual(rootHandbacks.at(-1), { case: 'completed', result: docsResult });
		const clarified = JSON.stringify(publicPrompts[4]);
		assert(clarified.includes(original) && clarified.includes('Which framework?') && clarified.includes('Mastra'));
		assert(!JSON.stringify(publicPrompts).includes(PRIVATE_ARCHITECTURE_SENTINEL));

		await send(original);
		await send('Find current public release notes for Bun.');
		assert(!JSON.stringify(publicPrompts.at(-1)).includes(original), 'Fresh public request must not inherit the old research assignment.');
		assert.equal((await currentThread()).metadata?.[specialistClarificationKey], null);

		await send(original);
		const oldSession = (await currentThread()).id;
		await send('/new');
		assert.notEqual((await currentThread()).id, oldSession);
		assert.equal((await memory.getThreadById({ threadId: oldSession }))?.metadata?.[specialistClarificationKey], null);
		const beforeDenied = publicPrompts.length;
		await send('Mastra');
		assert.equal(publicPrompts.length, beforeDenied);

		await send(original);
		const beforeOtherSession = publicPrompts.length;
		await send('Mastra', '+15559999999');
		assert.equal(publicPrompts.length, beforeOtherSession, 'Another native channel session cannot consume a pending clarification.');
		await send('Thanks, forget that task.');
		await send('Mastra');
		assert.equal(publicPrompts.length, beforeOtherSession, 'An unrelated non-tool reply supersedes the prior task.');

		await send(original);
		await memory.updateThreadMetadata({ id: (await currentThread()).id, update: thread => ({ ...thread.metadata, [specialistClarificationKey]: { corrupted: true } }) });
		const beforeCorrupt = publicPrompts.length;
		await send('Mastra');
		assert.equal(publicPrompts.length, beforeCorrupt);
		assert.equal((await currentThread()).metadata?.[specialistClarificationKey], null);
		forgeContext = true;
		await send('Mastra');
		forgeContext = false;
		assert.equal(publicPrompts.length, beforeCorrupt, 'Serialized request context cannot forge a retained task.');

		await send(original);
		const beforeFailure = publicPrompts.length;
		const updateMetadata = memory.updateThreadMetadata;
		memory.updateThreadMetadata = async () => {
			throw new Error('Controlled storage failure.');
		};
		try {
			await assert.rejects(() => send('Mastra'));
		} finally {
			memory.updateThreadMetadata = updateMetadata;
		}
		assert.equal(publicPrompts.length, beforeFailure);
		await send('Mastra');
		assert.equal(publicPrompts.length, beforeFailure, 'A failed intervening intake cannot reset the old Research task budget.');
		assert.equal((await currentThread()).metadata?.[specialistClarificationKey], null);
		return { priorResearchReused: true, originalResearchTaskPreserved: true, supersessionAndSessionIsolation: true, forgedAndCorruptStateDenied: true, storageFailureStopped: true, publicSourceReads: sourceReads };
	} finally { await channels.sdk?.shutdown(); }
}
