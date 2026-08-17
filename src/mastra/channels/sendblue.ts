import type { Message } from 'chat';

import { createSendblueAdapter } from 'chat-adapter-sendblue';

import { requireEnv } from '../env';

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
