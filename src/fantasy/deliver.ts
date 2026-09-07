import process from 'node:process';
import { sendblueAdapter } from '../mastra/channels/sendblue';

/** What one outbound attempt learned. `unknown` = the request's fate is unobservable to us. */
export type SendOutcome
	= | { kind: 'sent'; handle: string }
		| { kind: 'failed'; error: string }
		| { kind: 'unknown'; error: string };

/** Injectable seam for tests; production passes null and uses the channel adapter. */
export interface SendClient {
	sendToGroup: (groupId: string, text: string) => Promise<SendOutcome>;
	directMessage: (text: string) => Promise<void>;
}

const SEND_TIMEOUT_MS = 15_000;

export function classifyError(error: unknown): SendOutcome {
	// A 4xx proves the provider rejected the message; retrying is safe.
	// A 5xx says nothing about acceptance, and 5xx'd messages must not be
	// auto-resendable, so they join timeouts in the unknown class (ADR 0018).
	const status = (error as { status?: number; statusCode?: number } | null)?.status
		?? (error as { statusCode?: number } | null)?.statusCode;
	if (typeof status === 'number' && status >= 400 && status < 500) {
		return { kind: 'failed', error: `sendblue HTTP ${status}` };
	}
	// Timeouts and transport errors leave delivery genuinely unobservable.
	return { kind: 'unknown', error: error instanceof Error ? error.message.slice(0, 300) : 'send attempt failed without provider response' };
}

class SendblueSendClient implements SendClient {
	async sendToGroup(groupId: string, text: string): Promise<SendOutcome> {
		const threadId = sendblueAdapter.encodeThreadId({
			fromNumber: process.env.SENDBLUE_FROM_NUMBER ?? '',
			groupId,
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const posted = await Promise.race([
				sendblueAdapter.postMessage(threadId, text),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`send timed out after ${SEND_TIMEOUT_MS}ms`)), SEND_TIMEOUT_MS);
				}),
			]);
			clearTimeout(timer);
			return posted.id ? { kind: 'sent', handle: posted.id } : { kind: 'unknown', error: 'provider returned no message handle' };
		}
		catch (error) {
			clearTimeout(timer);
			return classifyError(error);
		}
	}

	async directMessage(text: string): Promise<void> {
		const threadId = sendblueAdapter.encodeThreadId({
			fromNumber: process.env.SENDBLUE_FROM_NUMBER ?? '',
			contactNumber: process.env.JAMIS_ALLOWED_NUMBER?.trim() ?? '',
		});
		await sendblueAdapter.postMessage(threadId, text);
	}
}

export const sendblueSendClient: SendClient = new SendblueSendClient();
