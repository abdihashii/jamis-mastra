import type { z } from 'zod';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SqlLike } from '../../../lib/operator-time-zone';

import { GOOGLE_AUTH_FAILURE, GOOGLE_REQUIRED_SCOPES } from '../../../lib/google-oauth.js';

/**
 * The tool resolves the credential from cwd-each-time. Every test runs inside
 * a temp dir that carries a credential with a small pool of calendars.
 */
let tempDir: string;
let originalCwd: string;
let originalFetch: typeof globalThis.fetch;
const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

const POOL = [
	{ id: 'primary@example.com', summary: 'Abdirahman', timeZone: 'America/Chicago', primary: true },
	{ id: 'team@group.calendar.google.com', summary: 'Team', timeZone: 'America/Chicago' },
];

interface EventFixture {
	summary?: string;
	start?: { dateTime?: string; date?: string; timeZone?: string };
	end?: { dateTime?: string; date?: string; timeZone?: string };
	location?: string;
	description?: string;
	status?: string;
}

function eventsJson(events: EventFixture[], status = 200, nextPageToken?: string): Response {
	return new Response(
		JSON.stringify({
			items: events,
			...(nextPageToken ? { nextPageToken } : {}),
		}),
		{ status, headers: { 'Content-Type': 'application/json' } },
	);
}

function tokenJson(body: Record<string, unknown>, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Mock fetch routing URLs by hostname and query. `options.token` overrides
 * the token-endpoint responder; `options.events` responses queue per calendar id.
 */
function mockFetch(options: {
	token?: () => Response;
	events?: (calId: string) => Response;
}) {
	fetchCalls.length = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		fetchCalls.push({ url: String(input), init });
		const url = String(input);
		if (url.startsWith('https://oauth2.googleapis.com/token')) {
			return options.token?.() ?? tokenJson({
				access_token: 'fresh-access-token',
				expires_in: 3599,
				scope: GOOGLE_REQUIRED_SCOPES.join(' '),
			});
		}
		const m = url.match(/calendars\/([^/]+)\/events/);
		if (m) {
			return options.events?.(decodeURIComponent(m[1])) ?? eventsJson([]);
		}
		throw new Error(`unexpected fetch to ${url}`);
	}) as unknown as typeof globalThis.fetch;
}

async function captureError(action: () => Promise<unknown>): Promise<Error> {
	try {
		await action();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected the action to throw, but it resolved');
}

async function writeCredential(overrides: Record<string, unknown> = {}) {
	await mkdir(join(tempDir, 'data'), { recursive: true });
	await writeFile(join(tempDir, 'data', 'google-oauth.json'), JSON.stringify({
		access: 'test-access-token',
		refresh: 'test-refresh-token',
		expiresAt: Date.now() + 30 * 60 * 1000,
		scope: GOOGLE_REQUIRED_SCOPES.join(' '),
		calendars: POOL,
		...overrides,
	}), { mode: 0o600 });
}

process.env.GOOGLE_CLIENT_ID ??= 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-client-secret';
process.env.OPERATOR_TIMEZONE = 'America/Chicago';
const { listCalendarEvents: listCalendarEventsWithZone, calendarEventsTool } = await import('../calendar-events.js');

function operatorSql(override?: string): SqlLike {
	return async strings => strings.join('?').includes('SELECT override_time_zone') && override
		? [{ override_time_zone: override }]
		: [];
}

function listCalendarEvents(
	input: Parameters<typeof listCalendarEventsWithZone>[0],
	sql: SqlLike = operatorSql(),
) {
	return listCalendarEventsWithZone(input, undefined, sql);
}

beforeEach(async () => {
	tempDir = realpathSync(await mkdtemp(join(tmpdir(), 'jam52-calendar-')));
	originalCwd = process.cwd();
	process.chdir(tempDir);
	originalFetch = globalThis.fetch;
	await writeCredential();
	mockFetch({});
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	process.chdir(originalCwd);
	await rm(tempDir, { recursive: true, force: true });
});

describe('listCalendarEvents window + query', () => {
	test('daysAhead default 1 maps to start-of-day in the primary zone', async () => {
		// Fixed non-DST instant so the gap assertion stays stable all year.
		await listCalendarEvents({ nowMs: Date.UTC(2026, 8, 5, 12) });
		const url = new URL(fetchCalls.at(-1)!.url);
		const timeMin = url.searchParams.get('timeMin')!;
		const timeMax = url.searchParams.get('timeMax')!;
		expect(timeMin).toMatch(/\d{4}-\d{2}-\d{2}T00:00:00-0[56]:00/);
		expect(timeMax).toMatch(/\d{4}-\d{2}-\d{2}T00:00:00-0[56]:00/);
		const gapMs = new Date(timeMax).getTime() - new Date(timeMin).getTime();
		expect(gapMs).toBe(24 * 60 * 60 * 1000);
		expect(url.searchParams.get('singleEvents')).toBe('true');
		expect(url.searchParams.get('orderBy')).toBe('startTime');
		expect(url.searchParams.get('maxResults')).toBe('20');
	});

	test('daysAhead: 7 spans seven whole days', async () => {
		await listCalendarEvents({ daysAhead: 7, nowMs: Date.UTC(2026, 0, 15, 6) });
		const url = new URL(fetchCalls.at(-1)!.url);
		const t0 = new Date(url.searchParams.get('timeMin')!).getTime();
		const t1 = new Date(url.searchParams.get('timeMax')!).getTime();
		expect(t1 - t0).toBe(7 * 24 * 60 * 60 * 1000);
	});

	test('q passes through; whitespace-only q is dropped from the request', async () => {
		await listCalendarEvents({ q: 'dentist' });
		expect(new URL(fetchCalls.at(-1)!.url).searchParams.get('q')).toBe('dentist');
		await listCalendarEvents({ q: '   ' });
		expect(new URL(fetchCalls.at(-1)!.url).searchParams.get('q')).toBeNull();
	});

	test('the operator zone wins over the primary calendar zone', async () => {
		await writeCredential({
			calendars: [
				{ id: 'first@example.com', summary: 'First only', timeZone: 'Europe/London' },
				{ id: 'primary@example.com', summary: 'Primary', timeZone: 'Asia/Tokyo', primary: true },
			],
		});
		await listCalendarEvents({});
		expect(new URL(fetchCalls.at(-1)!.url).searchParams.get('timeMin')).toMatch(/-0[56]:00$/);
	});

	test('a persisted operator override wins over the deployment default and pool zones', async () => {
		await writeCredential({
			calendars: [
				{ id: 'first@example.com', summary: 'London', timeZone: 'Europe/London' },
				{ id: 'other@example.com', summary: 'Other', timeZone: 'America/Chicago' },
			],
		});
		await listCalendarEvents({ nowMs: Date.parse('2026-09-05T02:00:00.000Z') }, operatorSql('Asia/Tokyo'));
		expect(new URL(fetchCalls.at(-1)!.url).searchParams.get('timeMin')).toBe('2026-09-05T00:00:00+09:00');
	});

	test('a bad calendar zone cannot change the operator window', async () => {
		await writeCredential({
			calendars: [{ id: 'z@example.com', summary: 'Bad zone', timeZone: 'not-a-zone', primary: true }],
		});
		await listCalendarEvents({ nowMs: Date.parse('2026-09-05T12:00:00.000Z') });
		expect(new URL(fetchCalls.at(-1)!.url).searchParams.get('timeMin')).toBe('2026-09-05T00:00:00-05:00');
	});
});

describe('listCalendarEvents merge semantics', () => {
	test('queries each pool calendar and merges chronologically across zones', async () => {
		mockFetch({
			events: (calId) => {
				if (calId === 'primary@example.com') {
					return eventsJson([
						{ summary: 'Wake up', start: { dateTime: '2026-09-05T07:00:00-05:00' }, end: { dateTime: '2026-09-05T07:30:00-05:00' } },
						{ summary: 'Dentist', start: { dateTime: '2026-09-05T11:00:00-05:00' }, end: { dateTime: '2026-09-05T12:00:00-05:00' } },
					]);
				}
				return eventsJson([
					{ summary: 'Team standup', start: { dateTime: '2026-09-05T09:00:00-05:00' }, end: { dateTime: '2026-09-05T09:30:00-05:00' } },
				]);
			},
		});
		const out = await listCalendarEvents({});
		expect(out.events).toHaveLength(3);
		expect(out.unavailableCalendars).toEqual([]);
		expect(out.events.map(e => e.title)).toEqual(['Wake up', 'Team standup', 'Dentist']);
		expect(fetchCalls).toHaveLength(2);
	});

	test('timed events sort by instant and expose UTC plus operator-local values', async () => {
		mockFetch({
			events: (calId) => {
				if (calId === 'primary@example.com') {
					return eventsJson([
						{ summary: 'Early-west', start: { dateTime: '2026-09-05T07:00:00-05:00' }, end: { dateTime: '2026-09-05T07:30:00-05:00' } }, // 12:00Z
					]);
				}
				return eventsJson([
					{ summary: 'Earlier-east', start: { dateTime: '2026-09-05T20:00:00', timeZone: 'Asia/Tokyo' }, end: { dateTime: '2026-09-05T21:00:00', timeZone: 'Asia/Tokyo' } }, // 11:00Z
				]);
			},
		});
		const out = await listCalendarEvents({});
		expect(out.events.map(e => e.title)).toEqual(['Earlier-east', 'Early-west']);
		expect(out.events[0]).toMatchObject({
			start: '2026-09-05T11:00:00.000Z',
			end: '2026-09-05T12:00:00.000Z',
			operatorLocalStart: '2026-09-05T06:00:00-05:00',
			operatorLocalEnd: '2026-09-05T07:00:00-05:00',
		});
	});
});

describe('listCalendarEvents per-event shaping', () => {
	test('optional fields (location, description) appear only when present', async () => {
		mockFetch({
			events: (calId) => {
				if (calId === 'primary@example.com') {
					return eventsJson([
						{ summary: 'No loc', start: { dateTime: '2026-09-05T09:00:00-05:00' }, end: { dateTime: '2026-09-05T09:30:00-05:00' } },
						{ summary: 'With loc', start: { dateTime: '2026-09-05T10:00:00-05:00' }, end: { dateTime: '2026-09-05T10:30:00-05:00' }, location: '42 Wallaby Way' },
						{ summary: 'With desc', start: { dateTime: '2026-09-05T11:00:00-05:00' }, end: { dateTime: '2026-09-05T11:30:00-05:00' }, description: 'Join at https://meet.example.com/x' },
					]);
				}
				return eventsJson([]);
			},
		});
		const out = await listCalendarEvents({});
		expect(out.events.map(e => e.title)).toEqual(['No loc', 'With loc', 'With desc']);
		expect(out.events[0].location).toBeUndefined();
		expect(out.events[1].location).toBe('42 Wallaby Way');
		expect(out.events[2].description).toContain('meet.example.com');
	});

	test('all-day events fall back to the bare date', async () => {
		mockFetch({
			events: (calId) => {
				if (calId === 'primary@example.com') {
					return eventsJson([
						{ summary: 'Labor Day', start: { date: '2026-09-07' }, end: { date: '2026-09-08' } },
					]);
				}
				return eventsJson([]);
			},
		});
		const out = await listCalendarEvents({});
		expect(out.events[0].start).toBe('2026-09-07');
		expect(out.events[0].end).toBe('2026-09-08');
		expect(out.events[0].operatorLocalStart).toBeUndefined();
		expect(out.events[0].operatorLocalEnd).toBeUndefined();
	});

	test('descriptions are capped at 1000 chars', async () => {
		mockFetch({
			events: (calId) => {
				if (calId === 'primary@example.com') {
					return eventsJson([
						{ summary: 'big', start: { dateTime: '2026-09-05T09:00:00-05:00' }, end: { dateTime: '2026-09-05T09:30:00-05:00' }, description: 'x'.repeat(1500) },
					]);
				}
				return eventsJson([]);
			},
		});
		const out = await listCalendarEvents({});
		expect(out.events[0].description).toHaveLength(1000);
	});

	test('private-visibility events (no summary) still surface attributed to their calendar', async () => {
		mockFetch({
			events: (calId) => {
				if (calId === 'primary@example.com') {
					return eventsJson([
						{ summary: 'Public', start: { dateTime: '2026-09-05T09:00:00-05:00' }, end: { dateTime: '2026-09-05T09:30:00-05:00' } },
					]);
				}
				// Work calendar: summary absent (private visibility), must not be dropped.
				return eventsJson([
					{ start: { dateTime: '2026-09-05T10:30:00-05:00' }, end: { dateTime: '2026-09-05T11:00:00-05:00' } },
				]);
			},
		});
		const out = await listCalendarEvents({});
		expect(out.events).toHaveLength(2);
		expect(out.events.map(e => e.title)).toEqual(['Public', '(Private event)']);
		expect(out.events[1].calendar).toBe('Team');
	});

	test('cancelled events are dropped', async () => {
		mockFetch({
			events: (calId) => {
				if (calId === 'primary@example.com') {
					return eventsJson([
						{ summary: 'Kept', start: { dateTime: '2026-09-05T09:00:00-05:00' }, end: { dateTime: '2026-09-05T10:00:00-05:00' } },
						{ summary: 'Ghost', status: 'cancelled', start: { dateTime: '2026-09-05T10:00:00-05:00' }, end: { dateTime: '2026-09-05T11:00:00-05:00' } },
					]);
				}
				return eventsJson([]);
			},
		});
		const out = await listCalendarEvents({});
		const titles = out.events.map(e => e.title);
		expect(titles).not.toContain('Ghost');
		expect(titles).toContain('Kept');
	});
});

describe('listCalendarEvents truncation and service errors', () => {
	test('truncated flag set when the window overflows MAX_EVENTS', async () => {
		const many: EventFixture[] = Array.from({ length: 21 }, (_, i) => ({
			summary: `ev${i}`,
			start: { dateTime: `2026-09-05T${String(i).padStart(2, '0')}:00:00-05:00` },
			end: { dateTime: `2026-09-05T${String(i).padStart(2, '0')}:30:00-05:00` },
		}));
		mockFetch({
			events: calId => calId === 'primary@example.com' ? eventsJson(many) : eventsJson([]),
		});
		const out = await listCalendarEvents({});
		expect(out.truncated).toBe(true);
		expect(out.events).toHaveLength(20);
	});

	test('truncated flag set when a calendar returned a nextPageToken', async () => {
		mockFetch({
			events: (calId) => {
				if (calId === 'primary@example.com') {
					return eventsJson(
						[{ summary: 'x', start: { dateTime: '2026-09-05T08:00:00-05:00' }, end: { dateTime: '2026-09-05T08:15:00-05:00' } }],
						200,
						'page-2',
					);
				}
				return eventsJson([]);
			},
		});
		const out = await listCalendarEvents({});
		expect(out.truncated).toBe(true);
	});

	test.each([403, 404])('an inaccessible %s calendar preserves other events and reports missing coverage', async (status) => {
		mockFetch({
			events: (calId) => {
				if (calId === 'primary@example.com') {
					return eventsJson([
						{ summary: 'Primary still works', start: { dateTime: '2026-09-05T09:00:00-05:00' }, end: { dateTime: '2026-09-05T10:00:00-05:00' } },
					]);
				}
				return eventsJson([], status);
			},
		});
		const out = await listCalendarEvents({});
		expect(out.events.map(e => e.title)).toEqual(['Primary still works']);
		expect(out.unavailableCalendars).toEqual([{ calendar: 'Team', status }]);
		expect(out.truncated).toBe(false);
	});

	test('an entirely inaccessible calendar pool cannot look like an empty readable window', async () => {
		mockFetch({ events: () => eventsJson([], 403) });
		const out = await listCalendarEvents({});
		expect(out.events).toEqual([]);
		expect(out.unavailableCalendars).toHaveLength(2);
		expect(out.unavailableCalendars.every(calendar => calendar.status === 403)).toBe(true);
	});

	test('a real service error (5xx) fails the call', async () => {
		mockFetch({
			events: () => eventsJson([], 500),
		});
		const error = await captureError(() => listCalendarEvents({}));
		expect(error.message).toBe('Calendar is having trouble. Try again later.');
	});

	test('429 relays as a rate-limit', async () => {
		mockFetch({
			events: () => eventsJson([], 429),
		});
		const error = await captureError(() => listCalendarEvents({}));
		expect(error.message).toBe('Calendar is rate-limited. Try again later.');
	});

	test('expiring access token refreshes silently once through the tool', async () => {
		await writeCredential({ expiresAt: Date.now() - 1000 });
		mockFetch({
			events: () => eventsJson([
				{ summary: 'Got through', start: { dateTime: '2026-09-05T09:00:00-05:00' }, end: { dateTime: '2026-09-05T10:00:00-05:00' } },
			]),
		});
		const out = await listCalendarEvents({});
		expect(out.events[0].title).toBe('Got through');
		const tokenCalls = fetchCalls.filter(c => c.url.startsWith('https://oauth2.googleapis.com/token'));
		expect(tokenCalls).toHaveLength(1);
	});
});

describe('listCalendarEvents credential failures', () => {
	test('empty pool is an auth-shaped failure (re-login is the recovery)', async () => {
		await writeCredential({ calendars: [] });
		const error = await captureError(() => listCalendarEvents({}));
		expect(error.message).toBe(GOOGLE_AUTH_FAILURE);
	});

	test('missing pool is an auth-shaped failure', async () => {
		await writeCredential({ calendars: undefined });
		const error = await captureError(() => listCalendarEvents({}));
		expect(error.message).toBe(GOOGLE_AUTH_FAILURE);
	});

	test('malformed list response is flagged as unusable', async () => {
		mockFetch({
			events: (calId) => {
				if (calId === 'primary@example.com') {
					return new Response('nope', { status: 200, headers: { 'Content-Type': 'application/json' } });
				}
				return eventsJson([]);
			},
		});
		const error = await captureError(() => listCalendarEvents({}));
		expect(error.message).toBe('Calendar returned unusable data.');
	});
});

describe('calendarEventsTool wiring', () => {
	test('input schema accepts defaults and rejects out-of-range daysAhead', () => {
		const schema = calendarEventsTool.inputSchema as z.ZodTypeAny;
		expect(schema.safeParse({}).success).toBe(true);
		expect(schema.safeParse({ daysAhead: 0 }).success).toBe(false);
		expect(schema.safeParse({ daysAhead: 91 }).success).toBe(false);
		expect(schema.safeParse({ daysAhead: 3, q: 'dentist' }).success).toBe(true);
	});

	test('execute wires into listCalendarEvents', async () => {
		mockFetch({
			events: calId => calId === 'primary@example.com'
				? eventsJson([
						{ summary: 'Through execute', start: { dateTime: '2026-09-05T09:00:00-05:00' }, end: { dateTime: '2026-09-05T10:00:00-05:00' } },
					])
				: eventsJson([]),
		});
		const raw = calendarEventsTool.execute;
		expect(raw).toBeDefined();
		const result = await (raw as unknown as (input: { daysAhead?: number; q?: string }, ctx: { abortSignal?: AbortSignal }) => Promise<unknown>)({}, {});
		expect((result as { events: Array<{ title: string }> }).events[0].title).toBe('Through execute');
	});
});
