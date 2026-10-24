import type { z } from 'zod';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GoogleCredential } from '../../../lib/google-oauth.js';
import type { SqlLike } from '../../../lib/operator-time-zone';

import {
	GOOGLE_AUTH_FAILURE,
	GOOGLE_REQUIRED_SCOPES,
	GOOGLE_TOKEN_URL,
	saveCredential,
} from '../../../lib/google-oauth.js';

// The tool reads GOOGLE_CLIENT_ID/SECRET via requireEnv at module load, so set
// them before importing it (module-load parity with the boot-time check).
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.OPERATOR_TIMEZONE = 'America/Chicago';

const { gmailSearchTool, searchGmail } = await import('../gmail-search.js');

/** Credentials resolve from cwd, and the tool reads env at load: each test runs in a temp dir. */
let tempDir: string;
let originalCwd: string;
let originalFetch: typeof globalThis.fetch;
const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

const FRESH_CRED: GoogleCredential = {
	access: 'stored-access-token',
	refresh: 'stored-refresh-token',
	expiresAt: Date.now() + 30 * 60 * 1000,
	scope: GOOGLE_REQUIRED_SCOPES.join(' '),
};

function b64(text: string): string {
	return Buffer.from(text, 'utf8').toString('base64url');
}

interface FixturePart {
	mimeType: string;
	body?: { data: string };
	parts?: FixturePart[];
}

function makeGet(id: string, options: {
	subject?: string;
	from?: string;
	dateMs?: number;
	snippet?: string;
	text?: string;
	structure?: FixturePart;
}): Record<string, unknown> {
	const payload: FixturePart = options.structure ?? {
		mimeType: 'text/plain',
		...(options.text !== undefined ? { body: { data: b64(options.text) } } : {}),
	};
	return {
		id,
		threadId: `thread-${id}`,
		internalDate: String(options.dateMs ?? 1_757_010_000_000),
		snippet: options.snippet ?? 'snippet text',
		payload: {
			...payload,
			headers: [
				{ name: 'Subject', value: options.subject ?? 'Test subject' },
				{ name: 'From', value: options.from ?? 'Sender <sender@example.com>' },
				{ name: 'Date', value: 'Fri, 4 Sep 2026 10:00:00 +0000' },
			],
		},
	};
}

/**
 * Mock globalThis.fetch, routing by URL: token endpoint, messages.list, and
 * per-id messages.get. Gmail responses can be overridden per-call by the test.
 */
function mockFetch(options: {
	list?: () => Response;
	get?: (id: string) => Response;
	token?: () => Response;
	messageIds?: string[];
	lists?: Array<() => Response>;
}) {
	fetchCalls.length = 0;
	let listCalls = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		fetchCalls.push({ url: String(input), init });
		const url = String(input);
		if (url.startsWith(GOOGLE_TOKEN_URL))
			return options.token?.() ?? json({ access_token: 'fresh-access-token', expires_in: 3599, scope: GOOGLE_REQUIRED_SCOPES.join(' ') });
		if (url.includes('/messages?')) {
			if (options.lists)
				return options.lists[Math.min(listCalls++, options.lists.length - 1)]!();
			return options.list?.()
				?? json({ messages: (options.messageIds ?? []).map(id => ({ id, threadId: `thread-${id}` })), resultSizeEstimate: options.messageIds?.length ?? 0 });
		}
		const getMatch = /\/messages\/([^/?]+)/.exec(url);
		if (getMatch) {
			const id = getMatch[1]!;
			return options.get?.(id) ?? json(makeGet(id, { text: 'default body text' }));
		}
		throw new Error(`unexpected fetch to ${url}`);
	}) as unknown as typeof globalThis.fetch;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function operatorSql(override: string): SqlLike {
	return async strings => strings.join('?').includes('SELECT override_time_zone')
		? [{ override_time_zone: override }]
		: [];
}

async function captureError(action: () => Promise<unknown>): Promise<Error> {
	try {
		await action();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected the action to throw, but it resolved');
}

beforeEach(async () => {
	// macOS tmpdir is a symlink; chdir makes process.cwd() report the realpath.
	tempDir = realpathSync(await mkdtemp(join(tmpdir(), 'gmail-search-')));
	originalCwd = process.cwd();
	process.chdir(tempDir);
	originalFetch = globalThis.fetch;
	mockFetch({});
	await saveCredential(FRESH_CRED);
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	process.chdir(originalCwd);
	await rm(tempDir, { recursive: true, force: true });
});

describe('searchGmail', () => {
	test('happy path: lists, fetches, decodes, and shapes each message', async () => {
		mockFetch({ messageIds: ['abc123', 'def456'] });
		const result = await searchGmail({ query: 'is:unread' });
		expect(result.estimatedTotal).toBe(2);
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]).toMatchObject({
			subject: 'Test subject',
			from: 'Sender <sender@example.com>',
			snippet: 'snippet text',
			body: 'default body text',
		});
		expect(result.messages[0]!.date).toBe(new Date(1_757_010_000_000).toISOString());
		// The stored credential was fresh: exactly one list + two gets, no token call.
		expect(fetchCalls.filter(c => c.url.startsWith(GOOGLE_TOKEN_URL))).toHaveLength(0);
		expect(fetchCalls[0]!.url).toContain('q=is%3Aunread');
		expect(fetchCalls[0]!.url).toContain('maxResults=5');
		expect(fetchCalls[0]!.init?.headers).toEqual({ Authorization: 'Bearer stored-access-token' });
	});

	test('maxResults is honored and caps how many messages are fetched', async () => {
		mockFetch({ messageIds: ['a', 'b', 'c', 'd'] });
		const result = await searchGmail({ query: 'in:inbox', maxResults: 2 });
		expect(result.messages).toHaveLength(2);
		expect(fetchCalls[0]!.url).toContain('maxResults=2');
		expect(fetchCalls.filter(c => c.url.includes('/messages/') && !c.url.includes('/messages?'))).toHaveLength(2);
	});

	test('multipart: prefers the first text/plain part over html', async () => {
		mockFetch({
			messageIds: ['multi'],
			get: id => json(makeGet(id, {
				structure: {
					mimeType: 'multipart/mixed',
					parts: [
						{ mimeType: 'multipart/alternative', parts: [
							{ mimeType: 'text/plain', body: { data: b64('plain wins') } },
							{ mimeType: 'text/html', body: { data: b64('<p>html loses</p>') } },
						] },
						{ mimeType: 'application/pdf', body: { data: b64('pdf bytes') } },
					],
				},
			})),
		});
		const result = await searchGmail({ query: 'x' });
		expect(result.messages[0]!.body).toBe('plain wins');
	});

	test('html-only mail falls back to snippet without a body field', async () => {
		mockFetch({
			messageIds: ['htmlonly'],
			get: id => json(makeGet(id, {
				structure: { mimeType: 'text/html', body: { data: b64('<p>no plain part</p>') } },
			})),
		});
		const result = await searchGmail({ query: 'x' });
		expect(result.messages[0]!.body).toBeUndefined();
		expect(result.messages[0]!.snippet).toBe('snippet text');
	});

	test('bodies are truncated at 4000 characters with a marker', async () => {
		const longBody = 'a'.repeat(4100);
		mockFetch({ messageIds: ['long'], get: id => json(makeGet(id, { text: longBody })) });
		const result = await searchGmail({ query: 'x' });
		expect(result.messages[0]!.body).toBe(`${'a'.repeat(4000)}\n... (truncated)`);
	});

	test('an empty list returns no messages and no get calls', async () => {
		mockFetch({ list: () => json({ resultSizeEstimate: 0 }) });
		const result = await searchGmail({ query: 'is:unread' });
		expect(result).toEqual({ estimatedTotal: 0, messages: [] });
		expect(fetchCalls).toHaveLength(1);
	});

	test('relativeDay filters numeric internalDate against the effective operator day', async () => {
		const start = Date.parse('2026-09-04T15:00:00.000Z');
		const end = Date.parse('2026-09-05T15:00:00.000Z');
		mockFetch({
			lists: [
				() => json({ messages: ['before', 'end'].map(id => ({ id, threadId: `thread-${id}` })), resultSizeEstimate: 4, nextPageToken: 'page-2' }),
				() => json({ messages: ['start', 'inside'].map(id => ({ id, threadId: `thread-${id}` })), resultSizeEstimate: 4 }),
			],
			get: id => json(makeGet(id, {
				dateMs: {
					before: start - 1,
					start,
					inside: end - 1,
					end,
				}[id],
			})),
		});

		const result = await searchGmail(
			{ query: 'in:anywhere', relativeDay: 'today', nowMs: Date.parse('2026-09-05T02:00:00.000Z') },
			undefined,
			operatorSql('Asia/Tokyo'),
		);

		expect(result.messages.map(message => message.date)).toEqual([
			new Date(start).toISOString(),
			new Date(end - 1).toISOString(),
		]);
		const listUrls = fetchCalls.filter(call => call.url.includes('/messages?')).map(call => new URL(call.url));
		expect(listUrls).toHaveLength(2);
		expect(listUrls[0]!.searchParams.get('q')).toBe('in:anywhere after:2026/09/02 before:2026/09/07');
		expect(listUrls[1]!.searchParams.get('pageToken')).toBe('page-2');
	});

	test('a rejected query surfaces static text; Gmail\'s detail stays in server logs', async () => {
		mockFetch({ list: () => json({ error: { message: 'Invalid search criterion -: foo' } }, 400) });
		const error = await captureError(() => searchGmail({ query: '-: foo' }));
		expect(error.message).toBe('Gmail rejected the query. Check the search syntax.');
		expect(error.message).not.toContain('Invalid search criterion');
	});

	test('a whitespace-only query is rejected before any network call', async () => {
		await expect(searchGmail({ query: '  ' })).rejects.toThrow('Gmail rejected the query: empty query.');
		expect(fetchCalls).toHaveLength(0);
	});

	test('rate limit and server errors carry weather-style plain messages', async () => {
		mockFetch({ list: () => json({}, 429) });
		expect((await captureError(() => searchGmail({ query: 'x' }))).message).toBe('Gmail is rate-limited. Try again later.');
		mockFetch({ list: () => json({}, 500) });
		expect((await captureError(() => searchGmail({ query: 'x' }))).message).toBe('Gmail request failed.');
	});

	test('a malformed get response fails as unusable data', async () => {
		mockFetch({ messageIds: ['broken'], get: () => json({ threadId: 'x' }) });
		expect((await captureError(() => searchGmail({ query: 'x' }))).message).toBe('Gmail returned unusable data.');
	});

	test('a changed body shape in the list response fails as unusable data', async () => {
		mockFetch({ list: () => json({ messages: {} }) });
		expect((await captureError(() => searchGmail({ query: 'x' }))).message).toBe('Gmail returned unusable data.');
	});
});

describe('auth plumbing', () => {
	test('401 triggers exactly one forced refresh and a successful retry', async () => {
		let refreshedList = false;
		mockFetch({
			messageIds: ['abc123'],
			list: () => {
				// First call still carries the stale stored token.
				if (!refreshedList) {
					refreshedList = true;
					return json({ error: { code: 401 } }, 401);
				}
				return json({
					messages: [{ id: 'abc123', threadId: 'thread-abc123' }],
					resultSizeEstimate: 1,
				});
			},
		});
		const result = await searchGmail({ query: 'is:unread' });
		expect(result.messages).toHaveLength(1);
		const tokenCall = fetchCalls.find(c => c.url.startsWith(GOOGLE_TOKEN_URL));
		expect(tokenCall).toBeDefined();
		expect(new URLSearchParams(tokenCall!.init!.body as string).get('refresh_token')).toBe('stored-refresh-token');
		// Exactly one forced refresh; the retry uses the fresh access token.
		expect(fetchCalls.filter(c => c.url.startsWith(GOOGLE_TOKEN_URL))).toHaveLength(1);
		const retriedList = fetchCalls.find(c => c.url.includes('/messages?') && c !== fetchCalls[0]);
		expect(retriedList?.init?.headers).toEqual({ Authorization: 'Bearer fresh-access-token' });
	});

	test('401 after the forced refresh is the generic channel auth failure', async () => {
		mockFetch({ list: () => json({ error: { code: 401 } }, 401) });
		const error = await captureError(() => searchGmail({ query: 'is:unread' }));
		expect(error.message).toBe(GOOGLE_AUTH_FAILURE);
		expect(error.message).not.toContain('refresh');
	});

	test('a dead refresh token inside the 401 path surfaces the same generic failure', async () => {
		mockFetch({
			list: () => json({ error: { code: 401 } }, 401),
			token: () => json({ error: 'invalid_grant', error_description: 'Token has been revoked.' }, 400),
		});
		const error = await captureError(() => searchGmail({ query: 'is:unread' }));
		expect(error.message).toBe(GOOGLE_AUTH_FAILURE);
	});

	test('a missing credential fails before any Gmail call', async () => {
		await rm(join(tempDir, 'data', 'google-oauth.json'));
		const error = await captureError(() => searchGmail({ query: 'is:unread' }));
		expect(error.message).toBe(GOOGLE_AUTH_FAILURE);
		expect(fetchCalls).toHaveLength(0);
	});
});

describe('tool wiring', () => {
	test('createTool wiring reaches searchGmail, and the input schema rejects empty queries', async () => {
		mockFetch({ messageIds: ['abc123'] });
		// zod parse failures resolve at execute() in createTool, so assert the schema directly.
		const execute = gmailSearchTool.execute as (input: { query: string }) => Promise<import('../gmail-search.js').GmailSearchResult>;
		const result = await execute({ query: 'is:unread' });
		expect(result.messages).toHaveLength(1);
		expect((gmailSearchTool.inputSchema as z.ZodTypeAny).safeParse({ query: '' }).success).toBe(false);
		expect((gmailSearchTool.inputSchema as z.ZodTypeAny).safeParse({ query: 'x', relativeDay: 'yesterday' }).success).toBe(true);
	});
});
