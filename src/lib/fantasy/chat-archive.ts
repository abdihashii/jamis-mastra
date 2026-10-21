import type { MastraDBMessage } from '@mastra/core/memory';
import type { MemoryStorage } from '@mastra/core/storage';
import type { FantasyConfig } from './config';
import type { SleeperManager } from './sleeper';
import { z } from 'zod';

const RECAP_AWARD_HEADINGS = ['Manager of the Week', 'Loser of the Week', 'Match of the Week']
	.map(heading => new RegExp(`(?:^|\\n)[^\\p{L}\\p{N}\\n]*${heading}:`, 'iu'));
const MAX_MESSAGES = 1_000;
const MAX_CHARACTERS = 100_000;
const instant = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString());
export const chatWindowSchema = z.object({ startAtUtc: instant, endAtUtc: instant }).strict().refine(value => value.startAtUtc < value.endAtUtc);
export type ChatWindow = z.infer<typeof chatWindowSchema>;

export function isPriorRecap(text: string): boolean {
	// Canonical renderer headers cover later parts without award headings, not header-only chatter.
	return /(?:^|\n)Week (?:[1-9]|1\d|2[0-2]) Recap(?: \((?:[12]\/2|[123]\/3)\))?\n\n\s*\S/u.test(text)
		|| RECAP_AWARD_HEADINGS.every(heading => heading.test(text));
}

export interface ChatSource {
	id: string;
	rosterId: number;
	sender: string;
	createdAtUtc: string;
	/** Original single text part, never trimmed, joined, normalized or redacted. */
	text: string;
	trust: 'untrusted-source-data';
	/** Structural admission is not permission to publish private conversation. */
	quoteReview: 'required';
}

export interface ArchivedChatEvidence {
	status: 'complete' | 'empty' | 'partial' | 'truncated' | 'unavailable';
	window: ChatWindow;
	windowBasis: 'caller-supplied';
	coverage: 'archived-window-only';
	readCount: number;
	excluded: { unmapped: number; privateContact: number; recap: number; reaction: number; nonText: number };
	gaps: string[];
	sources: ChatSource[];
}

function emptyChat(window: ChatWindow): ArchivedChatEvidence {
	return {
		status: 'unavailable',
		window,
		windowBasis: 'caller-supplied',
		coverage: 'archived-window-only',
		readCount: 0,
		excluded: { unmapped: 0, privateContact: 0, recap: 0, reaction: 0, nonText: 0 },
		gaps: [],
		sources: [],
	};
}

function hasPrivateContact(text: string, config: FantasyConfig): boolean {
	return Object.keys(config.managerMap).some(number => text.includes(number))
		|| (text.includes('@') && /(?:^|[^\w.+-])[\w.+-]+@[\w.-]+\.[A-Z]{2,}/i.test(text))
		|| /\+\d[\d ()-]{8,}\d/.test(text);
}

/** This excludes recognizable Tapback text, not a claim to identify every reaction. */
function isReaction(text: string): boolean {
	return /^(?:Loved|Liked|Disliked|Laughed at|Emphasized|Questioned) [“"][\s\S]*[”"]$/u.test(text.trim());
}

/** Read-only: the caller must supply a store opened without schema initialization. */
export async function readArchivedChat(
	memory: Pick<MemoryStorage, 'getThreadById' | 'listMessages'> | null,
	config: FantasyConfig,
	managers: SleeperManager[],
	window: ChatWindow,
	now: Date,
): Promise<ArchivedChatEvidence> {
	const out = emptyChat(window);
	const parsed = chatWindowSchema.safeParse(window);
	if (!parsed.success || !Number.isFinite(now.getTime()) || parsed.data.endAtUtc > now.toISOString()) {
		out.gaps.push('invalid_or_unclosed_chat_window');
		return out;
	}
	out.window = parsed.data;
	if (!memory) {
		out.gaps.push('archive_unavailable');
		return out;
	}
	const threadId = `fantasy-group-${config.sendblueGroupId}`;
	let messages: MastraDBMessage[];
	let hasMore: boolean;
	try {
		const thread = await memory.getThreadById({ threadId });
		if (!thread || thread.id !== threadId || thread.resourceId !== threadId) {
			out.gaps.push('archive_thread_unavailable');
			return out;
		}
		const page = await memory.listMessages({
			threadId,
			page: 0,
			perPage: MAX_MESSAGES,
			includeTotal: false,
			filter: { dateRange: {
				start: new Date(parsed.data.startAtUtc),
				end: new Date(parsed.data.endAtUtc),
				endExclusive: true,
			} },
			orderBy: { field: 'createdAt', direction: 'ASC' },
		});
		if (!Array.isArray(page.messages) || typeof page.hasMore !== 'boolean') {
			out.gaps.push('malformed_archive_response');
			return out;
		}
		messages = page.messages.slice(0, MAX_MESSAGES);
		hasMore = page.hasMore || page.messages.length > MAX_MESSAGES;
	} catch {
		out.gaps.push('archive_unavailable');
		return out;
	}
	out.readCount = messages.length;
	if (hasMore)
		out.gaps.push('archive_message_limit');
	const managerByUser = new Map(managers.map(manager => [manager.userId, manager]));
	const sources = new Map<string, ChatSource>();
	const seen = new Set<string>();
	let characters = 0;
	let malformed = false;
	let textTruncated = false;
	for (const message of messages) {
		try {
			const metadata = message.content.metadata ?? {};
			if (message.threadId !== threadId || message.resourceId !== threadId || message.role !== 'user'
				|| metadata.channel !== 'sendblue' || metadata.groupId !== config.sendblueGroupId) {
				out.gaps.push('archive_scope_mismatch');
				malformed = true;
				continue;
			}
			if (typeof message.id !== 'string' || !/^[\w.:-]{1,200}$/.test(message.id)) {
				malformed = true;
				continue;
			}
			if (seen.has(message.id)) {
				sources.delete(message.id);
				malformed = true;
				out.gaps.push('duplicate_message_identity');
				continue;
			}
			seen.add(message.id);
			const timestamp = message.createdAt instanceof Date ? message.createdAt.getTime() : Number.NaN;
			const originalTime = instant.safeParse(metadata.sentAt);
			if (!Number.isFinite(timestamp) || !originalTime.success || Date.parse(originalTime.data) !== timestamp
				|| timestamp < Date.parse(parsed.data.startAtUtc) || timestamp >= Date.parse(parsed.data.endAtUtc)) {
				malformed = true;
				out.gaps.push('message_time_unverified');
				continue;
			}
			const senderNumber = typeof metadata.senderNumber === 'string' ? metadata.senderNumber : '';
			const userId = Object.hasOwn(config.managerMap, senderNumber) ? config.managerMap[senderNumber] : undefined;
			const manager = userId ? managerByUser.get(userId) : undefined;
			if (!manager) {
				out.excluded.unmapped++;
				continue;
			}
			const parts = message.content.parts;
			if (!Array.isArray(parts) || parts.length !== 1 || parts[0]?.type !== 'text' || typeof parts[0].text !== 'string') {
				out.excluded.nonText++;
				continue;
			}
			const text = parts[0].text;
			if (!text.trim()) {
				out.excluded.nonText++;
				continue;
			}
			if (isPriorRecap(text)) {
				out.excluded.recap++;
				continue;
			}
			if (isReaction(text)) {
				out.excluded.reaction++;
				continue;
			}
			if (hasPrivateContact(text, config)) {
				out.excluded.privateContact++;
				continue;
			}
			if (characters + text.length > MAX_CHARACTERS) {
				textTruncated = true;
				continue;
			}
			characters += text.length;
			sources.set(message.id, {
				id: message.id,
				rosterId: manager.rosterId,
				sender: manager.displayName,
				createdAtUtc: new Date(timestamp).toISOString(),
				text,
				trust: 'untrusted-source-data',
				quoteReview: 'required',
			});
		} catch {
			malformed = true;
		}
	}
	if (textTruncated)
		out.gaps.push('archive_text_limit');
	if (malformed)
		out.gaps.push('malformed_archive_message');
	out.sources = [...sources.values()].sort((a, b) =>
		a.createdAtUtc.localeCompare(b.createdAtUtc) || a.id.localeCompare(b.id));
	out.gaps = [...new Set(out.gaps)];
	out.status = hasMore || textTruncated ? 'truncated' : malformed ? 'partial' : out.sources.length > 0 ? 'complete' : 'empty';
	return out;
}
