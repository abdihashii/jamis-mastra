import type { SqlLike } from '../../lib/operator-time-zone.js';

import { Buffer } from 'node:buffer';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { fetchJson } from '../../lib/fetch.js';
import {
	getUsableCredential,
	GOOGLE_AUTH_FAILURE,
	refreshCredential,
} from '../../lib/google-oauth.js';
import { resolveOperatorTimeZone } from '../../lib/operator-time-zone.js';
import { zonedDayWindow } from '../../lib/time.js';
import { requireEnv, requireOperatorTimeZone } from '../env';
import { recordAccountsGmailRead } from './invoke-specialist';

// Missing client config is a hard failure at boot, same as the other API keys.
const gmailAuth = {
	clientId: requireEnv('GOOGLE_CLIENT_ID'),
	clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
};

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BODY_LIMIT = 4000;
const DEFAULT_MAX_RESULTS = 5;

interface GmailMessageSummary {
	id: string;
	threadId: string;
}

interface GmailListResult {
	messages?: GmailMessageSummary[];
	resultSizeEstimate?: number;
	nextPageToken?: string;
}

interface GmailPayloadPart {
	mimeType?: string;
	body?: { data?: string };
	parts?: GmailPayloadPart[];
	headers?: Array<{ name?: string; value?: string }>;
}

interface GmailGetResult {
	id: string;
	threadId?: string;
	internalDate?: string;
	snippet?: string;
	payload?: GmailPayloadPart;
}

export interface GmailSearchResultMessage {
	subject: string;
	from: string;
	/** ISO 8601 UTC, from Gmail's internalDate. */
	date: string;
	snippet: string;
	/** Decoded first text/plain part, truncated at BODY_LIMIT chars. Absent for HTML-only mail. */
	body?: string;
}

export interface GmailSearchResult {
	estimatedTotal: number;
	messages: GmailSearchResultMessage[];
}

function serviceError(action: string, status: number): Error {
	console.error(`[gmail-search] ${action} failed with status ${status}`);
	if (status === 429)
		return new Error('Gmail is rate-limited. Try again later.');
	return new Error('Gmail request failed.');
}

function unusableData(action: string): Error {
	console.error(`[gmail-search] ${action} returned unusable data`);
	return new Error('Gmail returned unusable data.');
}

function headerOf(payload: GmailPayloadPart | undefined, name: string): string {
	const hit = payload?.headers?.find(h => h.name?.toLowerCase() === name.toLowerCase());
	return hit?.value ?? '';
}

/** Depth-first walk for the first text/plain part carrying body data. */
function findTextPlain(part: GmailPayloadPart | undefined): GmailPayloadPart | null {
	if (!part)
		return null;
	if (part.mimeType === 'text/plain' && part.body?.data)
		return part;
	for (const child of part.parts ?? []) {
		const hit = findTextPlain(child);
		if (hit)
			return hit;
	}
	return null;
}

function decodeBody(data: string): string {
	const text = Buffer.from(data, 'base64url').toString('utf8').replace(/\r\n/g, '\n').trim();
	return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}\n... (truncated)` : text;
}

async function gmailGet(url: string, signal?: AbortSignal): Promise<{ ok: boolean; status: number; json: unknown }> {
	// Silent refresh on expiry happens inside getUsableCredential. A 401 even
	// then means the stored access token is dead ahead of schedule: force one
	// refresh and retry once before calling it an auth failure.
	let cred = await getUsableCredential(gmailAuth);
	let res = await fetchJson(url, signal, { Authorization: `Bearer ${cred.access}` });
	if (res.status === 401) {
		console.error('[gmail-search] Gmail rejected the stored access token; forcing one refresh.');
		cred = await refreshCredential(cred, gmailAuth);
		res = await fetchJson(url, signal, { Authorization: `Bearer ${cred.access}` });
	}
	if (res.status === 401) {
		console.error('[gmail-search] Gmail still 401 after a forced refresh. Re-login required.');
		throw new Error(GOOGLE_AUTH_FAILURE);
	}
	return res;
}

/** Search the operator's mailbox and fetch each hit. Never logs ids, subjects, or bodies. */
export async function searchGmail(
	input: { query: string; maxResults?: number; relativeDay?: 'today' | 'yesterday'; nowMs?: number },
	signal?: AbortSignal,
	sql?: SqlLike,
): Promise<GmailSearchResult> {
	if (!input.query.trim()) {
		// Rides the subagent's "rejected" relay rule instead of the service-trouble branch.
		throw new Error('Gmail rejected the query: empty query.');
	}
	const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
	let dayBounds: [number, number] | undefined;
	if (input.relativeDay) {
		const { timeZone } = await resolveOperatorTimeZone(requireOperatorTimeZone(), sql);
		const [from, to] = zonedDayWindow(timeZone, 1, input.nowMs, input.relativeDay === 'yesterday' ? -1 : 0);
		dayBounds = [Date.parse(from), Date.parse(to)];
	}
	let query = input.query;
	if (dayBounds) {
		// Provider date terms only bound pagination; numeric internalDate below decides membership.
		const dayMs = 24 * 60 * 60 * 1000;
		const after = new Date(dayBounds[0] - 2 * dayMs).toISOString().slice(0, 10).replaceAll('-', '/');
		const before = new Date(dayBounds[1] + 2 * dayMs).toISOString().slice(0, 10).replaceAll('-', '/');
		query += ` after:${after} before:${before}`;
	}

	const messages: GmailSearchResultMessage[] = [];
	let estimatedTotal: number | undefined;
	let pageToken: string | undefined;
	do {
		const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
		if (pageToken)
			params.set('pageToken', pageToken);
		const listRes = await gmailGet(`${GMAIL_API}/messages?${params}`, signal);
		if (listRes.status === 400) {
			// The provider's detail stays server-side; thrown text reaching the operator must be static.
			console.error(`[gmail-search] list rejected the query: ${(listRes.json as { error?: { message?: string } } | null)?.error?.message ?? 'no detail'}`);
			throw new Error('Gmail rejected the query. Check the search syntax.');
		}
		if (!listRes.ok) {
			throw serviceError('messages.list', listRes.status);
		}
		const list = listRes.json as GmailListResult | null;
		if (
			list === null
			|| (list.messages !== undefined && !Array.isArray(list.messages))
			|| (list.nextPageToken !== undefined && typeof list.nextPageToken !== 'string')
		) {
			throw unusableData('messages.list');
		}
		estimatedTotal ??= list.resultSizeEstimate;

		for (const hit of (list.messages ?? []).slice(0, maxResults)) {
			const getRes = await gmailGet(`${GMAIL_API}/messages/${encodeURIComponent(hit.id)}?format=full`, signal);
			if (!getRes.ok) {
				throw serviceError('messages.get', getRes.status);
			}
			const msg = getRes.json as GmailGetResult | null;
			if (!msg?.id || !msg.internalDate || !Number.isFinite(Number(msg.internalDate))) {
				throw unusableData('messages.get');
			}
			const internalDate = Number(msg.internalDate);
			if (dayBounds && (internalDate < dayBounds[0] || internalDate >= dayBounds[1]))
				continue;
			const textPart = findTextPlain(msg.payload);
			messages.push({
				subject: headerOf(msg.payload, 'Subject'),
				from: headerOf(msg.payload, 'From'),
				date: new Date(internalDate).toISOString(),
				snippet: msg.snippet ?? '',
				...(textPart?.body?.data ? { body: decodeBody(textPart.body.data) } : {}),
			});
			if (messages.length === maxResults)
				break;
		}
		pageToken = dayBounds && messages.length < maxResults ? list.nextPageToken : undefined;
	} while (pageToken);

	return {
		estimatedTotal: estimatedTotal ?? messages.length,
		messages,
	};
}

export const gmailSearchTool = createTool({
	id: 'gmail-search',
	description:
		'Search the operator\'s Gmail (read-only) and fetch matching messages. '
		+ 'Use Gmail search-box syntax for the query: "is:unread", "from:someone@example.com", '
		+ '"subject:invoice newer_than:7d". Use relativeDay for exact operator-local today/yesterday filtering. '
		+ 'Returns subject, sender, date, snippet, and body text per message.',
	inputSchema: z.object({
		query: z.string().min(1).describe('Gmail search-box syntax, e.g. "is:unread" or "from:sarah@example.com newer_than:7d"'),
		maxResults: z.number().int().min(1).max(20).optional().describe('Max messages to return (default 5). Relative-day searches may inspect more candidates.'),
		relativeDay: z.enum(['today', 'yesterday']).optional().describe('Filter fetched messages to this day in the effective operator time zone'),
	}),
	outputSchema: z.object({
		estimatedTotal: z.number().describe('Gmail\'s estimate of total matches; can exceed messages returned'),
		messages: z.array(z.object({
			subject: z.string(),
			from: z.string(),
			date: z.string().describe('ISO 8601 UTC'),
			snippet: z.string(),
			body: z.string().optional(),
		})),
	}),
	execute: async ({ query, maxResults, relativeDay }, { abortSignal, requestContext }) => {
		const result = await searchGmail({ query, maxResults, relativeDay }, abortSignal ?? undefined);
		recordAccountsGmailRead(requestContext, result);
		return result;
	},
});
