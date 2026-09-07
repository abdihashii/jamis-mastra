import { describe, expect, it, spyOn } from 'bun:test';
import process from 'node:process';

import { sendblueAdapter } from '../../mastra/channels/sendblue';
import { classifyError, sendblueSendClient } from '../deliver';

describe('sendblueSendClient', () => {
	it('makes one group request with an aborting timeout and SDK retries disabled', async () => {
		const previousFromNumber = process.env.SENDBLUE_FROM_NUMBER;
		process.env.SENDBLUE_FROM_NUMBER = '+15550001111';
		const sendMessage = spyOn(sendblueAdapter.getSdk().groups, 'sendMessage')
			.mockResolvedValue({ message_handle: 'sb-1' } as never);

		try {
			expect(await sendblueSendClient.sendToGroup('group-1', 'recap')).toEqual({ kind: 'sent', handle: 'sb-1' });
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(sendMessage).toHaveBeenCalledWith({
				from_number: '+15550001111',
				group_id: 'group-1',
				content: 'recap',
			}, { timeout: 15_000, maxRetries: 0 });
		}
		finally {
			sendMessage.mockRestore();
			if (previousFromNumber == null)
				delete process.env.SENDBLUE_FROM_NUMBER;
			else
				process.env.SENDBLUE_FROM_NUMBER = previousFromNumber;
		}
	});
});

describe('classifyError (ADR 0018 outcome classes)', () => {
	it('4xx proves the provider rejected the message: failed, auto-retryable', () => {
		expect(classifyError(Object.assign(new Error('bad request'), { status: 422 }))).toEqual({ kind: 'failed', error: 'sendblue HTTP 422' });
	});

	it('5xx proves nothing about acceptance: delivery_unknown, operator gate', () => {
		expect(classifyError(Object.assign(new Error('internal'), { status: 502 })).kind).toBe('unknown');
		expect(classifyError(Object.assign(new Error('internal'), { status: 500 })).kind).toBe('unknown');
	});

	it('timeouts and bare transport errors are unknown', () => {
		expect(classifyError(new Error('send timed out after 15000ms')).kind).toBe('unknown');
		expect(classifyError(new Error('fetch failed')).kind).toBe('unknown');
	});

	it('no error shape is too weird to classify safely', () => {
		expect(classifyError(null).kind).toBe('unknown');
		expect(classifyError('boom').kind).toBe('unknown');
	});
});
