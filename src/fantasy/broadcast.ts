import type { FantasyConfig } from './config';

import type { SendOutcome } from './deliver';
import type { SqlLike } from './recaps';

import { randomBytes } from 'node:crypto';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { getFantasyConfig } from './config';
import { getFantasySql } from './recaps';

export async function ensureFantasyBroadcastsTable(sql: SqlLike = getFantasySql()): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS fantasy_broadcasts (
			id TEXT PRIMARY KEY,
			draft_text TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft',
			message_handle TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`;
}

const draftOutputSchema = z.object({
	ok: z.boolean(),
	draftId: z.string().optional(),
	text: z.string().optional(),
	error: z.string().optional(),
});

const sendOutputSchema = z.object({
	ok: z.boolean(),
	outcome: z.enum(['sent', 'unknown', 'failed', 'blocked']).optional(),
	handle: z.string().optional(),
	error: z.string().optional(),
});

/**
 * Operator-approved one-off broadcasts into the fantasy group. The draft id pins
 * the exact text, so approve-then-send never re-generates. Sending a draft is
 * claimed atomically (one UPDATE ... WHERE status='draft' RETURNING): duplicate
 * operator confirmations and parallel callers cannot each reach the wire.
 */
export function createBroadcastTools(config: FantasyConfig | null, sql: SqlLike = getFantasySql()) {
	const draftGroupMessage = createTool({
		id: 'draft_group_message',
		description: 'Draft a message to send to the fantasy league group chat. NEVER sends; returns a draft id and the exact text for operator review.',
		inputSchema: z.object({
			// Plain-language instruction, like "introduce the recap bot in its deadpan voice".
			note: z.string().min(1).max(2000),
			// The exact candidate text composed by the agent; stored verbatim so send_by_id reproduces the bytes exactly.
			text: z.string().min(1).max(2000),
		}),
		outputSchema: draftOutputSchema,
		execute: async (inputData): Promise<z.infer<typeof draftOutputSchema>> => {
			if (!config)
				return { ok: false, error: 'fantasy feature is not configured' };
			await ensureFantasyBroadcastsTable(sql);
			// 8 hex chars; one collision retry keeps a unique-violation off the wire.
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const id = randomBytes(4).toString('hex');
				const rows = await sql`INSERT INTO fantasy_broadcasts (id, draft_text) VALUES (${id}, ${inputData.text})
					ON CONFLICT (id) DO NOTHING RETURNING id`;
				if ((rows as unknown[]).length === 1)
					return { ok: true, draftId: id, text: inputData.text };
			}
			return { ok: false, error: 'could not allocate a draft id; retry' };
		},
	});

	const sendGroupMessage = createTool({
		id: 'send_group_message',
		description: 'Send a previously drafted message (by draft id) to the fantasy league group chat, byte-identical to the reviewed draft. Call only after the operator explicitly confirms the exact draft.',
		inputSchema: z.object({ draftId: z.string().min(6).max(32) }),
		outputSchema: sendOutputSchema,
		execute: async (inputData): Promise<z.infer<typeof sendOutputSchema>> => {
			if (!config)
				return { ok: false, outcome: 'blocked', error: 'fantasy feature is not configured' };
			await ensureFantasyBroadcastsTable(sql);
			const rows = (await sql`
				UPDATE fantasy_broadcasts SET status = 'sending', updated_at = now()
				WHERE id = ${inputData.draftId} AND status = 'draft'
				RETURNING draft_text, status
			`) as { draft_text: string; status: string }[];
			const row = rows[0];
			if (!row) {
				const existing = (await sql`SELECT status FROM fantasy_broadcasts WHERE id = ${inputData.draftId}`) as { status: string }[];
				if (!existing[0])
					return { ok: false, outcome: 'blocked', error: `no draft with id ${inputData.draftId}` };
				return {
					ok: false,
					outcome: 'blocked',
					error: `draft ${inputData.draftId} is '${existing[0].status}' and cannot send (only drafts can)`,
				};
			}

			let outcome: SendOutcome;
			try {
				const { sendblueSendClient } = await import('./deliver');
				outcome = await sendblueSendClient.sendToGroup(config.sendblueGroupId, row.draft_text);
			}
			catch (error) {
				await sql`UPDATE fantasy_broadcasts SET status = 'draft', updated_at = now() WHERE id = ${inputData.draftId}`;
				return { ok: false, outcome: 'blocked', error: (error as Error)?.message?.slice(0, 200) ?? 'send client unavailable' };
			}
			// One way or another, never re-attempt the same draft after it was once attempted (duplicates on unknown).
			await sql`
				UPDATE fantasy_broadcasts SET status = ${outcome.kind === 'sent' ? 'sent' : 'send_attempted'},
				message_handle = ${outcome.kind === 'sent' ? outcome.handle : null}, updated_at = now()
				WHERE id = ${inputData.draftId}
			`;
			if (outcome.kind === 'sent')
				return { ok: true, outcome: 'sent', handle: outcome.handle };
			return { ok: false, outcome: outcome.kind, error: outcome.error };
		},
	});

	return { draftGroupMessage, sendGroupMessage };
}

/** Production singleton used by the broadcast agent. */
export const broadcastTools = createBroadcastTools(getFantasyConfig());
