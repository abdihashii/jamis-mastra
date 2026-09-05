/**
 * Google OAuth for the operator's Gmail (ADR 0015, plan 011).
 *
 * Node builtins and plain fetch only: this module must stay runnable inside
 * `oven/bun` with no node_modules (the login and smoke scripts run on the VPS
 * that way). Desktop-app client, loopback redirect, credential must carry
 * every scope in GOOGLE_REQUIRED_SCOPES (plan 012 superset membership). Wire format from
 * https://developers.google.com/identity/protocols/oauth2/native-app — the
 * loopback listener and any-port redirect remain supported for Desktop clients.
 *
 * Never log token values anywhere in this module; errors carry HTTP status
 * and truncated server text only.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

/**
 * Thrown errors can reach the operator's phone as chat text, so they must not
 * name providers, scripts, or internals; the recovery detail goes to logs.
 */
export const GOOGLE_AUTH_FAILURE = 'Authentication failed. The error was logged.';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const CALENDAR_EVENTS_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
export const CALENDAR_LIST_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
/**
 * Every scope Jamis needs; the granted set must contain all of them. A miss
 * fails generic, so a stale file never reaches the API.
 */
export const GOOGLE_REQUIRED_SCOPES = [GMAIL_READONLY_SCOPE, CALENDAR_EVENTS_READONLY_SCOPE, CALENDAR_LIST_READONLY_SCOPE] as const;
const GOOGLE_CALENDARLIST_URL = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';
const DEFAULT_EXPIRES_IN_SECONDS = 3599;
/** Treat the credential as expiring this long before the real expiry so clock skew cannot ship a dead token. */
const CLOCK_SKEW_MS = 60_000;

export interface GoogleCredential {
	/** OAuth access token; server-issued lifetime (~1 hour). */
	access: string;
	/** Refresh token. Usually stable; persisted on rotation when the token endpoint issues a new one. */
	refresh: string;
	/** Epoch ms when `access` expires. */
	expiresAt: number;
	/** Granted scopes, space-delimited; must contain every GOOGLE_REQUIRED_SCOPES member. */
	scope: string;
	/** Calendar pool picked at login (plan 012). */
	calendars?: Array<{ id: string; summary: string; timeZone: string; primary?: boolean }>;
}

export function defaultCredentialPath(): string {
	const cwd = process.cwd();
	const candidate = (dir: string) => join(dir, 'data', 'google-oauth.json');
	if (existsSync(candidate(cwd)))
		return candidate(cwd);
	// `mastra dev` serves API requests from the bundler output with cwd inside
	// the repo (src/mastra/public), so the walk-up finds the repo-root data dir.
	// ponytail: bounded ancestor walk (6 levels), no .git/package.json anchors —
	// add an env override only if some deployment needs it.
	let dir = cwd;
	for (let i = 0; i < 6; i++) {
		const parent = dirname(dir);
		if (parent === dir)
			break;
		dir = parent;
		if (existsSync(candidate(dir)))
			return candidate(dir);
	}
	return candidate(cwd);
}

export async function loadCredential(path: string = defaultCredentialPath()): Promise<GoogleCredential | null> {
	let raw: string;
	try {
		raw = await readFile(path, 'utf8');
	}
	catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<GoogleCredential>;
		// Types, not truthiness: "expiresAt": "soon" must not pass as a fresh credential.
		if (typeof parsed.access !== 'string' || parsed.access.length === 0
			|| typeof parsed.refresh !== 'string' || parsed.refresh.length === 0
			|| typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)
			|| typeof parsed.scope !== 'string' || parsed.scope.length === 0) {
			return null;
		}
		// The pool is operator-picked data, not auth material; malformed entries
		// drop silently instead of hard-failing the credential.
		const calendars = Array.isArray(parsed.calendars)
			? parsed.calendars.filter((c): c is { id: string; summary: string; timeZone: string; primary?: boolean } =>
					typeof c === 'object' && c !== null
					&& typeof (c as { id?: unknown }).id === 'string'
					&& typeof (c as { summary?: unknown }).summary === 'string'
					&& typeof (c as { timeZone?: unknown }).timeZone === 'string')
					// Re-normalize each entry: no raw spread, so stray keys or a
					// string "primary" cannot survive into agent context.
					.map(c => ({
						id: c.id,
						summary: c.summary,
						timeZone: c.timeZone,
						...(c.primary === true ? { primary: true } : {}),
					}))
			: undefined;
		return {
			access: parsed.access,
			refresh: parsed.refresh,
			expiresAt: parsed.expiresAt,
			scope: parsed.scope,
			...(calendars?.length ? { calendars } : {}),
		};
	}
	catch {
		return null;
	}
}

/** Atomic write (temp file plus rename) with `0600`, creating the directory. */
export async function saveCredential(cred: GoogleCredential, path: string = defaultCredentialPath()): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
	await writeFile(tmp, `${JSON.stringify(cred, null, '\t')}\n`, { mode: 0o600 });
	await rename(tmp, path);
}

/** Granted scopes must contain every GOOGLE_REQUIRED_SCOPES member. */
export function checkScope(scope: string): string {
	const granted = new Set(scope.trim().split(/\s+/).filter(Boolean));
	const missing = GOOGLE_REQUIRED_SCOPES.filter(required => !granted.has(required));
	if (missing.length > 0) {
		console.error(`[google-oauth] token scope is "${scope}", missing required: ${missing.join(', ')}`);
		throw new Error(GOOGLE_AUTH_FAILURE);
	}
	return scope;
}

export function isExpiring(cred: GoogleCredential): boolean {
	return Date.now() >= cred.expiresAt - CLOCK_SKEW_MS;
}

type TokenResult
	= | { ok: true; access: string; refresh?: string; expiresAt: number; scope: string }
		| { ok: false; error: string };

async function postToken(params: Record<string, string>): Promise<TokenResult> {
	const response = await fetch(GOOGLE_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(params),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		return { ok: false, error: `token endpoint ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}` };
	}
	const json = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		scope?: string;
	};
	if (!json.access_token) {
		return { ok: false, error: 'token endpoint response missing access_token' };
	}
	return {
		ok: true,
		access: json.access_token,
		refresh: json.refresh_token,
		expiresAt: Date.now() + (json.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000,
		scope: json.scope ?? '',
	};
}

/** ponytail: one in-process refresh lock; only one agent process runs at a time. */
let refreshInFlight: Promise<GoogleCredential> | null = null;

/**
 * Refresh the credential and persist (with any rotated refresh token) BEFORE
 * the new access token is returned, so a restart cannot strand a token the
 * endpoint already replaced.
 */
export async function refreshCredential(
	cred: GoogleCredential,
	auth: { clientId: string; clientSecret: string },
	path: string = defaultCredentialPath(),
): Promise<GoogleCredential> {
	if (!refreshInFlight) {
		refreshInFlight = (async () => {
			const result = await postToken({
				grant_type: 'refresh_token',
				refresh_token: cred.refresh,
				client_id: auth.clientId,
				client_secret: auth.clientSecret,
			});
			if (!result.ok) {
				console.error(`[google-oauth] Credential refresh failed: ${result.error}. Re-login required.`);
				throw new Error(GOOGLE_AUTH_FAILURE);
			}
			const scope = result.scope ? checkScope(result.scope) : cred.scope;
			const next: GoogleCredential = {
				access: result.access,
				refresh: result.refresh ?? cred.refresh,
				expiresAt: result.expiresAt,
				scope,
				...(cred.calendars ? { calendars: cred.calendars } : {}),
			};
			await saveCredential(next, path);
			return next;
		})().finally(() => {
			refreshInFlight = null;
		});
	}
	return refreshInFlight;
}

/** Load the credential, refreshing (and persisting) when near expiry. Missing or dead is a hard failure. */
export async function getUsableCredential(
	auth: { clientId: string; clientSecret: string },
	path: string = defaultCredentialPath(),
): Promise<GoogleCredential> {
	const cred = await loadCredential(path);
	if (!cred) {
		console.error('[google-oauth] No Google credential. Log in with `bun scripts/google-login.ts`.');
		throw new Error(GOOGLE_AUTH_FAILURE);
	}
	// A hand-edited credential missing a required scope fails here, not at the first refresh.
	checkScope(cred.scope);
	if (isExpiring(cred)) {
		return refreshCredential(cred, auth, path);
	}
	return cred;
}

/**
 * List the operator's calendars for the login-time pool picker (plan 012).
 * Callers check `hasCalendarListScope` first. Never logs calendar data.
 */
export async function listOperatorCalendars(accessToken: string): Promise<Array<{ id: string; summary: string; timeZone: string; primary?: boolean }>> {
	// ponytail: one page of 250 covers any sane account (operator has ~6); add
	// nextPageToken loop if someone ever hits the cap.
	const response = await fetch(`${GOOGLE_CALENDARLIST_URL}?maxResults=250`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`calendarList failed with status ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
	}
	const json = (await response.json()) as {
		items?: Array<{ id?: string; summary?: string; timeZone?: string; primary?: boolean }>;
	};
	return (json.items ?? [])
		.filter((c): c is { id: string; summary?: string; timeZone: string; primary?: boolean } => typeof c.id === 'string' && c.id.length > 0 && typeof c.timeZone === 'string')
		.map(c => ({
			id: c.id,
			summary: c.summary ?? c.id,
			timeZone: c.timeZone,
			...(c.primary === true ? { primary: true } : {}),
		}));
}

/** Whether the granted scope set carries the calendar-list scope (drives the login-time pool picker). */
export function hasCalendarListScope(scope: string): boolean {
	return scope.split(/\s+/).includes(CALENDAR_LIST_READONLY_SCOPE);
}

/** Persist a calendar pool onto the stored credential (atomic, 0600). */
export async function saveCalendarPool(calendars: Array<{ id: string; summary: string; timeZone: string; primary?: boolean }>, path: string = defaultCredentialPath()): Promise<void> {
	const cred = await loadCredential(path);
	if (!cred)
		throw new Error(GOOGLE_AUTH_FAILURE);
	await saveCredential({ ...cred, calendars }, path);
}

/** PKCE pair (S256) plus a CSRF state token for one login attempt. */
export function generatePkceAndState(): { codeVerifier: string; codeChallenge: string; state: string } {
	const codeVerifier = randomBytes(32).toString('base64url');
	const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
	return { codeVerifier, codeChallenge, state: randomBytes(16).toString('base64url') };
}

/** Consent URL for the loopback flow: offline access yields the refresh token, prompt=consent re-issues it on re-login. */
export function buildAuthUrl(options: {
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
}): string {
	return `${GOOGLE_AUTH_URL}?${new URLSearchParams({
		client_id: options.clientId,
		redirect_uri: options.redirectUri,
		response_type: 'code',
		scope: GOOGLE_REQUIRED_SCOPES.join(' '),
		state: options.state,
		code_challenge: options.codeChallenge,
		code_challenge_method: 'S256',
		access_type: 'offline',
		prompt: 'consent',
	})}`;
}

/** Exchange a loopback authorization code for the initial credential. */
export async function exchangeCode(options: {
	code: string;
	codeVerifier: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}): Promise<GoogleCredential> {
	const result = await postToken({
		grant_type: 'authorization_code',
		code: options.code,
		code_verifier: options.codeVerifier,
		client_id: options.clientId,
		client_secret: options.clientSecret,
		redirect_uri: options.redirectUri,
	});
	if (!result.ok) {
		throw new Error(`code exchange failed: ${result.error}`);
	}
	if (!result.refresh) {
		throw new Error('code exchange returned no refresh token; re-run login so prompt=consent re-issues one');
	}
	return {
		access: result.access,
		refresh: result.refresh,
		expiresAt: result.expiresAt,
		scope: checkScope(result.scope),
	};
}
