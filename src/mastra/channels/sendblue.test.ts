import type { Message, Thread } from 'chat';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MODEL_AUTH_FAILURE } from '../gateways/openai-codex-auth.js';

process.env.JAMIS_ALLOWED_NUMBER = '+15555550101';
process.env.SENDBLUE_API_KEY = 'test-api-key';
process.env.SENDBLUE_API_SECRET = 'test-api-secret';
process.env.SENDBLUE_FROM_NUMBER = '+15555550100';
process.env.SENDBLUE_WEBHOOK_SECRET = 'test-webhook-secret';

const {
	CODEX_AUTH_CHANNEL_ERROR,
	formatSendblueError,
	GENERIC_CHANNEL_ERROR,
	handleSendblueDirectMessage,
	isOpenAILoginCommand,
	OPENAI_LOGIN_FAILURE,
	OPENAI_LOGIN_IN_PROGRESS,
	OPENAI_LOGIN_SUCCESS,
	OPENAI_LOGIN_TIMEOUT,
} = await import('./sendblue.js');

const operatorNumber = process.env.JAMIS_ALLOWED_NUMBER!;

function makeMessage(text: string, userId: string = operatorNumber): Message {
	return { text, author: { userId } } as Message;
}

function makeThread(messages: string[], onPost?: (message: string) => Promise<void>): Thread {
	return {
		post: async (message: string) => {
			messages.push(message);
			await onPost?.(message);
			return {};
		},
	} as unknown as Thread;
}

describe('Sendblue error formatting', () => {
	test('renders the model-auth sentinel as an actionable message', () => {
		const error = new Error(`wrapped: ${MODEL_AUTH_FAILURE} raw-provider-text test-access-token test-refresh-token`);

		expect(formatSendblueError(error)).toBe(CODEX_AUTH_CHANNEL_ERROR);
		expect(formatSendblueError(error)).not.toMatch(/raw-provider-text|access-token|refresh-token/);
	});

	test('hides every other error', () => {
		expect(formatSendblueError(new Error('provider response contained a credential'))).toBe(GENERIC_CHANNEL_ERROR);
	});
});

describe('OpenAI login command routing', () => {
	test('normalizes outer whitespace and case but rejects near matches', () => {
		for (const text of ['login openai', ' LOGIN OPENAI\n', '\tLogin OpenAI '])
			expect(isOpenAILoginCommand(makeMessage(text))).toBe(true);
		for (const text of ['login  openai', 'login openai now', 'please login openai', 'login openai!'])
			expect(isOpenAILoginCommand(makeMessage(text))).toBe(false);
	});

	test('ignores non-operators before command handling', async () => {
		const messages: string[] = [];
		let defaultCalls = 0;
		await handleSendblueDirectMessage(
			makeThread(messages),
			makeMessage('login openai', '+15555550999'),
			async () => { defaultCalls++; },
		);

		expect(messages).toEqual([]);
		expect(defaultCalls).toBe(0);
	});

	test('routes every other operator message through the model', async () => {
		const messages: string[] = [];
		let defaultCalls = 0;
		await handleSendblueDirectMessage(
			makeThread(messages),
			makeMessage('login openai now'),
			async () => { defaultCalls++; },
		);

		expect(messages).toEqual([]);
		expect(defaultCalls).toBe(1);
	});
});

describe('OpenAI login flow', () => {
	let tempDir: string;
	let originalCwd: string;
	let originalFetch: typeof globalThis.fetch;
	let originalDateNow: typeof Date.now;
	let originalSetTimeout: typeof globalThis.setTimeout;
	let originalConsoleError: typeof console.error;
	let fetchCalls: string[];
	let errors: string[];

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'sendblue-login-'));
		originalCwd = process.cwd();
		originalFetch = globalThis.fetch;
		originalDateNow = Date.now;
		originalSetTimeout = globalThis.setTimeout;
		originalConsoleError = console.error;
		fetchCalls = [];
		errors = [];
		process.chdir(tempDir);
		console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
	});

	afterEach(async () => {
		console.error = originalConsoleError;
		globalThis.fetch = originalFetch;
		Date.now = originalDateNow;
		globalThis.setTimeout = originalSetTimeout;
		process.chdir(originalCwd);
		await rm(tempDir, { recursive: true, force: true });
	});

	function mockFetch(handler: (url: string) => Response | Promise<Response>): void {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			fetchCalls.push(url);
			return handler(url);
		}) as typeof globalThis.fetch;
	}

	function runTimersImmediately(onTimer?: () => void): void {
		globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
			queueMicrotask(() => {
				onTimer?.();
				callback(...args);
			});
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof globalThis.setTimeout;
	}

	function holdTimers(): () => void {
		let release!: () => void;
		const released = new Promise<void>(resolve => (release = resolve));
		globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
			void released.then(() => callback(...args));
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof globalThis.setTimeout;
		return release;
	}

	function mockSuccessfulDeviceFlow(): void {
		const idToken = `x.${Buffer.from(JSON.stringify({ chatgpt_account_id: 'test-account-secret' })).toString('base64url')}.x`;
		mockFetch((url) => {
			if (url.includes('/deviceauth/usercode'))
				return Response.json({ device_auth_id: 'test-device-auth-secret', user_code: 'ABCD-EFGH', interval: 1 });
			if (url.includes('/deviceauth/token'))
				return Response.json({ authorization_code: 'test-authorization-code-secret', code_verifier: 'test-code-verifier-secret' });
			if (url.includes('/oauth/token')) {
				return Response.json({
					access_token: 'test-access-secret',
					refresh_token: 'test-refresh-secret',
					expires_in: 3600,
					id_token: idToken,
				});
			}
			throw new Error(`unexpected URL: ${url}`);
		});
	}

	test('posts URL/code before polling, suppresses duplicates, and saves only the completed credential', async () => {
		const releasePolling = holdTimers();
		mockSuccessfulDeviceFlow();

		let urlPostStarted!: () => void;
		let releaseUrlPost!: () => void;
		let loginCompleted!: () => void;
		const postStarted = new Promise<void>(resolve => (urlPostStarted = resolve));
		const postReleased = new Promise<void>(resolve => (releaseUrlPost = resolve));
		const completed = new Promise<void>(resolve => (loginCompleted = resolve));
		const messages: string[] = [];
		const thread = makeThread(messages, async (message) => {
			if (message.startsWith('Open ')) {
				urlPostStarted();
				await postReleased;
			}
			if (message === OPENAI_LOGIN_SUCCESS)
				loginCompleted();
		});
		let defaultCalls = 0;
		const defaultHandler = async () => {
			defaultCalls++;
		};

		const login = handleSendblueDirectMessage(thread, makeMessage('login openai'), defaultHandler);
		await postStarted;
		expect(fetchCalls.filter(url => url.includes('/deviceauth/usercode')).length).toBe(1);
		expect(fetchCalls.some(url => url.includes('/deviceauth/token'))).toBe(false);

		releaseUrlPost();
		await login;
		expect(fetchCalls.some(url => url.includes('/deviceauth/token'))).toBe(false);

		await handleSendblueDirectMessage(thread, makeMessage('LOGIN OPENAI'), defaultHandler);
		expect(messages[1]).toBe(OPENAI_LOGIN_IN_PROGRESS);
		expect(fetchCalls.filter(url => url.includes('/deviceauth/usercode')).length).toBe(1);

		releasePolling();
		await completed;
		expect(messages).toEqual([
			'Open https://auth.openai.com/codex/device and enter code: ABCD-EFGH',
			OPENAI_LOGIN_IN_PROGRESS,
			OPENAI_LOGIN_SUCCESS,
		]);
		expect(defaultCalls).toBe(0);
		expect(fetchCalls.map(url => new URL(url).pathname)).toEqual([
			'/api/accounts/deviceauth/usercode',
			'/api/accounts/deviceauth/token',
			'/oauth/token',
		]);

		const credentialPath = join(tempDir, 'data', 'openai-codex-auth.json');
		const persisted = JSON.parse(await Bun.file(credentialPath).text());
		expect(persisted).toMatchObject({
			access: 'test-access-secret',
			refresh: 'test-refresh-secret',
			accountId: 'test-account-secret',
		});
		expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
		expect([...messages, ...errors].join('\n')).not.toMatch(
			/test-access-secret|test-refresh-secret|test-account-secret|test-device-auth-secret|test-authorization-code-secret|test-code-verifier-secret/,
		);
	});

	test('reports timeout without polling or persisting partial state', async () => {
		let now = 0;
		Date.now = () => now;
		runTimersImmediately(() => (now = 15 * 60 * 1000));
		mockFetch((url) => {
			if (url.includes('/deviceauth/usercode'))
				return Response.json({ device_auth_id: 'test-device-auth-secret', user_code: 'ABCD-EFGH', interval: 1 });
			throw new Error(`unexpected URL: ${url}`);
		});
		const messages: string[] = [];
		let timeoutReported!: () => void;
		const reported = new Promise<void>(resolve => (timeoutReported = resolve));
		const thread = makeThread(messages, async (message) => {
			if (message === OPENAI_LOGIN_TIMEOUT)
				timeoutReported();
		});

		await handleSendblueDirectMessage(thread, makeMessage('login openai'), async () => {});
		await reported;

		expect(messages).toEqual([
			'Open https://auth.openai.com/codex/device and enter code: ABCD-EFGH',
			OPENAI_LOGIN_TIMEOUT,
		]);
		expect(fetchCalls.length).toBe(1);
		expect(errors).toEqual(['[openai-codex] Device login status=timeout.']);
		expect(await Bun.file(join(tempDir, 'data', 'openai-codex-auth.json')).exists()).toBe(false);
	});

	test('redacts provider failure details from messages and logs', async () => {
		runTimersImmediately();
		mockFetch((url) => {
			if (url.includes('/deviceauth/usercode'))
				return Response.json({ device_auth_id: 'test-device-auth-secret', user_code: 'ABCD-EFGH', interval: 1 });
			if (url.includes('/deviceauth/token'))
				return new Response('raw-provider-response upstream timed out test-access-secret test-refresh-secret test-account-secret', { status: 500 });
			throw new Error(`unexpected URL: ${url}`);
		});
		const messages: string[] = [];
		let failureReported!: () => void;
		const reported = new Promise<void>(resolve => (failureReported = resolve));
		const thread = makeThread(messages, async (message) => {
			if (message === OPENAI_LOGIN_FAILURE)
				failureReported();
		});

		await handleSendblueDirectMessage(thread, makeMessage('login openai'), async () => {});
		await reported;

		expect(messages).toEqual([
			'Open https://auth.openai.com/codex/device and enter code: ABCD-EFGH',
			OPENAI_LOGIN_FAILURE,
		]);
		expect(errors).toEqual(['[openai-codex] Device login status=failed.']);
		expect([...messages, ...errors].join('\n')).not.toMatch(/raw-provider-response|test-access-secret|test-refresh-secret|test-account-secret/);
		expect(await Bun.file(join(tempDir, 'data', 'openai-codex-auth.json')).exists()).toBe(false);
	});

	test('does not report auth failure when only the success notification fails', async () => {
		runTimersImmediately();
		mockSuccessfulDeviceFlow();
		let notificationLogged!: () => void;
		const logged = new Promise<void>(resolve => (notificationLogged = resolve));
		console.error = (...args: unknown[]) => {
			const message = args.map(String).join(' ');
			errors.push(message);
			if (message.includes('notification_failed'))
				notificationLogged();
		};
		const messages: string[] = [];
		const thread = makeThread(messages, async (message) => {
			if (message === OPENAI_LOGIN_SUCCESS)
				throw new Error('raw Sendblue failure');
		});

		await handleSendblueDirectMessage(thread, makeMessage('login openai'), async () => {});
		await logged;

		expect(messages).not.toContain(OPENAI_LOGIN_FAILURE);
		expect(errors.at(-1)).toBe('[openai-codex] Device login status=complete detail=notification_failed.');
	});
});
