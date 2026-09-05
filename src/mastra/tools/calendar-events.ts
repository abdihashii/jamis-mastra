import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { fetchJson } from '../../lib/fetch.js';
import {
	getUsableCredential,
	GOOGLE_AUTH_FAILURE,
	refreshCredential,
} from '../../lib/google-oauth.js';
import { zonedDayWindow } from '../../lib/time.js';
import { requireEnv } from '../env';

// Missing client config is a hard failure at boot, same as the other API keys.
const calendarAuth = {
	clientId: requireEnv('GOOGLE_CLIENT_ID'),
	clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
};

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const MAX_EVENTS = 20;
const DEFAULT_DAYS_AHEAD = 1;

interface CalendarEventResource {
	summary?: string;
	location?: string;
	description?: string;
	start?: { dateTime?: string; date?: string };
	end?: { dateTime?: string; date?: string };
	/** Cancelled events appear with this status under singleEvents; skip them. */
	status?: string;
}

interface CalendarEventsListResult {
	items?: CalendarEventResource[];
	nextPageToken?: string;
}

export interface CalendarEventSummary {
	title: string;
	/** Which picked calendar the event came from (its name from the pool). */
	calendar: string;
	/** ISO 8601 with zone offset (or a bare date for all-day events), straight from Google. */
	start: string;
	end: string;
	location?: string;
	description?: string;
}

export interface CalendarEventsResult {
	from: string;
	to: string;
	/** True when the window had more events than we returned; the caller should narrow daysAhead/q. */
	truncated: boolean;
	events: CalendarEventSummary[];
}

/** Optional `nowMs` pins the day window in tests; defaults to Date.now(). */
interface ListCalendarEventsInput { daysAhead?: number; q?: string; nowMs?: number }

function serviceError(action: string, status: number): Error {
	console.error(`[calendar-events] ${action} failed with status ${status}`);
	if (status === 429)
		return new Error('Calendar is rate-limited. Try again later.');
	if (status >= 500)
		return new Error('Calendar is having trouble. Try again later.');
	return new Error('Calendar request failed.');
}

function unusableData(action: string): Error {
	console.error(`[calendar-events] ${action} returned unusable data`);
	return new Error('Calendar returned unusable data.');
}

async function calendarGet(url: string, signal?: AbortSignal): Promise<{ ok: boolean; status: number; json: unknown }> {
	// Same contract as gmailGet: silent refresh on expiry inside
	// getUsableCredential; one forced refresh on a 401, then an auth failure.
	let cred = await getUsableCredential(calendarAuth);
	let res = await fetchJson(url, signal, { Authorization: `Bearer ${cred.access}` });
	if (res.status === 401) {
		console.error('[calendar-events] Calendar rejected the stored access token; forcing one refresh.');
		cred = await refreshCredential(cred, calendarAuth);
		res = await fetchJson(url, signal, { Authorization: `Bearer ${cred.access}` });
	}
	if (res.status === 401) {
		console.error('[calendar-events] Calendar still 401 after a forced refresh. Re-login required.');
		throw new Error(GOOGLE_AUTH_FAILURE);
	}
	return res;
}

/**
 * Merge events from the operator's login-picked calendar pool over the next
 * daysAhead days. Never logs titles, locations, or pool membership.
 */
export async function listCalendarEvents(
	input: ListCalendarEventsInput,
	signal?: AbortSignal,
): Promise<CalendarEventsResult> {
	const cred = await getUsableCredential(calendarAuth);
	const pool = cred.calendars ?? [];
	if (pool.length === 0) {
		console.error('[calendar-events] no calendar pool stored. Log in with `bun scripts/google-login.ts`.');
		throw new Error(GOOGLE_AUTH_FAILURE);
	}
	const daysAhead = input.daysAhead ?? DEFAULT_DAYS_AHEAD;
	// Day boundaries resolve in the primary calendar's zone (plan 012); the
	// model never does offset arithmetic. Pool without a primary mark exists
	// when the pool was saved as non-primary-only picks; fall back to the first.
	const zone = (pool.find(c => c.primary) ?? pool[0]).timeZone;
	let window: [string, string];
	try {
		window = zonedDayWindow(zone, daysAhead, input.nowMs);
	}
	catch {
		// A hand-edited pool can carry a bad IANA zone; re-login rebuilds it.
		console.error(`[calendar-events] zonedDayWindow rejected the pool's primary-zone value.`);
		throw new Error(GOOGLE_AUTH_FAILURE);
	}
	const [timeMin, timeMax] = window;

	const events: CalendarEventSummary[] = [];
	let sawTruncation = false;
	for (const cal of pool) {
		const params = new URLSearchParams({
			timeMin,
			timeMax,
			singleEvents: 'true',
			orderBy: 'startTime',
			maxResults: String(MAX_EVENTS),
		});
		if (input.q?.trim())
			params.set('q', input.q.trim());
		const res = await calendarGet(
			`${CALENDAR_API}/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
			signal,
		);
		if (!res.ok) {
			// A pool entry deleted or unshared after login must not fail every
			// calendar ask; skip it and log. Real service errors still throw.
			if (res.status === 403 || res.status === 404) {
				console.error(`[calendar-events] events.list ${res.status} for one pool calendar; skipping. Re-run login:google to refresh the pool.`);
				continue;
			}
			throw serviceError('events.list', res.status);
		}
		const list = res.json as CalendarEventsListResult | null;
		if (list === null || (list.items !== undefined && !Array.isArray(list.items))) {
			throw unusableData('events.list');
		}
		if (list.nextPageToken)
			sawTruncation = true;
		for (const ev of list.items ?? []) {
			if (ev.status === 'cancelled')
				continue;
			const start = ev.start?.dateTime ?? ev.start?.date;
			const end = ev.end?.dateTime ?? ev.end?.date;
			if (!start || !end)
				continue;
			events.push({
				title: ev.summary || '(Private event)',
				calendar: cal.summary,
				start,
				end,
				...(ev.location ? { location: ev.location } : {}),
				...(ev.description ? { description: ev.description.slice(0, 1000) } : {}),
			});
		}
	}

	// Chronological across mixed zones: parse, don't compare ISO strings.
	events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
	const truncated = sawTruncation || events.length > MAX_EVENTS;
	return { from: timeMin, to: timeMax, truncated, events: events.slice(0, MAX_EVENTS) };
}

export const calendarEventsTool = createTool({
	id: 'calendar-events',
	description:
		'List events from the operator\'s picked calendars (read-only), merged and chronological. '
		+ 'daysAhead is a whole-day window starting today (1 = today, 2 = today and tomorrow, 90 max). '
		+ 'q is optional free-text match across title, location, description, and attendee names ("dentist", "Sarah"). '
		+ 'Returns each event\'s calendar, title, start, end, optional location and description.',
	inputSchema: z.object({
		daysAhead: z.number().int().min(1).max(90).optional().describe('Whole days to look ahead from today (default 1 = today only). Tomorrow alone: 2, then read the second day.'),
		q: z.string().optional().describe('Optional free-text filter, e.g. "dentist" or "gym". Matches title, location, description, attendee names.'),
	}),
	outputSchema: z.object({
		from: z.string().describe('Window start, ISO 8601 with zone offset'),
		to: z.string().describe('Window end (exclusive), ISO 8601 with zone offset'),
		truncated: z.boolean().describe('True when more events matched than returned; narrow daysAhead or q'),
		events: z.array(z.object({
			title: z.string().describe('Event title; "(Private event)" when Google withholds the name on private-visibility events'),
			calendar: z.string().describe('Which of the operator\'s picked calendars this event belongs to'),
			start: z.string().describe('ISO 8601 with zone offset, or a date for all-day events'),
			end: z.string().describe('ISO 8601 with zone offset, or a date for all-day events'),
			location: z.string().optional(),
			description: z.string().optional().describe('Raw event description (join links, meeting notes), capped at 1000 chars'),
		})),
	}),
	execute: async ({ daysAhead, q }, { abortSignal }) => {
		return await listCalendarEvents({ daysAhead, q }, abortSignal ?? undefined);
	},
});
