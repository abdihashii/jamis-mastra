import { describe, expect, it } from 'bun:test';

import { classifyError } from '../deliver';

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
