import type { LinearCreateOperation, LinearCreateOutcome } from './linear';
import type { SqlLike } from './operator-time-zone';

import { SQL } from 'bun';
import process from 'node:process';
import { z } from 'zod';
import { linearCreateOperationSchema, linearCreateOutcomeSchema } from './linear';

export const linearContinuationSchema = z.object({
	workflowId: z.literal('prepare_linear_reply'),
	runId: z.string().min(1),
	waitStep: z.literal('await_linear_outcome'),
}).strict();
export type LinearContinuation = z.infer<typeof linearContinuationSchema>;
export const linearDecisionSchema = z.object({
	messageId: z.string().min(1).nullable(),
	disposition: z.enum(['confirmed', 'declined', 'canceled']),
}).strict();

let cachedSql: SQL | undefined;
const ready = new WeakMap<SqlLike, Promise<void>>();

function getSql(): SQL {
	return cachedSql ??= new SQL(process.env.DATABASE_URL ?? 'postgres://localhost:5432/mastra');
}

async function ensureTables(sql: SqlLike): Promise<void> {
	let pending = ready.get(sql);
	if (!pending) {
		pending = (async () => {
			await sql`
				CREATE TABLE IF NOT EXISTS linear_dm_receipts (
					ordinal BIGSERIAL UNIQUE NOT NULL,
					dm_id TEXT NOT NULL,
					message_id TEXT NOT NULL,
					PRIMARY KEY (dm_id, message_id)
				)
			`;
			await sql`
				CREATE TABLE IF NOT EXISTS linear_create_proposals (
					id UUID PRIMARY KEY,
					dm_id TEXT NOT NULL,
					session_id TEXT NOT NULL,
					source_message_id TEXT NOT NULL,
					operation JSONB NOT NULL,
					state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'succeeded', 'failed', 'uncertain', 'canceled')),
					outcome JSONB,
					notified BOOLEAN NOT NULL DEFAULT FALSE,
					UNIQUE (dm_id, source_message_id)
				)
			`;
			await sql`ALTER TABLE linear_create_proposals ADD COLUMN IF NOT EXISTS continuation JSONB`;
			await sql`ALTER TABLE linear_create_proposals ADD COLUMN IF NOT EXISTS decision JSONB`;
		})();
		ready.set(sql, pending);
		pending.catch(() => ready.delete(sql));
	}
	await pending;
}

async function transaction<T>(dmId: string, sql: SqlLike, work: (tx: SqlLike) => Promise<T>): Promise<T> {
	await ensureTables(sql);
	if (!sql.begin)
		throw new Error('Linear proposals require durable transactions.');
	return sql.begin(async (tx) => {
		// ponytail: one advisory lock per DM; a durable intake worker is needed for multiple active channel processes.
		await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`linear:${dmId}`}, 0))`;
		return work(tx);
	});
}

export interface LinearProposal {
	id: string;
	dm_id: string;
	session_id: string;
	source_message_id: string;
	operation: LinearCreateOperation;
	state: string;
	outcome: LinearCreateOutcome | null;
	notified: boolean;
	continuation?: LinearContinuation | null;
	decision?: z.infer<typeof linearDecisionSchema> | null;
}

export async function receiveLinearMessage(dmId: string, messageId: string, sql: SqlLike = getSql()): Promise<boolean> {
	return transaction(dmId, sql, async (tx) => {
		const rows = await tx`
			INSERT INTO linear_dm_receipts (dm_id, message_id) VALUES (${dmId}, ${messageId})
			ON CONFLICT DO NOTHING RETURNING ordinal
		`;
		return rows.length === 1;
	});
}

export async function readLinearProposal(dmId: string, sql: SqlLike = getSql()): Promise<LinearProposal | null> {
	await ensureTables(sql);
	const rows = await sql`
		SELECT * FROM linear_create_proposals
		WHERE dm_id = ${dmId} AND (state IN ('pending', 'claimed') OR NOT notified)
		ORDER BY id LIMIT 1
	` as LinearProposal[];
	return rows[0] ?? null;
}

/** Outcome notification does not finish the bound procedure. */
export async function readLinearContinuation(id: string, sql: SqlLike = getSql()): Promise<LinearProposal | null> {
	await ensureTables(sql);
	const rows = await sql`SELECT * FROM linear_create_proposals WHERE id = ${id} AND continuation IS NOT NULL` as LinearProposal[];
	return rows[0] ?? null;
}

export async function isLatestLinearMessage(dmId: string, messageId: string, sql: SqlLike = getSql()): Promise<boolean> {
	await ensureTables(sql);
	const rows = await sql`SELECT message_id FROM linear_dm_receipts WHERE dm_id = ${dmId} ORDER BY ordinal DESC LIMIT 1` as { message_id: string }[];
	return rows[0]?.message_id === messageId;
}

export function formatLinearCreateProposal(op: LinearCreateOperation): string {
	return `Create Linear issue in jamis?\n\nTitle: ${JSON.stringify(op.title).slice(1, -1)}\nDescription: ${JSON.stringify(op.description).slice(1, -1)}\nStatus: ${JSON.stringify(op.stateName).slice(1, -1)}\n\nNext reply: confirm | decline. Any other reply cancels.`;
}

export async function postLinearCreateProposal(
	op: LinearCreateOperation,
	dmId: string,
	sessionId: string,
	sourceMessageId: string,
	post: (text: string) => Promise<unknown>,
	sql: SqlLike = getSql(),
	continuation?: LinearContinuation,
): Promise<boolean> {
	linearCreateOperationSchema.parse(op);
	const bound = continuation ? linearContinuationSchema.parse(continuation) : null;
	if (!dmId || !sessionId || !sourceMessageId)
		return false;
	return transaction(dmId, sql, async (tx) => {
		const latest = await tx`SELECT message_id FROM linear_dm_receipts WHERE dm_id = ${dmId} ORDER BY ordinal DESC LIMIT 1` as { message_id: string }[];
		if (latest[0]?.message_id !== sourceMessageId)
			return false;
		const active = await tx`SELECT id FROM linear_create_proposals WHERE dm_id = ${dmId} AND (state IN ('pending', 'claimed') OR NOT notified)`;
		if (active.length)
			return false;
		const inserted = await tx`
			INSERT INTO linear_create_proposals (id, dm_id, session_id, source_message_id, operation, state, continuation)
			VALUES (${op.id}, ${dmId}, ${sessionId}, ${sourceMessageId}, ${op}::jsonb, 'pending', ${bound}::jsonb)
			ON CONFLICT DO NOTHING RETURNING id
		`;
		if (inserted.length !== 1)
			return false;
		// Posting and commit cannot be atomic. Rollback leaves an unseen/uncommitted proposal unauthorized.
		await post(formatLinearCreateProposal(op));
		return true;
	});
}

export async function claimLinearCreate(
	proposal: LinearProposal,
	sessionId: string | null,
	messageId: string,
	confirmed: boolean | 'declined',
	sql: SqlLike = getSql(),
): Promise<boolean> {
	return transaction(proposal.dm_id, sql, async (tx) => {
		const receipts = await tx`
			SELECT message_id FROM linear_dm_receipts WHERE dm_id = ${proposal.dm_id} ORDER BY ordinal DESC LIMIT 2
		` as { message_id: string }[];
		const adjacent = sessionId === proposal.session_id
			&& receipts[0]?.message_id === messageId && receipts[1]?.message_id === proposal.source_message_id;
		const allowed = confirmed === true && adjacent;
		const decision = { messageId, disposition: allowed ? 'confirmed' : adjacent && confirmed === 'declined' ? 'declined' : 'canceled' };
		const rows = await tx`
			UPDATE linear_create_proposals SET state = ${allowed ? 'claimed' : 'canceled'}, notified = ${!allowed}, decision = ${decision}::jsonb
			WHERE id = ${proposal.id} AND state = 'pending' RETURNING id
		`;
		return allowed && rows.length === 1;
	});
}

export async function finishLinearCreate(id: string, outcome: LinearCreateOutcome, sql: SqlLike = getSql()): Promise<void> {
	const safe = linearCreateOutcomeSchema.parse(outcome);
	await ensureTables(sql);
	const rows = await sql`
		UPDATE linear_create_proposals SET state = ${safe.status}, outcome = ${safe}::jsonb
		WHERE id = ${id} AND state = 'claimed' RETURNING id
	`;
	if (rows.length !== 1)
		throw new Error('Linear outcome persistence unavailable.');
}

export async function notifyLinearOutcome(proposal: LinearProposal, post: (text: string) => Promise<unknown>, sql: SqlLike = getSql()): Promise<void> {
	const outcome = linearCreateOutcomeSchema.safeParse(proposal.outcome);
	const result = outcome.success ? outcome.data : { status: 'uncertain' as const };
	const text = result.status === 'succeeded' && result.identifier && result.url
		? `Created ${result.identifier}: ${result.url}`
		: result.status === 'failed'
			? 'Linear issue was not created. The preflight failed; request a fresh proposal to try again.'
			: `Linear create outcome is uncertain. Inspect Linear for issue ID ${proposal.id} before another attempt. This proposal will not be retried.`;
	// A recovered claim may have sent a request. Never replay it, even if no outcome was stored.
	if (proposal.state === 'claimed')
		await finishLinearCreate(proposal.id, { status: 'uncertain' }, sql);
	try {
		await post(text);
	}
	catch {
		throw new Error('Linear result notification unavailable.');
	}
	await sql`UPDATE linear_create_proposals SET notified = TRUE WHERE id = ${proposal.id}`;
}

export async function cancelLinearConversation(dmId: string, sql: SqlLike = getSql()): Promise<void> {
	await transaction(dmId, sql, async (tx) => {
		await tx`UPDATE linear_create_proposals SET state = 'canceled', notified = TRUE, decision = ${{ messageId: null, disposition: 'canceled' }}::jsonb WHERE dm_id = ${dmId} AND state = 'pending'`;
	});
}
