import type { GoogleCredential } from '../google-oauth.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	buildAuthUrl,
	checkScope,
	defaultCredentialPath,
	exchangeCode,
	generatePkceAndState,
	getUsableCredential,
	GMAIL_READONLY_SCOPE,
	GOOGLE_AUTH_FAILURE,
	GOOGLE_TOKEN_URL,
	isExpiring,
	loadCredential,
	refreshCredential,
	saveCredential,
} from '../google-oauth.js';

/** The credential path is cwd-relative, so each test runs in a temp dir. */
let tempDir: string;
let originalCwd: string;
let originalFetch: typeof globalThis.fetch;
const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

const CLIENT = { clientId: 'test-client-id', clientSecret: 'test-client-secret' };

function makeCredential(overrides: Partial<GoogleCredential> = {}): GoogleCredential {
	return {
		access: 'test-access-token',
		refresh: 'test-refresh-token',
		expiresAt: Date.now() + 30 * 60 * 1000,
		scope: GMAIL_READONLY_SCOPE,
		...overrides,
	};
}

async function writeCredential(cred: GoogleCredential) {
	await mkdir(join(tempDir, 'data'), { recursive: true });
	await writeFile(join(tempDir, 'data', 'google-oauth.json'), JSON.stringify(cred), { mode: 0o600 });
}

async function readCredential(): Promise<GoogleCredential> {
	return JSON.parse(await Bun.file(join(tempDir, 'data', 'google-oauth.json')).text()) as GoogleCredential;
}

function tokenJson(body: Record<string, unknown>, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Mock globalThis.fetch, recording calls; default token endpoint grants a fresh access token. */
function mockFetch(tokenResponse?: () => Response) {
	fetchCalls.length = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		fetchCalls.push({ url: String(input), init });
		if (String(input).startsWith(GOOGLE_TOKEN_URL)) {
			return tokenResponse?.() ?? tokenJson({
				access_token: 'fresh-access-token',
				expires_in: 3599,
				scope: GMAIL_READONLY_SCOPE,
			});
		}
		throw new Error(`unexpected fetch to ${String(input)}`);
	}) as unknown as typeof globalThis.fetch;
}

function sentForm(): URLSearchParams {
	const last = fetchCalls.at(-1);
	if (!last)
		throw new Error('no fetch call was recorded');
	return new URLSearchParams(last.init!.body as string);
}

async function captureError(action: () => Promise<unknown>): Promise<Error> {
	try {
		await action();
	}
	catch (error) {
		return error as Error;
	}
	throw new Error('expected the action to throw, but it resolved');
}

beforeEach(async () => {
	// macOS tmpdir is a symlink; chdir makes process.cwd() report the realpath.
	tempDir = realpathSync(await mkdtemp(join(tmpdir(), 'google-oauth-')));
	originalCwd = process.cwd();
	process.chdir(tempDir);
	originalFetch = globalThis.fetch;
	mockFetch();
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	process.chdir(originalCwd);
	await rm(tempDir, { recursive: true, force: true });
});

describe('credential file', () => {
	test('save and load round-trips with 0600 permissions', async () => {
		const cred = makeCredential();
		await saveCredential(cred);
		const { stat } = await import('node:fs/promises');
		const info = await stat(join(tempDir, 'data', 'google-oauth.json'));
		expect(info.mode & 0o777).toBe(0o600);
		expect(await loadCredential()).toEqual(cred);
	});

	test('load returns null when the file is missing, corrupt, incomplete, or wrongly typed', async () => {
		expect(await loadCredential()).toBeNull();
		await mkdir(join(tempDir, 'data'), { recursive: true });
		await writeFile(join(tempDir, 'data', 'google-oauth.json'), 'not json');
		expect(await loadCredential()).toBeNull();
		await writeFile(join(tempDir, 'data', 'google-oauth.json'), JSON.stringify({ access: 'x' }));
		expect(await loadCredential()).toBeNull();
		await writeFile(join(tempDir, 'data', 'google-oauth.json'), JSON.stringify({ ...makeCredential(), expiresAt: 'soon' }));
		expect(await loadCredential()).toBeNull();
	});

	test('resolver prefers cwd, then walks up for the bundler cwd quirk', async () => {
		expect(defaultCredentialPath()).toBe(join(tempDir, 'data', 'google-oauth.json'));
		await writeCredential(makeCredential());
		const nested = join(tempDir, 'nested', 'deep', 'dir');
		await mkdir(nested, { recursive: true });
		process.chdir(nested);
		expect(defaultCredentialPath()).toBe(join(tempDir, 'data', 'google-oauth.json'));
	});
});

describe('scope check', () => {
	test('accepts exactly gmail.readonly and rejects anything else', () => {
		expect(checkScope(GMAIL_READONLY_SCOPE)).toBe(GMAIL_READONLY_SCOPE);
		void expect(() => checkScope(`${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.metadata`)).toThrow(GOOGLE_AUTH_FAILURE);
		void expect(() => checkScope('https://www.googleapis.com/auth/gmail.metadata')).toThrow(GOOGLE_AUTH_FAILURE);
		void expect(() => checkScope('')).toThrow(GOOGLE_AUTH_FAILURE);
	});
});

describe('isExpiring', () => {
	test('applies the clock-skew margin', () => {
		expect(isExpiring(makeCredential({ expiresAt: Date.now() + 30 * 60 * 1000 }))).toBe(false);
		expect(isExpiring(makeCredential({ expiresAt: Date.now() + 30 * 1000 }))).toBe(true);
		expect(isExpiring(makeCredential({ expiresAt: Date.now() - 1000 }))).toBe(true);
	});
});

describe('refresh', () => {
	test('posts the refresh grant with client auth and persists before returning', async () => {
		const old = makeCredential({ expiresAt: Date.now() - 1000 });
		await writeCredential(old);
		const next = await refreshCredential(old, CLIENT);
		expect(next.access).toBe('fresh-access-token');
		expect(next.refresh).toBe(old.refresh);
		expect(next.expiresAt).toBeGreaterThan(Date.now());
		expect(next.scope).toBe(GMAIL_READONLY_SCOPE);
		expect(await readCredential()).toEqual(next);
		const form = sentForm();
		expect(form.get('grant_type')).toBe('refresh_token');
		expect(form.get('refresh_token')).toBe(old.refresh);
		expect(form.get('client_id')).toBe(CLIENT.clientId);
		expect(form.get('client_secret')).toBe(CLIENT.clientSecret);
	});

	test('persists a rotated refresh token when the endpoint issues one', async () => {
		mockFetch(() => tokenJson({
			access_token: 'fresh-access-token',
			refresh_token: 'rotated-refresh-token',
			expires_in: 3599,
			scope: GMAIL_READONLY_SCOPE,
		}));
		const old = makeCredential({ expiresAt: Date.now() - 1000 });
		await writeCredential(old);
		const next = await refreshCredential(old, CLIENT);
		expect(next.refresh).toBe('rotated-refresh-token');
		expect((await readCredential()).refresh).toBe('rotated-refresh-token');
	});

	test('invalid_grant surfaces only the generic auth failure', async () => {
		mockFetch(() => tokenJson({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400));
		const error = await captureError(() => refreshCredential(makeCredential(), CLIENT));
		expect(error.message).toBe(GOOGLE_AUTH_FAILURE);
		expect(JSON.stringify(error.message)).not.toContain('refresh');
	});

	test('a scope downgrade on refresh throws the generic failure and leaves the file untouched', async () => {
		mockFetch(() => tokenJson({
			access_token: 'fresh-access-token',
			expires_in: 3599,
			scope: 'https://www.googleapis.com/auth/gmail.metadata',
		}));
		const old = makeCredential({ expiresAt: Date.now() - 1000 });
		await writeCredential(old);
		const error = await captureError(() => refreshCredential(old, CLIENT));
		expect(error.message).toBe(GOOGLE_AUTH_FAILURE);
		expect(await loadCredential()).toEqual(old);
	});

	test('concurrent refreshes share one in-flight request', async () => {
		const old = makeCredential({ expiresAt: Date.now() - 1000 });
		await writeCredential(old);
		const [a, b] = await Promise.all([refreshCredential(old, CLIENT), refreshCredential(old, CLIENT)]);
		expect(a).toEqual(b);
		expect(fetchCalls).toHaveLength(1);
	});
});

describe('getUsableCredential', () => {
	test('missing credential is a hard failure with the generic text', async () => {
		const error = await captureError(() => getUsableCredential(CLIENT));
		expect(error.message).toBe(GOOGLE_AUTH_FAILURE);
	});

	test('a fresh credential costs no network call', async () => {
		const cred = makeCredential();
		await writeCredential(cred);
		expect(await getUsableCredential(CLIENT)).toEqual(cred);
		expect(fetchCalls).toHaveLength(0);
	});

	test('a hand-edited credential with a broader scope fails generically without a network call', async () => {
		await writeCredential(makeCredential({ scope: 'https://www.googleapis.com/auth/gmail.modify' }));
		const error = await captureError(() => getUsableCredential(CLIENT));
		expect(error.message).toBe(GOOGLE_AUTH_FAILURE);
		expect(fetchCalls).toHaveLength(0);
	});

	test('an expiring credential refreshes silently', async () => {
		await writeCredential(makeCredential({ expiresAt: Date.now() + 30 * 1000 }));
		const next = await getUsableCredential(CLIENT);
		expect(next.access).toBe('fresh-access-token');
		expect(fetchCalls).toHaveLength(1);
	});
});

describe('pkce and consent url', () => {
	test('pkce verifier, S256 challenge, and state have the right shapes', () => {
		const { codeVerifier, codeChallenge, state } = generatePkceAndState();
		expect(codeVerifier).toMatch(/^[\w-]{43}$/);
		expect(codeChallenge).toBe(createHash('sha256').update(codeVerifier).digest('base64url'));
		expect(codeChallenge).not.toBe(codeVerifier);
		expect(state).toMatch(/^[\w-]{22}$/);
	});

	test('consent url pins read-only offline access', () => {
		const url = new URL(buildAuthUrl({
			clientId: CLIENT.clientId,
			redirectUri: 'http://127.0.0.1:53682',
			state: 'test-state',
			codeChallenge: 'test-challenge',
		}));
		expect(url.origin).toBe('https://accounts.google.com');
		expect(url.pathname).toBe('/o/oauth2/v2/auth');
		expect(url.searchParams.get('response_type')).toBe('code');
		expect(url.searchParams.get('scope')).toBe(GMAIL_READONLY_SCOPE);
		expect(url.searchParams.get('access_type')).toBe('offline');
		expect(url.searchParams.get('prompt')).toBe('consent');
		expect(url.searchParams.get('code_challenge')).toBe('test-challenge');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('state')).toBe('test-state');
		expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:53682');
		expect(url.searchParams.get('client_id')).toBe(CLIENT.clientId);
	});
});

describe('code exchange', () => {
	test('exchanges the code for a credential and checks the granted scope', async () => {
		mockFetch(() => tokenJson({
			access_token: 'initial-access',
			refresh_token: 'initial-refresh',
			expires_in: 3599,
			scope: GMAIL_READONLY_SCOPE,
		}));
		const cred = await exchangeCode({
			code: 'auth-code',
			codeVerifier: 'verifier',
			clientId: CLIENT.clientId,
			clientSecret: CLIENT.clientSecret,
			redirectUri: 'http://127.0.0.1:53682',
		});
		expect(cred.access).toBe('initial-access');
		expect(cred.refresh).toBe('initial-refresh');
		expect(cred.scope).toBe(GMAIL_READONLY_SCOPE);
		const form = sentForm();
		expect(form.get('grant_type')).toBe('authorization_code');
		expect(form.get('code')).toBe('auth-code');
		expect(form.get('code_verifier')).toBe('verifier');
		expect(form.get('redirect_uri')).toBe('http://127.0.0.1:53682');
	});

	test('fails clearly when no refresh token is issued', async () => {
		mockFetch(() => tokenJson({
			access_token: 'initial-access',
			expires_in: 3599,
			scope: GMAIL_READONLY_SCOPE,
		}));
		const error = await captureError(() => exchangeCode({
			code: 'auth-code',
			codeVerifier: 'verifier',
			clientId: CLIENT.clientId,
			clientSecret: CLIENT.clientSecret,
			redirectUri: 'http://127.0.0.1:53682',
		}));
		expect(error.message).toContain('no refresh token');
	});

	test('endpoint failure carries the status, and a wrong scope is the generic failure', async () => {
		mockFetch(() => tokenJson({ error: 'invalid_grant' }, 400));
		const bad = await captureError(() => exchangeCode({
			code: 'x',
			codeVerifier: 'v',
			clientId: CLIENT.clientId,
			clientSecret: CLIENT.clientSecret,
			redirectUri: 'http://127.0.0.1:53682',
		}));
		expect(bad.message).toContain('400');

		mockFetch(() => tokenJson({
			access_token: 'a',
			refresh_token: 'r',
			expires_in: 3599,
			scope: 'https://www.googleapis.com/auth/gmail.modify',
		}));
		const scoped = await captureError(() => exchangeCode({
			code: 'x',
			codeVerifier: 'v',
			clientId: CLIENT.clientId,
			clientSecret: CLIENT.clientSecret,
			redirectUri: 'http://127.0.0.1:53682',
		}));
		expect(scoped.message).toBe(GOOGLE_AUTH_FAILURE);
	});
});
