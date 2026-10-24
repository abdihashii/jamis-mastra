import type { MastraDBMessage } from '@mastra/core/memory';
import type { MemoryStorage } from '@mastra/core/storage';
import { describe, expect, it } from 'bun:test';
import { Buffer } from 'node:buffer';
import { isPriorRecap, readArchivedChat } from './chat-archive';
import { buildEditorialCandidate } from './editorial';
import { frozenEditorialFixture, validEditorialDraft } from './editorial.fixture';
import { toChatContext } from './generate';

const config = {
	sleeperLeagueId: '111',
	sendblueGroupId: 'g1',
	recapTimezone: 'America/Chicago',
	managerMap: { '+15550001111': 'u1', '+15550002222': 'u2' },
};
const managers = [
	{ rosterId: 1, userId: 'u1', displayName: 'alpha' },
	{ rosterId: 2, userId: 'u2', displayName: 'bravo' },
];
const window = { startAtUtc: '2026-10-06T12:00:00.000Z', endAtUtc: '2026-10-13T12:00:00.000Z' };
const now = new Date('2026-10-17T12:00:00Z');

function message(id = 'm1', text = '  Win now.\n\nLose later. 🏈 e\u0301 **exact**  '): MastraDBMessage {
	return {
		id,
		threadId: 'fantasy-group-g1',
		resourceId: 'fantasy-group-g1',
		role: 'user',
		createdAt: new Date('2026-10-09T01:00:00Z'),
		content: {
			format: 2,
			parts: [{ type: 'text', text }],
			metadata: { channel: 'sendblue', groupId: 'g1', senderNumber: '+15550001111', sentAt: '2026-10-08T20:00:00-05:00' },
		},
	};
}

function store(messages: MastraDBMessage[] = [], hasMore = false) {
	const calls: unknown[] = [];
	const memory: Pick<MemoryStorage, 'getThreadById' | 'listMessages'> = {
		getThreadById: async (args) => {
			calls.push(args);
			return { id: 'fantasy-group-g1', resourceId: 'fantasy-group-g1', createdAt: now, updatedAt: now };
		},
		listMessages: async (args) => {
			calls.push(args);
			return { messages, hasMore, total: messages.length, page: 0, perPage: 1_000 };
		},
	};
	return { memory, calls };
}

describe('isPriorRecap', () => {
	it('recognizes canonical headers with a blank line and a nonblank report body', () => {
		for (let week = 1; week <= 22; week++) {
			for (const suffix of ['', ' (1/2)', ' (2/2)', ' (1/3)', ' (2/3)', ' (3/3)'])
				expect(isPriorRecap(`Week ${week} Recap${suffix}\n\nAn arbitrary story headline\n\nReport body.`)).toBe(true);
		}
		expect(isPriorRecap('Forwarded report:\nWeek 22 Recap (3/3)\n\nA final story.')).toBe(true);
	});

	it.each([
		'I enjoyed the week 1 recap yesterday.',
		'Please post Week 1 Recap when ready.',
		'Week 1 Recap',
		'Week 1 Recap\n\n',
		'Week 1 Recap\n\n \t\n',
		'Week 1 Recap\nNo blank line.',
		'Week 1 Recap tonight\n\nLet us discuss.',
		'week 1 recap\n\nCasual lowercase chatter.',
		'Week 0 Recap\n\nNot a week.',
		'Week 23 Recap\n\nNot a week.',
		'Week 01 Recap\n\nNot a canonical week.',
		'Week 1 Recap (1/1)\n\nNot a rendered suffix.',
		'Week 1 Recap (0/2)\n\nNot a part.',
		'Week 1 Recap (3/2)\n\nNot a part.',
		'Week 1 Recap (4/4)\n\nNot a part.',
		'Week 1 Recap (2/3) extra\n\nNot an exact header.',
	])('keeps ordinary or noncanonical chat: %s', (text) => {
		expect(isPriorRecap(text)).toBe(false);
	});

	it('preserves legacy award-heading detection', () => {
		expect(isPriorRecap('🏆 Manager of the Week: alpha\n\nLoser of the Week: bravo\nMatch of the Week: ours')).toBe(true);
		expect(isPriorRecap('Manager of the Week: what do we think?')).toBe(false);
	});
});

describe('readArchivedChat', () => {
	it.each([1, 2, 3])('excludes every part of a real %i-part rendering without changing archive bytes', async (partCount) => {
		const packet = await frozenEditorialFixture();
		const draft = validEditorialDraft(packet);
		if (partCount > 1) {
			draft.stories = ['A surprising turn', 'The bench bites back', 'A final word'].slice(0, partCount).map((headline, index) => ({ headline, body: String.fromCharCode(65 + index).repeat(10_000), supportIds: ['score:1:1'] }));
		}
		const rendered = buildEditorialCandidate(packet, draft);
		expect(rendered.status).toBe('candidate');
		if (rendered.status !== 'candidate')
			throw new Error('Fixture rendering failed');
		const parts = rendered.candidate.parts;
		expect(parts).toHaveLength(partCount);
		for (let index = 1; index < parts.length; index++) {
			expect(parts[index].startsWith(`Week 1 Recap (${index + 1}/${partCount})\n\n${draft.stories[index].headline}\n\n`)).toBe(true);
			expect(parts[index]).not.toContain('Manager of the Week');
		}
		const ordinary = message('ordinary', '  I enjoyed the week 1 recap. 🏈 e\u0301\n\nWho is next?  ');
		const messages = [...parts.map((part, index) => message(`repost-${index}`, part)), ordinary];
		const before = structuredClone(messages);
		const bytes = messages.map(row => Buffer.from((row.content.parts[0] as { text: string }).text));
		const { memory } = store(messages);
		const result = await readArchivedChat(memory, config, managers, window, now);
		expect(result.status).toBe('complete');
		expect(result.readCount).toBe(partCount + 1);
		expect(result.excluded.recap).toBe(partCount);
		expect(result.sources.map(source => source.id)).toEqual(['ordinary']);
		expect(Buffer.from(result.sources[0].text)).toEqual(bytes[partCount]);
		expect(toChatContext(messages, config, managers).map(source => source.id)).toEqual(['ordinary']);
		expect(messages).toEqual(before);
		expect(messages.map(row => Buffer.from((row.content.parts[0] as { text: string }).text))).toEqual(bytes);
	});

	it('retains exact original bytes, mapped attribution and UTC provenance without mutation', async () => {
		const source = message();
		const before = structuredClone(source);
		const { memory, calls } = store([source]);
		const result = await readArchivedChat(memory, config, managers, window, now);
		expect(result.status).toBe('complete');
		expect(result.sources).toEqual([{
			id: 'm1',
			rosterId: 1,
			sender: 'alpha',
			createdAtUtc: '2026-10-09T01:00:00.000Z',
			text: before.content.parts[0].type === 'text' ? before.content.parts[0].text : '',
			trust: 'untrusted-source-data',
			quoteReview: 'required',
		}]);
		expect(Buffer.from(result.sources[0].text))
			.toEqual(Buffer.from((before.content.parts[0] as { text: string }).text));
		expect(source).toEqual(before);
		expect(result).toMatchObject({ windowBasis: 'caller-supplied', coverage: 'archived-window-only' });
		expect(calls[1]).toMatchObject({
			threadId: 'fantasy-group-g1',
			page: 0,
			perPage: 1_000,
			includeTotal: false,
			filter: { dateRange: {
				start: new Date(window.startAtUtc),
				end: new Date(window.endAtUtc),
				endExclusive: true,
			} },
		});
		expect(JSON.stringify(result)).not.toContain('+15550001111');
	});

	it('distinguishes successful empty eligibility from an unavailable archive', async () => {
		const { memory } = store();
		expect((await readArchivedChat(memory, config, managers, window, now)).status).toBe('empty');
		memory.listMessages = async () => {
			throw new Error('PRIVATE_ERROR_SENTINEL');
		};
		const failed = await readArchivedChat(memory, config, managers, window, now);
		expect(failed).toMatchObject({ status: 'unavailable', gaps: ['archive_unavailable'], sources: [] });
		expect(JSON.stringify(failed)).not.toContain('PRIVATE_ERROR_SENTINEL');
		expect((await readArchivedChat(null, config, managers, window, now)).status).toBe('unavailable');
		memory.getThreadById = async () => null;
		expect((await readArchivedChat(memory, config, managers, window, now)).gaps).toContain('archive_thread_unavailable');
	});

	it('never treats a truncated zero-row response as an empty week', async () => {
		const { memory } = store([], true);
		expect(await readArchivedChat(memory, config, managers, window, now)).toMatchObject({
			status: 'truncated',
			sources: [],
			gaps: ['archive_message_limit'],
		});
	});

	it('marks the text bound explicitly without cutting a purported exact quote', async () => {
		const first = message('m1', 'a'.repeat(60_000));
		const second = message('m2', 'b'.repeat(60_000));
		const { memory } = store([first, second]);
		const result = await readArchivedChat(memory, config, managers, window, now);
		expect(result.status).toBe('truncated');
		expect(result.gaps).toContain('archive_text_limit');
		expect(result.sources.map(source => source.id)).toEqual(['m1']);
		expect(result.sources[0].text).toHaveLength(60_000);
	});

	it('excludes unmapped senders, contact information, reposts and recognizable reactions', async () => {
		const unknown = message('unknown');
		unknown.content.metadata!.senderNumber = '+15550009999';
		const { memory } = store([
			unknown,
			message('phone', 'Call me at +15550002222'),
			message('email', 'PRIVATE_EMAIL@example.invalid'),
			message('recap', 'Manager of the Week: alpha\nLoser of the Week: bravo\nMatch of the Week: ours'),
			message('tapback', 'Loved “Well played”'),
			message('ordinary', 'Manager of the Week: what do we think?'),
		]);
		const result = await readArchivedChat(memory, config, managers, window, now);
		expect(result.sources.map(source => source.id)).toEqual(['ordinary']);
		expect(result.excluded).toMatchObject({ unmapped: 1, privateContact: 2, recap: 1, reaction: 1 });
		expect(JSON.stringify(result)).not.toContain('PRIVATE_EMAIL');
	});

	it('does not mistake structural source admission for semantic privacy approval', async () => {
		const { memory } = store([message('private-life', 'Personal circumstances need editorial privacy review.')]);
		const result = await readArchivedChat(memory, config, managers, window, now);
		expect(result.sources[0].quoteReview).toBe('required');
		expect(result.sources[0]).not.toHaveProperty('approved');
	});

	it.each(['foreign-thread', 'foreign-resource', 'foreign-group', 'operator-role', 'wrong-time', 'missing-time', 'outside-window'])(
		'fails closed on %s evidence without exporting its text',
		async (fault) => {
			const source = message('unsafe', 'PRIVATE_OTHER_CONTEXT');
			if (fault === 'foreign-thread')
				source.threadId = 'operator-dm';
			if (fault === 'foreign-resource')
				source.resourceId = 'operator-dm';
			if (fault === 'foreign-group')
				source.content.metadata!.groupId = 'another-group';
			if (fault === 'operator-role')
				source.role = 'assistant';
			if (fault === 'wrong-time')
				source.content.metadata!.sentAt = '2026-10-09T02:00:00Z';
			if (fault === 'missing-time')
				delete source.content.metadata!.sentAt;
			if (fault === 'outside-window') {
				source.createdAt = new Date(window.endAtUtc);
				source.content.metadata!.sentAt = window.endAtUtc;
			}
			const { memory } = store([source]);
			const result = await readArchivedChat(memory, config, managers, window, now);
			expect(result.status).toBe('partial');
			expect(result.sources).toEqual([]);
			expect(JSON.stringify(result)).not.toContain('PRIVATE_OTHER_CONTEXT');
		},
	);

	it('withdraws ambiguous duplicate identities rather than selecting the first text', async () => {
		const { memory } = store([message('duplicate', 'first'), message('duplicate', 'different')]);
		const result = await readArchivedChat(memory, config, managers, window, now);
		expect(result.status).toBe('partial');
		expect(result.sources).toEqual([]);
		expect(result.gaps).toContain('duplicate_message_identity');
	});

	it('does not stitch multiple parts into a quote or fetch attachments', async () => {
		const source = message();
		source.content.parts.push({ type: 'text', text: 'second part' });
		const { memory, calls } = store([source]);
		const result = await readArchivedChat(memory, config, managers, window, now);
		expect(result.sources).toEqual([]);
		expect(result.excluded.nonText).toBe(1);
		expect(calls).toHaveLength(2);
	});

	it('rejects invalid or not-yet-closed windows before accessing storage', async () => {
		const { memory, calls } = store([message()]);
		for (const bad of [
			{ ...window, startAtUtc: '2026-10-06' },
			{ ...window, endAtUtc: window.startAtUtc },
			{ ...window, endAtUtc: '2026-10-18T12:00:00Z' },
		]) {
			expect((await readArchivedChat(memory, config, managers, bad, now)).status).toBe('unavailable');
		}
		expect(calls).toEqual([]);
	});
});
