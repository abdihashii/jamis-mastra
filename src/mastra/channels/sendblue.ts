import type { Message, Thread } from 'chat';

import { createSendblueAdapter } from 'chat-adapter-sendblue';

import { requireEnv } from '../env';
import { DEVICE_LOGIN_TIMEOUT_ERROR, MODEL_AUTH_FAILURE, runDeviceLogin } from '../gateways/openai-codex-auth';

export const CODEX_AUTH_CHANNEL_ERROR = 'JAMIS lost access to ChatGPT and did not complete your request. Re-authentication is required.';
export const GENERIC_CHANNEL_ERROR = 'JAMIS could not complete that request. The error was logged.';
export const OPENAI_LOGIN_IN_PROGRESS = 'OpenAI login is already in progress.';
export const OPENAI_LOGIN_SUCCESS = 'OpenAI login complete.';
export const OPENAI_LOGIN_TIMEOUT = 'OpenAI login timed out. Send "login openai" to try again.';
export const OPENAI_LOGIN_FAILURE = 'OpenAI login failed. The error was logged.';

export function formatSendblueError(error: Error): string {
	return error.message.includes(MODEL_AUTH_FAILURE) ? CODEX_AUTH_CHANNEL_ERROR : GENERIC_CHANNEL_ERROR;
}

const operatorNumber = requireEnv('JAMIS_ALLOWED_NUMBER').trim();
const adapter = createSendblueAdapter({
	webhookSecret: requireEnv('SENDBLUE_WEBHOOK_SECRET'),
});

// Chat SDK dispatches direct messages through Adapter.isDM().
export const sendblueAdapter = Object.assign(adapter, {
	isDM: (threadId: string): boolean => !adapter.decodeThreadId(threadId).groupId,
});

export function isOperator(message: Message): boolean {
	return message.author.userId.trim() === operatorNumber;
}

export function isOpenAILoginCommand(message: Message): boolean {
	return message.text.trim().toLowerCase() === 'login openai';
}

/** ponytail: one process-wide login; use shared coordination only if JAMIS scales past one process. */
let openAILoginInFlight: Promise<void> | null = null;

export async function handleSendblueDirectMessage(
	thread: Thread,
	message: Message,
	defaultHandler: (thread: Thread, message: Message) => Promise<void>,
): Promise<void> {
	if (!isOperator(message))
		return;
	if (!isOpenAILoginCommand(message)) {
		await defaultHandler(thread, message);
		return;
	}
	if (openAILoginInFlight) {
		await thread.post(OPENAI_LOGIN_IN_PROGRESS);
		return;
	}

	let acknowledge!: () => void;
	const acknowledged = new Promise<void>(resolve => (acknowledge = resolve));
	openAILoginInFlight = runDeviceLogin(async ({ url, userCode }) => {
		await thread.post(`Open ${url} and enter code: ${userCode}`);
		acknowledge();
	}).then(async () => {
		try {
			await thread.post(OPENAI_LOGIN_SUCCESS);
		}
		catch {
			console.error('[openai-codex] Device login status=complete detail=notification_failed.');
		}
	}, async (error) => {
		const timedOut = error instanceof Error && error.message === DEVICE_LOGIN_TIMEOUT_ERROR;
		const status = timedOut ? 'timeout' : 'failed';
		console.error(`[openai-codex] Device login status=${status}.`);
		try {
			await thread.post(timedOut ? OPENAI_LOGIN_TIMEOUT : OPENAI_LOGIN_FAILURE);
		}
		catch {
			console.error(`[openai-codex] Device login status=${status} detail=notification_failed.`);
		}
	}).finally(() => {
		openAILoginInFlight = null;
		acknowledge();
	});
	await acknowledged;
}
