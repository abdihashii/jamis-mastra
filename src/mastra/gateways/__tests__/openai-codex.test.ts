import type { GatewayLanguageModel } from '@mastra/core/llm';
import type { CodexCredential } from '../openai-codex-auth.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultCredentialPath, MODEL_AUTH_FAILURE, refreshCredential, runDeviceLogin } from '../openai-codex-auth.js';
import { codexFetch, forcingStoreFalse, openAICodexGateway } from '../openai-codex-gateway.js';

/** The credential path is cwd-relative, so each test runs in a temp dir. */
let tempDir: string;
let originalCwd: string;
let originalFetch: typeof globalThis.fetch;
let originalDateNow: typeof Date.now;
let originalSetTimeout: typeof globalThis.setTimeout;
interface FetchCall { url: string; init: RequestInit | undefined }
const fetchCalls: FetchCall[] = [];

function makeCredential(overrides: Partial<CodexCredential> = {}): CodexCredential {
	return {
		access: 'test-access-token',
		refresh: 'test-refresh-token',
		expiresAt: Date.now() + 24 * 60 * 60 * 1000,
		accountId: 'test-account-id',
		...overrides,
	};
}

async function writeCredential(cred: CodexCredential) {
	await mkdir(join(tempDir, 'data'), { recursive: true });
	await writeFile(join(tempDir, 'data', 'openai-codex-auth.json'), JSON.stringify(cred), { mode: 0o600 });
}

async function readCredential(): Promise<CodexCredential> {
	return JSON.parse(await Bun.file(join(tempDir, 'data', 'openai-codex-auth.json')).text()) as CodexCredential;
}

/** Mock globalThis.fetch, recording calls; optional overrides for endpoint responses. */
function mockFetch(handlers?: {
	tokenEndpoint?: (call: FetchCall) => Response | Promise<Response>;
	generation?: (call: FetchCall) => Response | Promise<Response>;
	deviceStart?: (call: FetchCall) => Response | Promise<Response>;
	devicePoll?: (call: FetchCall) => Response | Promise<Response>;
}) {
	fetchCalls.length = 0;
	const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		fetchCalls.push({ url: String(input), init: init as RequestInit | undefined });
		if (handlers?.deviceStart && String(input).includes('/deviceauth/usercode'))
			return handlers.deviceStart(fetchCalls.at(-1)!);
		if (handlers?.devicePoll && String(input).includes('/deviceauth/token'))
			return handlers.devicePoll(fetchCalls.at(-1)!);
		if (handlers?.tokenEndpoint && String(input).includes('/oauth/token')) {
			return handlers.tokenEndpoint(fetchCalls.at(-1)!);
		}
		if (handlers?.generation) {
			return handlers.generation(fetchCalls.at(-1)!);
		}
		return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
	};
	globalThis.fetch = impl as unknown as typeof globalThis.fetch;
}

function refreshedTokenResponse(): Response {
	return new Response(
		JSON.stringify({
			access_token: 'new-access',
			refresh_token: 'new-refresh',
			expires_in: 864000,
			earliest_refresh_at: '2030-01-01T00:00:00Z',
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } },
	);
}

async function sentHeaders(): Promise<Headers> {
	const last = fetchCalls.at(-1);
	if (!last)
		throw new Error('no fetch call was recorded');
	return new Headers(last.init!.headers);
}

async function sentBody(): Promise<Record<string, unknown>> {
	const last = fetchCalls.at(-1);
	if (!last)
		throw new Error('no fetch call was recorded');
	return JSON.parse(last.init!.body as string) as Record<string, unknown>;
}

async function performCodexFetch(body: unknown): Promise<Response> {
	return await codexFetch('https://chatgpt.com/backend-api/codex/responses', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', 'authorization': 'Bearer oauth' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
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
	tempDir = await mkdtemp(join(tmpdir(), 'codex-gateway-'));
	originalCwd = process.cwd();
	process.chdir(tempDir);
	originalFetch = globalThis.fetch;
	originalDateNow = Date.now;
	originalSetTimeout = globalThis.setTimeout;
	mockFetch();
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	Date.now = originalDateNow;
	globalThis.setTimeout = originalSetTimeout;
	process.chdir(originalCwd);
	await rm(tempDir, { recursive: true, force: true });
});

describe('gateway identity and catalog', () => {
	test('claims the openai-codex namespace only', () => {
		expect(openAICodexGateway.id).toBe('openai-codex');
		// handlesModel stays at its false default: bare openai/* ids stay on models.dev.
		expect(openAICodexGateway.handlesModel('openai/gpt-5.6-terra')).toBe(false);
		expect(openAICodexGateway.handlesModel('openai-codex/gpt-5.6-terra')).toBe(false);
	});

	test('advertises gpt-5.6-terra with no api-key env var', async () => {
		const providers = await openAICodexGateway.fetchProviders();
		expect(Object.keys(providers)).toEqual(['openai-codex']);
		expect(providers['openai-codex']?.models).toEqual(['gpt-5.6-terra']);
		expect(providers['openai-codex']?.apiKeyEnvVar).toBe('');
		expect(await openAICodexGateway.buildUrl('openai-codex/gpt-5.6-terra', {})).toBe(
			'https://chatgpt.com/backend-api/codex/responses',
		);
	});

	test('serializeForSpan exposes only id and name', () => {
		expect(openAICodexGateway.serializeForSpan()).toEqual({
			id: 'openai-codex',
			name: 'OpenAI Codex (subscription)',
		});
	});
});

describe('resolveAuth', () => {
	test('returns bearer token and account headers for a usable credential, with no network calls', async () => {
		await writeCredential(makeCredential());
		const auth = await openAICodexGateway.resolveAuth();
		expect(auth?.bearerToken).toBe('test-access-token');
		expect(auth?.headers).toEqual({ 'ChatGPT-Account-ID': 'test-account-id', 'originator': 'jamis' });
		expect(fetchCalls.length).toBe(0);
	});

	test('returns undefined when no credential exists', async () => {
		expect(await openAICodexGateway.resolveAuth()).toBeUndefined();
		expect(fetchCalls.length).toBe(0);
	});

	test('getApiKey fails generically and logs the recovery detail', async () => {
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (message: string) => {
			errors.push(message);
		};
		try {
			const error = await captureError(() => openAICodexGateway.getApiKey('openai-codex/gpt-5.6-terra'));
			expect(error.message).toBe(MODEL_AUTH_FAILURE);
			expect(error.message).not.toContain('codex');
			expect(errors.some(e => e.includes('scripts/openai-codex-login.ts'))).toBe(true);
		}
		finally {
			console.error = originalError;
		}
	});
});

describe('codexFetch header injection', () => {
	test('replaces placeholder auth with the codex headers and nothing else', async () => {
		await writeCredential(makeCredential());
		await performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x' });
		const headers = await sentHeaders();
		expect(headers.get('authorization')).toBe('Bearer test-access-token');
		expect(headers.get('chatgpt-account-id')).toBe('test-account-id');
		expect(headers.get('originator')).toBe('jamis');
		expect(headers.get('user-agent')).toBe('jamis');
	});

	test('uses the live credential per request, not a captured one', async () => {
		await writeCredential(makeCredential({ access: 'first-token' }));
		await performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x' });
		expect((await sentHeaders()).get('authorization')).toBe('Bearer first-token');

		await writeCredential(makeCredential({ access: 'rotated-token' }));
		await performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x' });
		expect((await sentHeaders()).get('authorization')).toBe('Bearer rotated-token');
	});
});

describe('codexFetch body rules', () => {
	test('forces stream:true, the backend rejects non-streaming requests', async () => {
		await writeCredential(makeCredential());
		await performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x' });
		expect((await sentBody()).stream).toBe(true);

		await performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x', stream: false });
		expect((await sentBody()).stream).toBe(true);
	});

	test('forces store:false', async () => {
		await writeCredential(makeCredential());
		await performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x', store: true });
		expect((await sentBody()).store).toBe(false);
	});

	test('fills empty or missing instructions with a non-empty fallback', async () => {
		await writeCredential(makeCredential());
		await performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: '' });
		expect(typeof (await sentBody()).instructions).toBe('string');
		await performCodexFetch({ model: 'gpt-5.6-terra', input: [] });
		const sent = await sentBody();
		expect(typeof sent.instructions).toBe('string');
		expect((sent.instructions as string).length).toBeGreaterThan(0);
	});

	test('drops topP when temperature is set', async () => {
		await writeCredential(makeCredential());
		await performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x', temperature: 0.7, topP: 0.9 });
		const sent = await sentBody();
		expect(sent.temperature).toBe(0.7);
		expect(sent.topP).toBeUndefined();
	});

	test('leaves topP alone when no temperature is set', async () => {
		await writeCredential(makeCredential());
		await performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x', topP: 0.9 });
		const sent = await sentBody();
		expect(sent.topP).toBe(0.9);
		expect(sent.temperature).toBeUndefined();
	});

	test('non-JSON bodies pass through untouched', async () => {
		await writeCredential(makeCredential());
		await performCodexFetch('not-json');
		// The request was still sent (and the backend would reject it) — the rewriter must not invent a body.
		expect(fetchCalls.length).toBe(1);
		expect(fetchCalls[0]!.init!.body).toBe('not-json');
	});
});

describe('CODEX_SMOKE_DEBUG fingerprint', () => {
	function captureWarns(): { warns: string[]; restore: () => void } {
		const warns: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message: string) => {
			warns.push(message);
		};
		return { warns, restore: () => (console.warn = originalWarn) };
	}

	test('prints the endpoint and discriminating headers when set', async () => {
		await writeCredential(makeCredential());
		mockFetch({ generation: () => new Response('{}', { status: 200, headers: { 'cf-ray': 'ray-123', 'x-openai-proxy-wasm': 'v0.1' } }) });
		const { warns, restore } = captureWarns();
		process.env.CODEX_SMOKE_DEBUG = '1';
		try {
			await performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x', stream: true });
		}
		finally {
			delete process.env.CODEX_SMOKE_DEBUG;
			restore();
		}
		expect(warns.length).toBe(1);
		expect(warns[0]).toContain('https://chatgpt.com/backend-api/codex/responses');
		expect(warns[0]).toContain('ray-123');
		expect(warns[0]).toContain('x-openai-proxy-wasm');
		// Values that must NOT appear when served by the codex backend.
		expect(warns[0]).not.toContain('openai-organization":"');
	});

	test('silent by default', async () => {
		delete process.env.CODEX_SMOKE_DEBUG;
		await writeCredential(makeCredential());
		const { warns, restore } = captureWarns();
		try {
			await performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x', stream: true });
		}
		finally {
			restore();
		}
		expect(warns.length).toBe(0);
	});
});

describe('credential path resolution', () => {
	test('resolves from ancestor directories when cwd is nested (mastra dev child cwd)', async () => {
		await writeCredential(makeCredential());
		// The dev server runs the built output with cwd at src/mastra/public,
		// deep inside the repo; the walk-up must find the repo-root credential.
		const nested = join(tempDir, 'src', 'mastra', 'public');
		await mkdir(nested, { recursive: true });
		process.chdir(nested);
		// realpath: macOS tmpdirs sit behind the /var -> /private/var symlink.
		expect(realpathSync(defaultCredentialPath())).toBe(realpathSync(join(tempDir, 'data', 'openai-codex-auth.json')));
		// And the gateway actually resolves auth from there.
		expect((await openAICodexGateway.resolveAuth())?.bearerToken).toBe('test-access-token');
	});

	test('falls back to cwd-relative when no ancestor has a credential', () => {
		expect(defaultCredentialPath()).toBe(join(process.cwd(), 'data', 'openai-codex-auth.json'));
	});

	test('uses the project root on first login from the nested Mastra dev cwd', async () => {
		await writeFile(join(tempDir, 'package.json'), '{}');
		const nested = join(tempDir, 'src', 'mastra', 'public');
		await mkdir(nested, { recursive: true });
		process.chdir(nested);

		expect(defaultCredentialPath()).toBe(join(realpathSync(tempDir), 'data', 'openai-codex-auth.json'));
	});
});

describe('codexFetch response translation (SDK non-streaming calls)', () => {
	const messageItem = (text: string) => ({
		type: 'message',
		status: 'completed',
		content: [{ type: 'output_text', annotations: [], logprobs: [], text }],
		phase: 'final_answer',
		role: 'assistant',
	});
	const sse = [
		'event: response.created',
		`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_smoke', status: 'in_progress' } })}`,
		'',
		'event: response.output_item.added',
		`data: ${JSON.stringify({ type: 'response.output_item.added', item: { ...messageItem(''), status: 'in_progress', content: [] }, output_index: 1 })}`,
		'',
		'event: response.output_text.delta',
		`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok', output_index: 1 })}`,
		'',
		'event: response.output_item.done',
		`data: ${JSON.stringify({ type: 'response.output_item.done', item: messageItem('second'), output_index: 1 })}`,
		'',
		'event: response.output_item.done',
		`data: ${JSON.stringify({ type: 'response.output_item.done', item: messageItem('first'), output_index: 0 })}`,
		'',
		'event: response.completed',
		`data: ${JSON.stringify({
			type: 'response.completed',
			response: {
				id: 'resp_smoke',
				status: 'completed',
				output: [], // The codex skeleton never carries items; the translator must assemble them.
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		})}`,
		'',
	].join('\n');
	const sseResponse = () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });

	test('assembles output items onto the completed skeleton, sorted by output_index', async () => {
		await writeCredential(makeCredential());
		mockFetch({ generation: sseResponse });
		const result = await performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x' });
		expect((await sentBody()).stream).toBe(true); // forced on the wire
		expect(result.ok).toBe(true);
		expect(result.headers.get('content-type')).toContain('application/json');
		const body = JSON.parse(await result.text()) as { output: Array<{ content: Array<{ text: string }> }>; usage: unknown };
		expect(body.output.map(item => item.content[0]!.text)).toEqual(['first', 'second']);
		expect(body.usage).toEqual({ input_tokens: 1, output_tokens: 1, total_tokens: 2 });
	});

	test('passes the streaming response through untouched', async () => {
		await writeCredential(makeCredential());
		mockFetch({ generation: sseResponse });
		const result = await performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x', stream: true });
		expect(result.headers.get('content-type')).toContain('text/event-stream');
		expect(await result.text()).toBe(sse);
	});

	test('fails loudly when the SSE session has no terminal event', async () => {
		await writeCredential(makeCredential());
		mockFetch({ generation: () => new Response('event: response.created\ndata: {}\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
		const result = await performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x' });
		expect(result.status).toBe(502);
	});
});

describe('refresh rotation through resolveAuth', () => {
	test('refreshes at earliestRefreshAt plus 60 seconds even when access expiry is far away', async () => {
		const old = makeCredential({
			access: 'old-access',
			refresh: 'old-refresh',
			expiresAt: Date.now() + 24 * 60 * 60 * 1000,
			earliestRefreshAt: Date.now() - 60_001,
		});
		await writeCredential(
			old,
		);
		mockFetch({
			tokenEndpoint: refreshedTokenResponse,
		});

		const auth = await openAICodexGateway.resolveAuth();

		expect(fetchCalls.filter(call => call.url.includes('/oauth/token')).length).toBe(1);
		expect(auth?.bearerToken).toBe('new-access');
		// The rotated pair is on disk before the new token is used.
		const persisted = await readCredential();
		expect(persisted.access).toBe('new-access');
		expect(persisted.refresh).toBe('new-refresh');

		// A caller that still holds the old pair observes the rotation instead of reusing it.
		expect((await refreshCredential(old)).refresh).toBe('new-refresh');
		expect(fetchCalls.filter(call => call.url.includes('/oauth/token')).length).toBe(1);
	});

	test('refuses to refresh before the server-declared window', async () => {
		const cred = makeCredential({
			expiresAt: Date.now() - 1,
			earliestRefreshAt: Date.now() + 60_000,
		});
		await writeCredential(cred);
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (message: string) => {
			errors.push(message);
		};
		try {
			const error = await captureError(() => refreshCredential(cred));
			expect(error.message).toBe(MODEL_AUTH_FAILURE);
			expect(errors.some(e => e.includes('detail=before_safe_window'))).toBe(true);
		}
		finally {
			console.error = originalError;
		}
		expect(fetchCalls.filter(call => call.url.includes('/oauth/token')).length).toBe(0);
	});

	test('falls back to expiresAt minus 60 seconds without a server refresh window', async () => {
		await writeCredential(makeCredential({ expiresAt: Date.now() + 30_000 }));
		mockFetch({ tokenEndpoint: refreshedTokenResponse });

		expect((await openAICodexGateway.resolveAuth())?.bearerToken).toBe('new-access');
		expect(fetchCalls.filter(call => call.url.includes('/oauth/token')).length).toBe(1);
	});

	test('a failed refresh fails loudly instead of falling back to another path', async () => {
		await writeCredential(
			makeCredential({
				expiresAt: Date.now() + 30_000,
				earliestRefreshAt: Date.now() - 60_000,
			}),
		);
		mockFetch({ tokenEndpoint: () => new Response('{"error":"refresh_token_invalidated"}', { status: 401 }) });
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (message: string) => {
			errors.push(message);
		};
		try {
			const error = await captureError(() => openAICodexGateway.resolveAuth());
			expect(error.message).toBe(MODEL_AUTH_FAILURE);
			expect(error.message).not.toContain('Re-login');
			expect(errors.some(e => e.includes('Re-login required'))).toBe(true);
		}
		finally {
			console.error = originalError;
		}
	});
});

describe('credential mutation serialization', () => {
	test('a refresh cannot overwrite a newer device-login credential', async () => {
		const old = makeCredential({
			access: 'old-access',
			refresh: 'old-refresh',
			earliestRefreshAt: Date.now() - 60_001,
		});
		await writeCredential(old);
		globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
			queueMicrotask(() => callback(...args));
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof globalThis.setTimeout;

		let refreshStarted!: () => void;
		let releaseRefresh!: () => void;
		const started = new Promise<void>(resolve => (refreshStarted = resolve));
		const released = new Promise<void>(resolve => (releaseRefresh = resolve));
		const idToken = `x.${btoa(JSON.stringify({ chatgpt_account_id: 'login-account' }))}.x`;
		mockFetch({
			deviceStart: (call) => {
				expect(call.init?.signal).toBeInstanceOf(AbortSignal);
				return Response.json({ device_auth_id: 'device-auth', user_code: 'ABCD-EFGH', interval: 1 });
			},
			devicePoll: (call) => {
				expect(call.init?.signal).toBeInstanceOf(AbortSignal);
				return Response.json({ authorization_code: 'authorization-code', code_verifier: 'code-verifier' });
			},
			tokenEndpoint: async (call) => {
				const grant = new URLSearchParams(call.init?.body as string).get('grant_type');
				if (grant === 'refresh_token') {
					expect(call.init?.signal).toBeInstanceOf(AbortSignal);
					refreshStarted();
					await released;
					return refreshedTokenResponse();
				}
				expect(call.init?.signal).toBeInstanceOf(AbortSignal);
				return Response.json({
					access_token: 'login-access',
					refresh_token: 'login-refresh',
					expires_in: 3600,
					id_token: idToken,
				});
			},
		});

		const refresh = refreshCredential(old);
		await started;
		const login = runDeviceLogin(async () => {});
		await Promise.resolve();
		expect(fetchCalls.some(call => call.url.includes('/deviceauth/usercode'))).toBe(false);

		releaseRefresh();
		await Promise.all([refresh, login]);
		expect(await readCredential()).toMatchObject({
			access: 'login-access',
			refresh: 'login-refresh',
			accountId: 'login-account',
		});
	});
});

describe('401 credential recovery', () => {
	function staleCredential(now: number): CodexCredential {
		return makeCredential({
			access: 'old-access',
			refresh: 'old-refresh',
			expiresAt: now + 24 * 60 * 60 * 1000,
			earliestRefreshAt: now - 59_999,
		});
	}

	test('refreshes after a generation 401 and retries exactly once', async () => {
		const now = originalDateNow();
		Date.now = () => now;
		await writeCredential(staleCredential(now));
		mockFetch({
			tokenEndpoint: refreshedTokenResponse,
			generation: (call) => {
				const authorization = new Headers(call.init?.headers).get('authorization');
				if (authorization === 'Bearer old-access') {
					Date.now = () => now + 1;
					return new Response('raw provider authorization failure', { status: 401 });
				}
				return new Response('ok', { status: 200 });
			},
		});

		const result = await performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x', stream: true });

		expect(result.status).toBe(200);
		expect(fetchCalls.filter(call => call.url.includes('/oauth/token')).length).toBe(1);
		expect(fetchCalls.filter(call => call.url.includes('/codex/responses')).length).toBe(2);
		expect((await sentHeaders()).get('authorization')).toBe('Bearer new-access');
	});

	test('uses a credential another request already rotated without refreshing again', async () => {
		const now = originalDateNow();
		Date.now = () => now;
		await writeCredential(staleCredential(now));
		mockFetch({
			generation: async (call) => {
				const authorization = new Headers(call.init?.headers).get('authorization');
				if (authorization === 'Bearer old-access') {
					await writeCredential(makeCredential({ access: 'rotated-access', refresh: 'rotated-refresh' }));
					return new Response('expired', { status: 401 });
				}
				return new Response('ok', { status: 200 });
			},
		});

		const result = await performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x', stream: true });

		expect(result.status).toBe(200);
		expect(fetchCalls.filter(call => call.url.includes('/oauth/token')).length).toBe(0);
		expect((await sentHeaders()).get('authorization')).toBe('Bearer rotated-access');
	});

	test('turns a second 401 into the model-auth sentinel without another refresh', async () => {
		const now = originalDateNow();
		Date.now = () => now;
		await writeCredential(staleCredential(now));
		mockFetch({
			tokenEndpoint: refreshedTokenResponse,
			generation: () => {
				Date.now = () => now + 1;
				return new Response('provider text must not escape', { status: 401 });
			},
		});

		const error = await captureError(() =>
			performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x', stream: true }),
		);

		expect(error.message).toBe(MODEL_AUTH_FAILURE);
		expect(fetchCalls.filter(call => call.url.includes('/oauth/token')).length).toBe(1);
		expect(fetchCalls.filter(call => call.url.includes('/codex/responses')).length).toBe(2);
	});

	test('sanitizes refresh failure logs and does not retry generation', async () => {
		const now = originalDateNow();
		Date.now = () => now;
		await writeCredential(staleCredential(now));
		mockFetch({
			tokenEndpoint: () => new Response(JSON.stringify({
				error: {
					code: 'refresh_token_invalidated',
					message: 'raw-provider-message test-access-token test-refresh-token test-account-id',
				},
			}), { status: 401 }),
			generation: () => {
				Date.now = () => now + 1;
				return new Response('raw generation failure', { status: 401 });
			},
		});
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (message: string) => errors.push(message);
		try {
			const error = await captureError(() =>
				performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x', stream: true }),
			);
			expect(error.message).toBe(MODEL_AUTH_FAILURE);
		}
		finally {
			console.error = originalError;
		}

		expect(fetchCalls.filter(call => call.url.includes('/oauth/token')).length).toBe(1);
		expect(fetchCalls.filter(call => call.url.includes('/codex/responses')).length).toBe(1);
		expect(errors.join('\n')).toContain('status=401 detail=refresh_token_invalidated');
		expect(errors.join('\n')).not.toMatch(/raw-provider-message|test-access-token|test-refresh-token|test-account-id/);
	});

	test('concurrent stale requests share one refresh and never reuse the rotated token', async () => {
		const now = originalDateNow();
		Date.now = () => now;
		await writeCredential(staleCredential(now));
		let staleCalls = 0;
		let releaseStale!: () => void;
		const bothStale = new Promise<void>((resolve) => {
			releaseStale = resolve;
		});
		mockFetch({
			tokenEndpoint: refreshedTokenResponse,
			generation: async (call) => {
				const authorization = new Headers(call.init?.headers).get('authorization');
				if (authorization === 'Bearer old-access') {
					staleCalls++;
					if (staleCalls === 2) {
						Date.now = () => now + 1;
						releaseStale();
					}
					await bothStale;
					return new Response('expired', { status: 401 });
				}
				return new Response('ok', { status: 200 });
			},
		});

		const results = await Promise.all([
			performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x', stream: true }),
			performCodexFetch({ model: 'gpt-5.6-terra', input: [], instructions: 'x', stream: true }),
		]);

		expect(results.map(result => result.status)).toEqual([200, 200]);
		const refreshCalls = fetchCalls.filter(call => call.url.includes('/oauth/token'));
		expect(refreshCalls.length).toBe(1);
		expect(new URLSearchParams(refreshCalls[0]!.init?.body as string).get('refresh_token')).toBe('old-refresh');
		expect(fetchCalls.filter(call => call.url.includes('/codex/responses')).length).toBe(4);
	});
});

describe('missing credential at fetch time', () => {
	test('codexFetch fails generically with no network call', async () => {
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (message: string) => {
			errors.push(message);
		};
		try {
			const error = await captureError(() => performCodexFetch({ model: 'gpt-5.6-terra', input: [] }));
			expect(error.message).toBe(MODEL_AUTH_FAILURE);
			expect(errors.some(e => e.includes('scripts/openai-codex-login.ts'))).toBe(true);
		}
		finally {
			console.error = originalError;
		}
		expect(fetchCalls.length).toBe(0);
	});

	test('model resolution itself still succeeds (failure is at generation, not startup)', async () => {
		const model = await openAICodexGateway.resolveLanguageModel({
			modelId: 'gpt-5.6-terra',
			providerId: 'openai-codex',
			apiKey: 'sentinel',
		});
		expect(model).toBeDefined();
	});
});

describe('store:false forcing on the resolved language model', () => {
	test('doGenerate and doStream serialize with providerOptions.openai.store false', async () => {
		const calls: Array<Record<string, unknown>> = [];
		const fake = {
			doGenerate: async (args: Record<string, unknown>) => {
				calls.push(args);
				return {} as never;
			},
			doStream: async (args: Record<string, unknown>) => {
				calls.push(args);
				return {} as never;
			},
		} as unknown as GatewayLanguageModel;
		const wrapped = forcingStoreFalse(fake);
		await wrapped.doGenerate?.({ prompt: [] } as never);
		await wrapped.doStream?.({ prompt: [], providerOptions: { openai: { store: true } } } as never);
		expect((calls[0]!.providerOptions as any).openai.store).toBe(false);
		expect((calls[1]!.providerOptions as any).openai.store).toBe(false);
	});

	test('resolveLanguageModel returns the wrapped provider model', async () => {
		await writeCredential(makeCredential());
		const model = await openAICodexGateway.resolveLanguageModel({ apiKey: '', modelId: 'gpt-5.6-terra', providerId: 'openai-codex' });
		expect(Object.hasOwn(model, 'doGenerate')).toBe(true);
		expect(Object.hasOwn(model, 'doStream')).toBe(true);
	});
});
