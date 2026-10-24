import { Mastra } from '@mastra/core';
import { createTool } from '@mastra/core/tools';
import { expect, test } from 'bun:test';
import { z } from 'zod';

import { FANTASY_BROADCAST_MODEL, SAVED_REPORT_DELIVERY_TOOL_ID } from '../../../lib/fantasy/broadcast-policy';
import { StorageFreeRuntime } from '../../storage-free-runtime';
import { broadcasterResultSchema, createBroadcaster } from '../broadcaster';

function fixture() {
	const parent = new Mastra({ logger: false });
	const runtime = new StorageFreeRuntime(parent);
	const tool = createTool({ id: SAVED_REPORT_DELIVERY_TOOL_ID, description: 'Inert profile fixture.', inputSchema: z.object({}).strict(), execute: async () => ({}) });
	return { parent, runtime, tool, agent: createBroadcaster({ mastra: runtime, deliveryTool: tool }) };
}

test('Broadcaster pins Luna/max and offers only its bound delivery tool without roots, memory or channels', async () => {
	const { parent, runtime, tool, agent } = fixture();
	expect(agent.id).toBe('broadcaster');
	expect(agent.model).toBe(FANTASY_BROADCAST_MODEL);
	expect(agent.model).toBe('openai-codex/gpt-6-luna');
	expect(await agent.listTools()).toEqual({ deliver_saved_report: tool });
	expect(agent.getChannels()).toBeNull();
	expect(await agent.getMemory()).toBeUndefined();
	expect(Object.keys(parent.listAgents())).toEqual([]);
	expect(Object.keys(runtime.listAgents())).toEqual([]);
	expect(Object.keys(runtime.listWorkflows())).toEqual([]);
	expect(runtime.getStorage()).toBeUndefined();
	expect(runtime.observability).toBe(parent.observability);
	const options = await agent.getDefaultOptions();
	expect(options).toMatchObject({
		maxSteps: 2,
		toolCallConcurrency: 1,
		modelSettings: { maxRetries: 0, timeout: { totalMs: 120_000, stepMs: 120_000 } },
		providerOptions: { openai: { reasoningEffort: 'max', parallelToolCalls: false } },
		tracingOptions: { hideInput: true, hideOutput: true },
	});
	const prepare = options.prepareStep!;
	expect(await prepare({ stepNumber: 0 } as Parameters<typeof prepare>[0])).toEqual({ activeTools: [SAVED_REPORT_DELIVERY_TOOL_ID], toolChoice: 'required' });
	expect(await prepare({ stepNumber: 1 } as Parameters<typeof prepare>[0])).toEqual({ activeTools: [], toolChoice: 'none' });
	expect(await prepare({ stepNumber: 2 } as Parameters<typeof prepare>[0])).toEqual({ activeTools: [], toolChoice: 'none' });
	const instructions = await agent.getInstructions();
	expect(instructions).toContain('not a writer or publication authority');
	expect(instructions).toContain('provider acceptance proves handset receipt');
});

test('model contribution cannot grow into arbitrary message content or target selection', () => {
	const valid = { reportId: `report-${'a'.repeat(64)}`, status: 'sent' as const };
	expect(broadcasterResultSchema.parse(valid)).toEqual(valid);
	for (const extra of [{ text: 'Unreviewed prose' }, { groupId: 'different' }, { claimToken: 'untrusted' }, { approved: true }])
		expect(broadcasterResultSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
});
