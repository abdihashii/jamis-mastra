import type { Mastra } from '@mastra/core';
import type { ChannelHandlerContext } from '@mastra/core/channels';
import type { Message, Thread } from 'chat';

import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { SqlLike } from '../../../lib/operator-time-zone';

import { handleSendblueDirectMessage, LINEAR_PROPOSAL_FAILURE, linearProposalModelOutput } from '../../channels/sendblue';
import { createJamisAgent } from '../jamis';
import { insufficientResearchReason } from '../research-handback';
import { boundaryModel } from './specialist-boundary.fixture';

export async function runJamisAmbientAuthorityFixture(mastra: Mastra, sql: SqlLike) {
	const replies: unknown[] = [];
	let messageSequence = 0;
	const thread = {
		id: `sendblue:${randomUUID()}`,
		channelId: 'fixture',
		isDM: true,
		adapter: { name: 'sendblue' },
		post: async (text: unknown) => {
			replies.push(text);
			return { id: randomUUID() };
		},
	} as unknown as Thread;
	const message = (text: string) => ({
		id: randomUUID(),
		threadId: thread.id,
		text,
		author: { userId: process.env.JAMIS_ALLOWED_NUMBER },
		metadata: { dateSent: new Date(Date.UTC(2030, 0, 1, 0, 0, messageSequence++)) },
	}) as unknown as Message;
	const context = (): ChannelHandlerContext => ({ mastra, requestContext: new RequestContext(), signalMetadata: {} });
	await handleSendblueDirectMessage(thread, message('Baseline private turn.'), async (replyThread) => {
		linearProposalModelOutput({ status: 'denied' });
		await replyThread.post('This untrusted proposal-status text must be suppressed.');
	}, context(), sql);
	assert.deepEqual(replies, [LINEAR_PROPOSAL_FAILURE], 'The channel baseline must enter the real private proposal turn.');
	replies.length = 0;
	let researchProbes = 0;
	const jamis = createJamisAgent({
		mastra,
		memory: undefined,
		workspace: undefined,
		channels: undefined,
		tools: {},
		model: boundaryModel([{ tool: 'invoke_research', input: { kind: 'operator_request' } }, { text: 'I could not verify the requested factual answer.' }]),
		specialists: { research: {
			model: boundaryModel([{ tool: 'probe_context', input: {} }, { handback: { case: 'blocked', reason: insufficientResearchReason, progress: null } }]),
			tools: { probe_context: createTool({
				id: 'probe_context',
				description: 'Check isolated fixture execution.',
				inputSchema: z.object({}).strict(),
				outputSchema: z.object({ checked: z.boolean() }),
				execute: async () => {
					researchProbes += 1;
					linearProposalModelOutput({ status: 'denied' });
					return { checked: true };
				},
			}) },
		} },
	});
	const request = context();
	await handleSendblueDirectMessage(thread, message('Research this public fixture question.'), async (replyThread, input) => {
		const response = await jamis.generate(input.text, { requestContext: request.requestContext });
		await replyThread.post(response.text);
	}, request, sql);
	assert.equal(researchProbes, 1);
	assert.deepEqual(replies, ['I could not verify the requested factual answer.'], 'Research must not mutate the ambient Linear proposal turn.');
}
