import { expect, spyOn, test } from 'bun:test';
import assert from 'node:assert/strict';
import { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/request-context';
import { noopObserve } from '@mastra/core/tools';

import { createConversationContextProcessor } from '../../processors/conversation-context';
import { conversationContextTool } from '../conversation-context';

const windows = {
	messages: { tokens: 123, threshold: 30000 },
	observations: { tokens: 456, threshold: 40000 },
};

async function report(requestContext?: RequestContext) {
	const result = await conversationContextTool.execute!({}, { requestContext, observe: noopObserve });
	assert(result && 'measurementPoint' in result, 'Expected validated context measurements.');
	return result;
}

function fixture() {
	const requestContext = new RequestContext();
	requestContext.setRaw('MastraMemory', { thread: { id: 'fixture-thread' } });
	requestContext.setRaw('privateContent', 'PRIVATE_CONTEXT_SENTINEL');
	const processor = createConversationContextProcessor();
	const state = {};
	return {
		requestContext,
		async measure(inputTokens: number | undefined, memoryWindows?: typeof windows, stepNumber = 0) {
			if (memoryWindows) {
				// Pinned ChunkType adds never-typed base fields to native data-* chunks.
				await processor.processOutputStream({
					requestContext,
					state,
					streamParts: [],
					retryCount: 0,
					abort: () => { throw new Error('Unexpected processor abort.'); },
					part: { type: 'data-om-status', data: {
						threadId: 'fixture-thread',
						stepNumber,
						windows: { active: memoryWindows },
						observations: 'PRIVATE_OBSERVATIONS_SENTINEL',
					} },
				} as unknown as Parameters<typeof processor.processOutputStream>[0]);
			}
			processor.processLLMRequest({
				requestContext,
				state,
				stepNumber,
				model: { provider: 'fixture-provider', modelId: 'fixture-model' },
			} as Parameters<typeof processor.processLLMRequest>[0]);
			processor.processOutputStep({
				requestContext,
				state,
				stepNumber,
				usage: { inputTokens, outputTokens: 99, totalTokens: 9999 },
			} as Parameters<typeof processor.processOutputStep>[0]);
			return report(requestContext);
		},
		finish() {
			processor.processOutputResult({ requestContext } as Parameters<typeof processor.processOutputResult>[0]);
		},
	};
}

test('missing or invalid provider usage does not hide available OM', async () => {
	for (const inputTokens of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		const result = await fixture().measure(inputTokens, windows);
		expect(result.modelContext).toEqual({
			status: 'unavailable',
			provider: 'fixture-provider',
			modelId: 'fixture-model',
			stepNumber: 0,
			inputTokens: null,
			capacityTokens: null,
			usagePercent: null,
			inputHeadroomTokens: null,
		});
		expect(result.observationalMemory).toMatchObject({ status: 'available', ...windows });
	}
});

test('missing or invalid OM does not hide available model usage', async () => {
	for (const memoryWindows of [undefined, { ...windows, messages: { tokens: -1, threshold: 0 } }]) {
		const result = await fixture().measure(222, memoryWindows);
		expect(result.modelContext).toMatchObject({ status: 'available', inputTokens: 222 });
		expect(result.observationalMemory).toEqual({
			status: 'unavailable',
			messages: null,
			observations: null,
			thresholdMeaning: 'compaction',
			countsMayBeEstimated: true,
		});
	}
});

test('zero remains available, capacity stays unknown, and content never appears', async () => {
	const result = await fixture().measure(0, {
		messages: { tokens: 0, threshold: 30000 },
		observations: { tokens: 0, threshold: 40000 },
	});
	expect(result.modelContext).toMatchObject({
		status: 'available',
		inputTokens: 0,
		capacityTokens: null,
		usagePercent: null,
		inputHeadroomTokens: null,
	});
	expect(result.observationalMemory).toMatchObject({
		status: 'available',
		messages: { tokens: 0, threshold: 30000 },
		observations: { tokens: 0, threshold: 40000 },
	});
	expect(JSON.stringify(result)).not.toContain('PRIVATE_');
});

test('absent, empty and finalized request contexts explicitly report both measurements unavailable', async () => {
	const captured = fixture();
	await captured.measure(222, windows);
	captured.finish();
	for (const context of [undefined, new RequestContext(), captured.requestContext]) {
		const result = await report(context);
		expect(result.modelContext).toEqual({
			status: 'unavailable',
			provider: null,
			modelId: null,
			stepNumber: null,
			inputTokens: null,
			capacityTokens: null,
			usagePercent: null,
			inputHeadroomTokens: null,
		});
		expect(result.observationalMemory).toMatchObject({ status: 'unavailable', messages: null, observations: null });
	}
	const missing = await fixture().measure(undefined);
	expect(missing.modelContext.status).toBe('unavailable');
	expect(missing.observationalMemory.status).toBe('unavailable');
});

test('multiple calls report the latest input, not cumulative/output usage or stale OM', async () => {
	const captured = fixture();
	await captured.measure(111, windows);
	const result = await captured.measure(222, undefined, 1);
	expect(result.modelContext).toMatchObject({ stepNumber: 1, inputTokens: 222 });
	expect(result.observationalMemory.status).toBe('unavailable');
});

test('concurrent sessions and nested measurements cannot overwrite tool output', async () => {
	const outer = fixture();
	const other = fixture();
	const results = await Promise.all([outer.measure(100), other.measure(200)]);
	expect(results.map(result => result.modelContext.inputTokens)).toEqual([100, 200]);
	await fixture().measure(900);
	expect((await report(outer.requestContext)).modelContext.inputTokens).toBe(100);
	expect((await report(other.requestContext)).modelContext.inputTokens).toBe(200);
});

test('actual tool execution rejects caller-selected threads and sessions', async () => {
	for (const input of [{ threadId: 'another-thread' }, { sessionId: 'another-session' }]) {
		// @ts-expect-error Exercise runtime rejection of untrusted tool arguments.
		const result = await conversationContextTool.execute!(input, { observe: noopObserve });
		expect(result).toMatchObject({ error: true, message: expect.stringContaining('Tool input validation failed') });
	}
});

test('the read-only tool adds no storage access', async () => {
	const mastra = new Mastra({ logger: false });
	const storage = spyOn(mastra, 'getStorage');
	try {
		const captured = fixture();
		await captured.measure(222, windows);
		await conversationContextTool.execute!({}, {
			mastra,
			requestContext: captured.requestContext,
			observe: noopObserve,
		});
		expect(storage).not.toHaveBeenCalled();
	} finally {
		storage.mockRestore();
	}
});
