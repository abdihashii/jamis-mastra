import type { ChannelHandler } from '@mastra/core/channels';
import type { MastraDBMessage } from '@mastra/core/memory';
import type { MemoryStorage } from '@mastra/core/storage';
import type { Message } from 'chat';

import type { SendblueMessagePayload } from 'chat-adapter-sendblue';

import type { FantasyConfig } from './config';
import { isGroupMessage } from '../../mastra/channels/sendblue';

function fantasyThreadId(groupId: string): string {
	return `fantasy-group-${groupId}`;
}

/**
 * Writes one Fantasy group message to the dedicated Mastra thread. Idempotent:
 * message.id is the Sendblue message handle and the store upserts by id, so a
 * replayed webhook converges to one row. Phone numbers and group text stay in
 * Postgres; they must never reach ClickHouse logs.
 */
export async function persistFantasyGroupMessage(
	memory: MemoryStorage,
	config: FantasyConfig,
	message: Message<SendblueMessagePayload>,
): Promise<void> {
	const raw = message.raw;
	const threadId = fantasyThreadId(config.sendblueGroupId);

	if (!message.id) {
		console.error('[fantasy-recap] group message has no Sendblue handle; skipping persist');
		return;
	}

	if (!(await memory.getThreadById({ threadId }))) {
		const now = new Date();
		await memory.saveThread({
			thread: { id: threadId, resourceId: threadId, title: 'Fantasy group', createdAt: now, updatedAt: now },
		});
	}

	const sentAt = new Date(raw.date_sent);
	if (Number.isNaN(sentAt.getTime())) {
		console.error(`[fantasy-recap] unreadable Sendblue date_sent for handle ${message.id}; skipping persist`);
		return;
	}

	const attachments = message.attachments
		.filter(attachment => attachment.url)
		.map(attachment => ({
			name: attachment.name,
			contentType: attachment.mimeType,
			url: attachment.url as string,
		}));

	const dbMessage: MastraDBMessage = {
		id: message.id,
		threadId,
		resourceId: threadId,
		role: 'user',
		type: 'text',
		createdAt: sentAt,
		content: {
			format: 2,
			parts: [{ type: 'text', text: message.text }],
			...(attachments.length > 0 ? { experimental_attachments: attachments } : {}),
			metadata: {
				channel: 'sendblue',
				groupId: config.sendblueGroupId,
				senderNumber: raw.from_number,
				participants: raw.participants,
				sentAt: raw.date_sent,
			},
		},
	};

	await memory.saveMessages({ messages: [dbMessage] });
}

/**
 * Passive channel handler per ADR 0017: the configured Fantasy group persists
 * only, every other channel event stays ignored. Never invokes the default
 * agent handler, and never throws — Mastra acknowledges the webhook before
 * this runs, so persistence failures are caught and logged.
 */
export function createFantasyGroupHandler(config: FantasyConfig | null): ChannelHandler {
	return async (_thread, message, _defaultHandler, ctx) => {
		if (!config || !isGroupMessage(message, config.sendblueGroupId))
			return;

		try {
			const memory = await ctx.mastra?.getStorage()?.getStore('memory');
			if (!memory) {
				console.error('[fantasy-recap] memory storage unavailable; dropping group message');
				return;
			}
			await persistFantasyGroupMessage(memory, config, message as Message<SendblueMessagePayload>);
		} catch (error) {
			console.error(`[fantasy-recap] failed to persist group message: ${(error as Error).message}`);
		}
	};
}
