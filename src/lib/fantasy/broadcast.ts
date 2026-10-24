import type { SqlLike } from '../operator-time-zone';
import type { FantasyConfig } from './config';
import type { SendOutcome } from './deliver';

import { createHash, randomUUID } from 'node:crypto';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { isImmediatelyFollowingLinearMessage, isLatestLinearMessage } from '../linear/linear-proposals';
import { getFantasyConfig } from './config';
import { getFantasySql } from './recaps';

const ready = new WeakMap<SqlLike, Promise<void>>();

export async function ensureFantasyBroadcastsTable(sql: SqlLike = getFantasySql()): Promise<void> {
	let pending = ready.get(sql);
	if (!pending) {
		pending = initializeBroadcasts(sql);
		ready.set(sql, pending);
		pending.catch(() => ready.delete(sql));
	}
	await pending;
}

async function initializeBroadcasts(sql: SqlLike): Promise<void> {
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
	await sql`ALTER TABLE fantasy_broadcasts ADD COLUMN IF NOT EXISTS draft_digest TEXT`;
	await sql`ALTER TABLE fantasy_broadcasts ADD COLUMN IF NOT EXISTS dm_id TEXT`;
	await sql`ALTER TABLE fantasy_broadcasts ADD COLUMN IF NOT EXISTS session_id TEXT`;
	await sql`ALTER TABLE fantasy_broadcasts ADD COLUMN IF NOT EXISTS source_message_id TEXT`;
	await sql`ALTER TABLE fantasy_broadcasts ADD COLUMN IF NOT EXISTS group_id TEXT`;
	await sql`ALTER TABLE fantasy_broadcasts ADD COLUMN IF NOT EXISTS publication_ready BOOLEAN NOT NULL DEFAULT FALSE`;
	await sql`ALTER TABLE fantasy_broadcasts ADD COLUMN IF NOT EXISTS decision JSONB`;
	await sql`ALTER TABLE fantasy_broadcasts ADD COLUMN IF NOT EXISTS outcome JSONB`;
	await sql`ALTER TABLE fantasy_broadcasts ADD COLUMN IF NOT EXISTS notified BOOLEAN NOT NULL DEFAULT FALSE`;
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS fantasy_broadcast_pending_dm ON fantasy_broadcasts (dm_id) WHERE status IN ('reviewing', 'pending', 'sending')`;
}

export interface BroadcastRecord {
	id: string;
	draft_text: string;
	status: string;
	dm_id: string;
	session_id: string;
	source_message_id: string;
	group_id: string;
	publication_ready: boolean;
	decision: { messageId: string; disposition: 'confirmed' | 'declined' | 'canceled' } | null;
	outcome: SendOutcome | null;
	notified: boolean;
}

export async function readPendingBroadcast(
	dmId: string,
	sql: SqlLike = getFantasySql(),
): Promise<BroadcastRecord | null> {
	await ensureFantasyBroadcastsTable(sql);
	const rows = await sql`
	SELECT
		*
	FROM
		fantasy_broadcasts
	WHERE
		dm_id = ${dmId}
		AND (
			status IN ('reviewing', 'pending', 'sending')
			OR (
				status IN ('sent', 'send_attempted')
				AND NOT notified
			)
		)
	ORDER BY
		created_at
	LIMIT
		1
` as BroadcastRecord[];
	return rows[0] ?? null;
}

export async function cancelBroadcast(dmId: string, messageId: string, sql: SqlLike = getFantasySql(), disposition: 'canceled' | 'declined' = 'canceled'): Promise<void> {
	await ensureFantasyBroadcastsTable(sql);
	await sql`
	UPDATE fantasy_broadcasts
	SET
		status = 'canceled',
		notified = TRUE,
		decision = ${{ messageId, disposition }}::jsonb,
		updated_at = now()
	WHERE
		dm_id = ${dmId}
		AND status IN ('reviewing', 'pending')
`;
}

export async function notifyBroadcast(
	row: BroadcastRecord,
	post: (text: string) => Promise<unknown>,
	sql: SqlLike = getFantasySql(),
): Promise<void> {
	// A recovered claim may already have reached Sendblue. Never replay it.
	if (row.status === 'sending') {
		await sql`
	UPDATE fantasy_broadcasts
	SET
		status = 'send_attempted',
		outcome = ${{ kind: 'unknown', error: 'Send outcome unavailable.' }}::jsonb
	WHERE
		id = ${row.id}
		AND status = 'sending'
`;
	}
	// shortcut: outcome notifications are at least once, add provider idempotency if duplicate status replies become
	// material.
	await post(row.status === 'sent' && row.outcome?.kind === 'sent'
		? 'Fantasy broadcast accepted by Sendblue.'
		: row.outcome?.kind === 'failed'
			? 'Fantasy broadcast was rejected. This draft will not be retried.'
			: 'Fantasy broadcast outcome is uncertain. This draft will not be retried.');
	await sql`UPDATE fantasy_broadcasts SET notified = TRUE WHERE id = ${row.id}`;
}

const draftOutputSchema = z
	.object({
		ok: z.boolean(),
		draftId: z.string().optional(),
		text: z.string().optional(),
		error: z.string().optional(),
	});
const sendOutputSchema = z.object({ ok: z.boolean(), outcome: z.enum(['sent', 'unknown', 'failed', 'blocked']).optional(), error: z.string().optional() });

/** The channel owns review and decision authority; model context and draft IDs cannot recreate it. */
export function createBroadcastTools(config: FantasyConfig | null, sql: SqlLike = getFantasySql()) {
	const draftGroupMessage = createTool({
		id: 'draft_group_message',
		description: 'Save and post the exact Fantasy draft for Operator review. Never sends to the group.',
		inputSchema: z.object({ note: z.string().min(1).max(2000), text: z.string().min(1).max(2000) }).strict(),
		outputSchema: draftOutputSchema,
		toModelOutput: async (output) => {
			const { markBroadcastDraftAttempt } = await import('../../mastra/channels/sendblue');
			markBroadcastDraftAttempt();
			return { type: 'text', value: JSON.stringify(output) };
		},
		execute: async (inputData, context): Promise<z.infer<typeof draftOutputSchema>> => {
			if (!config || context.agent?.agentId !== 'fantasy-broadcast-agent')
				return { ok: false, error: 'Fantasy drafting is unavailable in this context.' };
			const { getBroadcastPreparation } = await import('../../mastra/channels/sendblue');
			const authority = await getBroadcastPreparation();
			if (!authority)
				return { ok: false, error: 'A fresh Operator DM is required for review.' };
			const db = authority.sql ?? sql;
			await ensureFantasyBroadcastsTable(db);
			if (!db.begin)
				throw new Error('Broadcast review requires durable transactions.');
			const id = randomUUID();
			try {
				await db.begin(async (tx) => {
					if (!await isLatestLinearMessage(authority.dmId, authority.sourceMessageId, tx))
						throw new Error('Broadcast source is no longer current.');
					const rows = await tx`
	INSERT INTO
		fantasy_broadcasts (
			id,
			draft_text,
			draft_digest,
			dm_id,
			session_id,
			source_message_id,
			group_id,
			status
		)
	VALUES
		(
			${id},
			${inputData.text},
			${createHash('sha256').update(inputData.text).digest('hex')},
			${authority.dmId},
			${authority.sessionId},
			${authority.sourceMessageId},
			${config.sendblueGroupId},
			'reviewing'
		)
	ON CONFLICT DO NOTHING
	RETURNING
		id
`;
					if (rows.length !== 1)
						throw new Error('Another broadcast is pending.');
					await authority.post(`Fantasy draft:\n\n${inputData.text}\n\nNext reply: confirm | decline. Any other reply cancels.`);
				});
				const rows = await db`UPDATE fantasy_broadcasts SET status = 'pending', publication_ready = TRUE WHERE id = ${id} AND status = 'reviewing' RETURNING id`;
				if (rows.length !== 1)
					throw new Error('Broadcast review readiness unavailable.');
				authority.ready();
				return { ok: true, draftId: id, text: inputData.text };
			} catch {
				// A readiness write may have committed despite a lost acknowledgement. Revoke it before reporting
				// failure.
				await db`UPDATE fantasy_broadcasts SET status = 'canceled', notified = TRUE, updated_at = now()
					WHERE id = ${id} AND status IN ('reviewing', 'pending')`;
				return { ok: false, error: 'Fantasy draft review unavailable. Nothing is authorized.' };
			}
		},
	});
	const sendGroupMessage = createTool({
		id: 'send_group_message',
		description: 'Application-only confirmed Fantasy delivery. A model call or draft ID cannot authorize sending.',
		inputSchema: z.object({ draftId: z.string().min(6).max(36) }).strict(),
		outputSchema: sendOutputSchema,
		execute: async ({ draftId }): Promise<z.infer<typeof sendOutputSchema>> => {
			const { getBroadcastDecision } = await import('../../mastra/channels/sendblue');
			const authority = getBroadcastDecision(draftId);
			if (!config || !authority)
				return { ok: false, outcome: 'blocked', error: 'Validated Operator confirmation is required.' };
			const db = authority.sql ?? sql;
			await ensureFantasyBroadcastsTable(db);
			if (
				!await isImmediatelyFollowingLinearMessage(
					authority.dmId,
					authority.messageId,
					authority.sourceMessageId,
					db,
				)
			) {
				return { ok: false, outcome: 'blocked', error: 'Confirmation is no longer adjacent.' };
			}
			const rows = await db`UPDATE fantasy_broadcasts SET status = 'sending', updated_at = now(),
				decision = ${{ messageId: authority.messageId, disposition: 'confirmed' }}::jsonb
				WHERE id = ${draftId} AND status = 'pending' AND publication_ready
				AND dm_id = ${authority.dmId} AND session_id = ${authority.sessionId}
				AND source_message_id = ${authority.sourceMessageId} AND group_id = ${config.sendblueGroupId}
				RETURNING draft_text, draft_digest` as { draft_text: string; draft_digest: string }[];
			if (!rows[0])
				return { ok: false, outcome: 'blocked', error: 'This reviewed draft cannot send.' };
			if (createHash('sha256').update(rows[0].draft_text).digest('hex') !== rows[0].draft_digest) {
				await db`UPDATE fantasy_broadcasts SET status = 'canceled', notified = TRUE,
					decision = ${{ messageId: authority.messageId, disposition: 'canceled' }}::jsonb WHERE id = ${draftId} AND status = 'sending'`;
				return { ok: false, outcome: 'blocked', error: 'Reviewed draft bytes changed.' };
			}
			let outcome: SendOutcome;
			try {
				const { sendblueSendClient } = await import('./deliver');
				outcome = await sendblueSendClient.sendExactToGroup(config.sendblueGroupId, rows[0].draft_text);
			} catch {
				outcome = { kind: 'unknown', error: 'Send outcome unavailable.' };
			}
			await db`UPDATE fantasy_broadcasts SET status = ${outcome.kind === 'sent' ? 'sent' : 'send_attempted'},
				message_handle = ${outcome.kind === 'sent' ? outcome.handle : null}, outcome = ${outcome}::jsonb, updated_at = now()
				WHERE id = ${draftId} AND status = 'sending'`;
			return { ok: outcome.kind === 'sent', outcome: outcome.kind };
		},
	});
	return { draftGroupMessage, sendGroupMessage };
}

export const broadcastTools = createBroadcastTools(getFantasyConfig());
