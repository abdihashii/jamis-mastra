/**
 * Codex subscription OAuth and protocol helpers.
 *
 * Node builtins and plain fetch only: this module must stay runnable inside
 * `oven/bun` with no node_modules (the login and smoke scripts run on the VPS
 * that way). Wire format verified against Mastra Code's Codex OAuth
 * implementation (mastra-ai/mastra, mastracode/sdk); the backend itself is
 * undocumented.
 *
 * Never log token values anywhere in this module; errors carry HTTP status
 * and truncated server text only.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

/**
 * Thrown errors reach the operator's phone as chat text, so they must not
 * name providers, scripts, or internals; the recovery detail goes to logs.
 */
export const MODEL_AUTH_FAILURE = 'Model authentication failed. The error was logged.';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const DEVICE_USER_CODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const DEVICE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
/** Treat the credential as expiring this long before the real expiry so clock skew cannot ship a dead token. */
const CLOCK_SKEW_MS = 60_000;

export const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
export const CODEX_DEVICE_URL = `${ISSUER}/codex/device`;

export interface CodexCredential {
	/** OAuth access token; server-issued lifetime (observed ~10 days). */
	access: string;
	/** Rotating refresh token; single-use, replaced on every refresh. */
	refresh: string;
	/** Epoch ms when `access` expires. Server-issued (`expires_in`); observed ~10 days. */
	expiresAt: number;
	/** Epoch ms when the server first allows the refresh token; refreshing earlier can invalidate it. */
	earliestRefreshAt?: number;
	/** ChatGPT account id, sent as `ChatGPT-Account-ID`. */
	accountId: string;
}

export function defaultCredentialPath(): string {
	const cwd = process.cwd();
	const candidate = (dir: string) => join(dir, 'data', 'openai-codex-auth.json');
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

export async function loadCredential(path: string = defaultCredentialPath()): Promise<CodexCredential | null> {
	let raw: string;
	try {
		raw = await readFile(path, 'utf8');
	}
	catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<CodexCredential>;
		if (!parsed.access || !parsed.refresh || !parsed.accountId || !parsed.expiresAt) {
			return null;
		}
		return {
			access: parsed.access,
			refresh: parsed.refresh,
			expiresAt: parsed.expiresAt,
			earliestRefreshAt: parsed.earliestRefreshAt,
			accountId: parsed.accountId,
		};
	}
	catch {
		return null;
	}
}

/** Atomic write (temp file plus rename) with `0600`, creating the directory. */
async function saveCredential(cred: CodexCredential, path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
	await writeFile(tmp, `${JSON.stringify(cred, null, '\t')}\n`, { mode: 0o600 });
	await rename(tmp, path);
}

function decodeJwt(token: string): Record<string, unknown> | null {
	const parts = token.split('.');
	if (parts.length !== 3)
		return null;
	try {
		const payload = parts[1] ?? '';
		const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
		return JSON.parse(atob(base64)) as Record<string, unknown>;
	}
	catch {
		return null;
	}
}

/** `chatgpt_account_id` lives at the top level or under the `https://api.openai.com/auth` claim. */
export function extractAccountId(idToken: string | undefined, accessToken: string): string | undefined {
	for (const token of [idToken, accessToken]) {
		if (!token)
			continue;
		const payload = decodeJwt(token);
		const claim = payload?.['https://api.openai.com/auth'];
		const fromClaim
			= typeof claim === 'object' && claim !== null ? (claim as Record<string, unknown>).chatgpt_account_id : undefined;
		const accountId = payload?.chatgpt_account_id ?? fromClaim;
		if (typeof accountId === 'string' && accountId.length > 0)
			return accountId;
	}
	return undefined;
}

type TokenResult
	= | {
		ok: true;
		access: string;
		refresh: string;
		expiresAt: number;
		earliestRefreshAt?: number;
		idToken?: string;
	}
	| { ok: false; error: string };

/** `earliest_refresh_at` arrives as epoch seconds, epoch ms, or an ISO string. */
function parseEarliestRefreshAt(value: number | string | undefined): number | undefined {
	if (value === undefined)
		return undefined;
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value < 1e12 ? value * 1000 : value;
	}
	const asNumber = Number(value);
	if (Number.isFinite(asNumber) && asNumber > 0)
		return asNumber < 1e12 ? asNumber * 1000 : asNumber;
	const asIso = Date.parse(String(value));
	return Number.isFinite(asIso) ? asIso : undefined;
}

async function postTokenUrl(params: Record<string, string>): Promise<TokenResult> {
	const response = await fetch(TOKEN_URL, {
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
		id_token?: string;
		earliest_refresh_at?: number | string;
	};
	if (!json.access_token || !json.refresh_token) {
		return { ok: false, error: 'token endpoint response missing required fields' };
	}
	// Field names and schedule hints only; never log token values.
	console.error(
		`[openai-codex] token endpoint fields: ${Object.keys(json).join(',')} (expires_in=${json.expires_in}, earliest_refresh_at=${json.earliest_refresh_at})`,
	);
	return {
		ok: true,
		access: json.access_token,
		refresh: json.refresh_token,
		earliestRefreshAt: parseEarliestRefreshAt(json.earliest_refresh_at),
		expiresAt: Date.now() + (json.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000,
		idToken: json.id_token,
	};
}

export function isExpiring(cred: CodexCredential): boolean {
	return Date.now() >= cred.expiresAt - CLOCK_SKEW_MS;
}

/** ponytail: one in-process refresh lock; only one agent process runs at a time. */
let refreshInFlight: Promise<CodexCredential> | null = null;

/**
 * Refresh the credential and persist the rotated pair BEFORE the new access
 * token is returned: old refresh tokens die on rotation, so losing the write
 * bricks the credential across restarts.
 */
export async function refreshCredential(
	cred: CodexCredential,
	path: string = defaultCredentialPath(),
): Promise<CodexCredential> {
	// Refreshing before the server-declared window invalidates the refresh token — refuse instead.
	if (cred.earliestRefreshAt && Date.now() < cred.earliestRefreshAt - CLOCK_SKEW_MS) {
		throw new Error(
			`Codex credential refresh is server-gated until ${new Date(cred.earliestRefreshAt).toISOString()}; the access token is valid until ${new Date(cred.expiresAt).toISOString()}.`,
		);
	}
	if (!refreshInFlight) {
		refreshInFlight = (async () => {
			const result = await postTokenUrl({
				grant_type: 'refresh_token',
				refresh_token: cred.refresh,
				client_id: CLIENT_ID,
			});
			if (!result.ok) {
				console.error(`[openai-codex] Credential refresh failed: ${result.error}. Re-login required.`);
				throw new Error(MODEL_AUTH_FAILURE);
			}
			const accountId = extractAccountId(result.idToken, result.access) ?? cred.accountId;
			const next: CodexCredential = {
				access: result.access,
				refresh: result.refresh,
				expiresAt: result.expiresAt,
				earliestRefreshAt: result.earliestRefreshAt,
				accountId,
			};
			await saveCredential(next, path);
			return next;
		})().finally(() => {
			refreshInFlight = null;
		});
	}
	return refreshInFlight;
}

/** Load the credential, refreshing (and persisting rotation) when near expiry. */
export async function getUsableCredential(
	path: string = defaultCredentialPath(),
): Promise<{ cred: CodexCredential; refreshed: boolean }> {
	const cred = await loadCredential(path);
	if (!cred) {
		console.error('[openai-codex] No Codex credential. Log in with `bun scripts/openai-codex-login.ts`.');
		throw new Error(MODEL_AUTH_FAILURE);
	}
	if (isExpiring(cred)) {
		return { cred: await refreshCredential(cred, path), refreshed: true };
	}
	return { cred, refreshed: false };
}

export interface DeviceLoginPending {
	deviceAuthId: string;
	userCode: string;
	intervalMs: number;
	deadlineAt: number;
}

export async function startDeviceLogin(): Promise<DeviceLoginPending> {
	const response = await fetch(DEVICE_USER_CODE_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'User-Agent': 'jamis' },
		body: JSON.stringify({ client_id: CLIENT_ID, originator: 'jamis' }),
	});
	if (!response.ok) {
		throw new Error(`device authorization start failed: ${response.status}`);
	}
	const data = (await response.json()) as {
		device_auth_id?: string;
		user_code?: string;
		usercode?: string;
		interval?: string | number;
	};
	const userCode = data.user_code ?? data.usercode;
	if (!data.device_auth_id || !userCode) {
		throw new Error('device authorization response missing required fields');
	}
	const seconds
		= typeof data.interval === 'number' ? data.interval : Number.parseInt(String(data.interval ?? ''), 10) || 5;
	return {
		deviceAuthId: data.device_auth_id,
		userCode,
		intervalMs: Math.max(seconds, 1) * 1000,
		deadlineAt: Date.now() + DEVICE_TIMEOUT_MS,
	};
}

export type DeviceLoginResult
	= | { status: 'complete'; creds: CodexCredential }
		| { status: 'pending' }
		| { status: 'failed'; error: string };

/** One poll. 403/404 means still pending (not an RFC 8628 error-JSON endpoint). */
export async function pollDeviceLogin(pending: DeviceLoginPending): Promise<DeviceLoginResult> {
	if (Date.now() >= pending.deadlineAt) {
		return { status: 'failed', error: 'device authorization timed out after 15 minutes' };
	}
	const response = await fetch(DEVICE_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'User-Agent': 'jamis' },
		body: JSON.stringify({ device_auth_id: pending.deviceAuthId, user_code: pending.userCode }),
	});
	if (response.status === 403 || response.status === 404) {
		return { status: 'pending' };
	}
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		return { status: 'failed', error: `device authorization failed: ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}` };
	}
	const data = (await response.json()) as { authorization_code?: string; code_verifier?: string };
	if (!data.authorization_code || !data.code_verifier) {
		return { status: 'failed', error: 'device token response missing required fields' };
	}
	const tokens = await postTokenUrl({
		grant_type: 'authorization_code',
		client_id: CLIENT_ID,
		code: data.authorization_code,
		code_verifier: data.code_verifier,
		redirect_uri: DEVICE_REDIRECT_URI,
	});
	if (!tokens.ok) {
		return { status: 'failed', error: `token exchange failed: ${tokens.error}` };
	}
	const accountId = extractAccountId(tokens.idToken, tokens.access);
	if (!accountId) {
		return { status: 'failed', error: 'no ChatGPT account id in the Codex token' };
	}
	return {
		status: 'complete',
		creds: {
			access: tokens.access,
			refresh: tokens.refresh,
			expiresAt: tokens.expiresAt,
			earliestRefreshAt: tokens.earliestRefreshAt,
			accountId,
		},
	};
}

/** Runs the device-flow loop and saves the credential. `onAuth` receives the verification URL and user code only. */
export async function runDeviceLogin(
	onAuth: (info: { url: string; userCode: string }) => void,
	path: string = defaultCredentialPath(),
): Promise<CodexCredential> {
	const pending = await startDeviceLogin();
	onAuth({ url: CODEX_DEVICE_URL, userCode: pending.userCode });
	const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
	await sleep(pending.intervalMs);
	for (;;) {
		const result = await pollDeviceLogin(pending);
		if (result.status === 'complete') {
			await saveCredential(result.creds, path);
			return result.creds;
		}
		if (result.status === 'failed') {
			throw new Error(result.error);
		}
		await sleep(pending.intervalMs);
	}
}

export function buildCodexHeaders(cred: CodexCredential): Record<string, string> {
	return {
		'Authorization': `Bearer ${cred.access}`,
		'ChatGPT-Account-ID': cred.accountId,
		'originator': 'jamis',
		'User-Agent': 'jamis',
	};
}

const FALLBACK_INSTRUCTIONS = 'You are Jamis, a personal agent. Be concise.';

/** The undocumented backend rejects `store` and empty `instructions`, and `temperature` together with `topP`. */
export function applyCodexBodyRules(body: Record<string, unknown>): Record<string, unknown> {
	// `stream: true` is unconditional: the backend rejects non-streaming
	// requests with 400 "Stream must be set to true".
	const next: Record<string, unknown> = { ...body, store: false, stream: true };
	if (typeof next.instructions !== 'string' || next.instructions.length === 0) {
		next.instructions = FALLBACK_INSTRUCTIONS;
	}
	if (next.temperature !== undefined && next.temperature !== null) {
		delete next.topP;
	}
	return next;
}

/**
 * One generation through the codex backend. The backend requires
 * `stream: true` and answers over SSE, so this parses the deltas itself.
 */
export async function codexGenerate(options: {
	cred: CodexCredential;
	model: string;
	prompt: string;
	effort?: string;
	signal?: AbortSignal;
}): Promise<string> {
	const response = await fetch(CODEX_API_ENDPOINT, {
		method: 'POST',
		headers: { ...buildCodexHeaders(options.cred), 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
		body: JSON.stringify(
			applyCodexBodyRules({
				model: options.model,
				// The backend rejects a string input: it must be a Responses API message list.
				input: [{ role: 'user', content: [{ type: 'input_text', text: options.prompt }] }],
				...(options.effort ? { reasoning: { effort: options.effort } } : {}),
				stream: true,
			}),
		),
		signal: options.signal,
	});
	if (!response.ok || !response.body) {
		const text = await response.text().catch(() => '');
		throw new Error(`codex request failed: ${response.status}${text ? ` ${text.slice(0, 400)}` : ''}`);
	}
	return await readSseText(response);
}

async function readSseText(response: Response): Promise<string> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let text = '';
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done)
				break;
			buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
			let separator: number = buffer.indexOf('\n\n');
			while (separator !== -1) {
				const raw = buffer.slice(0, separator);
				buffer = buffer.slice(separator + 2);
				for (const line of raw.split('\n')) {
					if (!line.startsWith('data:'))
						continue;
					const data = line.slice(5).trim();
					if (!data || data === '[DONE]')
						continue;
					let event: {
						type?: string;
						delta?: string;
						error?: { message?: string };
						message?: string;
					};
					try {
						event = JSON.parse(data) as typeof event;
					}
					catch {
						continue;
					}
					if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
						text += event.delta;
					}
					if (event.type === 'error' || event.type === 'response.error') {
						throw new Error(`codex stream error: ${event.error?.message ?? event.message ?? data.slice(0, 400)}`);
					}
				}
				separator = buffer.indexOf('\n\n');
			}
		}
	}
	finally {
		reader.releaseLock();
	}
	return text;
}
