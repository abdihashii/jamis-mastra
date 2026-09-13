import type { ChannelHandlerContext } from '@mastra/core/channels';
import type { MemoryStorage } from '@mastra/core/storage';
import type { Message, Thread } from 'chat';
import type { SendblueMessagePayload } from 'chat-adapter-sendblue';
import type { FantasyConfig } from '../config';

import { describe, expect, it, spyOn } from 'bun:test';
import { InMemoryStore } from '@mastra/core/storage';

import { createSendblueAdapter } from 'chat-adapter-sendblue';
import { createFantasyGroupHandler, persistFantasyGroupMessage } from '../ingest';

const config: FantasyConfig = {
	sendblueGroupId: 'fantasy-group-1',
	sleeperLeagueId: '1234567890',
	managerMap: { '+15551230001': 'sleeper-user-1' },
	recapTimezone: 'America/Chicago',
};

const THREAD_ID = 'fantasy-group-fantasy-group-1';

// Fixtures go through the real adapter so attachment/text shapes match what
// production feeds the handler.
const sendblueAdapter = createSendblueAdapter({
	apiKey: 'test',
	apiSecret: 'test',
	defaultFromNumber: '+15551230000',
	webhookSecret: 'test',
});

function makeGroupMessage(overrides: Partial<SendblueMessagePayload> = {}): Message<SendblueMessagePayload> {
	return sendblueAdapter.parseMessage({
		content: 'gg everyone',
		is_outbound: false,
		status: 'RECEIVED',
		error_code: null,
		error_message: null,
		error_reason: null,
		error_detail: null,
		message_handle: 'handle-1',
		date_sent: '2026-09-07T15:00:00.000Z',
		date_updated: '2026-09-07T15:00:00.000Z',
		from_number: '+15551230001',
		number: '+15551230001',
		to_number: '+15551230000',
		was_downgraded: null,
		media_url: '',
		message_type: 'group',
		group_id: 'fantasy-group-1',
		participants: ['+15551230000', '+15551230001', '+15551230002'],
		send_style: '',
		opted_out: false,
		sendblue_number: '+15551230000',
		service: 'iMessage',
		group_display_name: null,
		...overrides,
	});
}

async function memoryFor(store = new InMemoryStore()) {
	const memory = await store.getStore('memory');
	if (!memory)
		throw new Error('InMemoryStore has no memory domain');
	return memory;
}

// PostgresStore.saveMessages throws when the thread is missing
// (@mastra/pg/dist memory domain); InMemoryStore does a blind Map.set. Mimic
// the Postgres contract so a regressed thread-ensure fails here, not in prod.
async function pgLikeMemory(store = new InMemoryStore()): Promise<MemoryStorage> {
	const memory = await memoryFor(store);
	const innerSave = memory.saveMessages.bind(memory);
	memory.saveMessages = async (args) => {
		for (const message of args.messages) {
			if (!message.threadId || !(await memory.getThreadById({ threadId: message.threadId }))) {
				throw new Error(`Thread ${message.threadId} not found`);
			}
		}
		return innerSave(args);
	};
	return memory;
}

describe('persistFantasyGroupMessage', () => {
	it('stores text, sender, timestamps, and participants in the dedicated thread', async () => {
		const memory = await pgLikeMemory();
		await persistFantasyGroupMessage(memory, config, makeGroupMessage());

		const thread = await memory.getThreadById({ threadId: THREAD_ID });
		expect(thread?.resourceId).toBe(THREAD_ID);

		const { messages } = await memory.listMessagesById({ messageIds: ['handle-1'] });
		expect(messages).toHaveLength(1);
		const [message] = messages;
		expect(message.threadId).toBe(THREAD_ID);
		expect(message.resourceId).toBe(THREAD_ID);
		expect(message.role).toBe('user');
		expect(message.createdAt.toISOString()).toBe('2026-09-07T15:00:00.000Z');

		const textPart = message.content.parts.find(part => part.type === 'text');
		expect(textPart && 'text' in textPart ? textPart.text : undefined).toBe('gg everyone');

		const metadata = message.content.metadata as Record<string, unknown>;
		expect(metadata.senderNumber).toBe('+15551230001');
		expect(metadata.groupId).toBe('fantasy-group-1');
		expect(metadata.participants).toEqual(['+15551230000', '+15551230001', '+15551230002']);
		expect(metadata.sentAt).toBe('2026-09-07T15:00:00.000Z');
	});

	it('stores attachment metadata without the media body', async () => {
		const memory = await pgLikeMemory();
		await persistFantasyGroupMessage(
			memory,
			config,
			makeGroupMessage({ message_handle: 'handle-2', media_url: 'https://cdn.example.com/img.png' }),
		);

		const { messages } = await memory.listMessagesById({ messageIds: ['handle-2'] });
		expect(messages[0].content.experimental_attachments).toEqual([
			{ name: 'img.png', contentType: 'image/png', url: 'https://cdn.example.com/img.png' },
		]);
	});

	it('is idempotent across webhook replays', async () => {
		const memory = await pgLikeMemory();
		const message = makeGroupMessage();
		await persistFantasyGroupMessage(memory, config, message);
		await persistFantasyGroupMessage(memory, config, message);

		const { total } = await memory.listMessages({ threadId: THREAD_ID });
		expect(total).toBe(1);
	});

	it('keeps one thread across many group messages', async () => {
		const memory = await pgLikeMemory();
		await persistFantasyGroupMessage(memory, config, makeGroupMessage({ message_handle: 'h-1' }));
		await persistFantasyGroupMessage(memory, config, makeGroupMessage({ message_handle: 'h-2' }));

		const { total } = await memory.listMessages({ threadId: THREAD_ID });
		expect(total).toBe(2);
	});

	it('skips messages with unreadable Sendblue timestamps instead of inventing one', async () => {
		const memory = await pgLikeMemory();
		const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

		await persistFantasyGroupMessage(memory, config, makeGroupMessage({ date_sent: 'not-a-date' }));

		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
		const { messages } = await memory.listMessagesById({ messageIds: ['handle-1'] });
		expect(messages).toHaveLength(0);
	});
});

describe('createFantasyGroupHandler', () => {
	const thread = {} as Thread;

	function ctxFor(store: InMemoryStore): ChannelHandlerContext {
		return { mastra: { getStorage: () => store } } as unknown as ChannelHandlerContext;
	}

	async function defaultHandlerThatMustNotRun() {
		throw new Error('must never run');
	}

	async function persistedTotal(store: InMemoryStore) {
		const memory = await memoryFor(store);
		const { messages } = await memory.listMessagesById({ messageIds: ['handle-1'] });
		return messages.length;
	}

	it('persists the fantasy group without calling the agent handler', async () => {
		const store = new InMemoryStore();
		const handler = createFantasyGroupHandler(config);
		await handler(thread, makeGroupMessage(), defaultHandlerThatMustNotRun, ctxFor(store));
		expect(await persistedTotal(store)).toBe(1);
	});

	it('ignores other groups', async () => {
		const store = new InMemoryStore();
		const handler = createFantasyGroupHandler(config);
		await handler(thread, makeGroupMessage({ group_id: 'some-other-group' }), defaultHandlerThatMustNotRun, ctxFor(store));
		expect(await persistedTotal(store)).toBe(0);
	});

	it('ignores everything when fantasy config is disabled', async () => {
		const store = new InMemoryStore();
		const handler = createFantasyGroupHandler(null);
		await handler(thread, makeGroupMessage(), defaultHandlerThatMustNotRun, ctxFor(store));
		expect(await persistedTotal(store)).toBe(0);
	});

	it('swallows persistence failures instead of failing the webhook', async () => {
		const store = new InMemoryStore();
		(store as { getStore: unknown }).getStore = async () => {
			throw new Error('db down');
		};
		const handler = createFantasyGroupHandler(config);
		const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

		// Must resolve, never reject: Mastra already acked the webhook.
		await handler(thread, makeGroupMessage(), defaultHandlerThatMustNotRun, ctxFor(store));

		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});
