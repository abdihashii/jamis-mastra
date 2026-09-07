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
		try {
			// The adapter does not expose request options. Its SDK does, which lets this
			// non-idempotent POST use one aborting timeout and zero implicit retries.
			const posted = await sendblueAdapter.getSdk().groups.sendMessage({
				from_number: process.env.SENDBLUE_FROM_NUMBER ?? '',
				group_id: groupId,
				content: text,
			}, { timeout: SEND_TIMEOUT_MS, maxRetries: 0 });
			return posted.message_handle
				? { kind: 'sent', handle: posted.message_handle }
				: { kind: 'unknown', error: 'provider returned no message handle' };
		}
		catch (error) {
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
