import { describe, expect, it } from 'bun:test';

import { createBroadcastTools, ensureFantasyBroadcastsTable } from '../broadcast';
import { parseFantasyConfig } from '../config';
import { getFantasySql } from '../recaps';

// Always self-contained: FANTASY group id here is synthetic ('test-g'), and every
// test path exits before any outbound send could be attempted.
const config = parseFantasyConfig({
	FANTASY_SENDBLUE_GROUP_ID: 'test-g',
	FANTASY_SLEEPER_LEAGUE_ID: 'l1',
	FANTASY_MANAGER_MAP: '{}',
	FANTASY_RECAP_TIMEZONE: 'America/Chicago',
});

let sql: ReturnType<typeof getFantasySql>;
let tools: ReturnType<typeof createBroadcastTools>;

interface DraftOut { ok: boolean; draftId?: string; text?: string; error?: string }
interface SendOut { ok: boolean; outcome?: 'sent' | 'unknown' | 'failed' | 'blocked'; handle?: string; error?: string }

const callDraft = async (input: { note: string; text: string }) => await tools.draftGroupMessage.execute!(input, {} as never) as DraftOut;
const callSend = async (draftId: string) => await tools.sendGroupMessage.execute!({ draftId }, {} as never) as SendOut;

async function fixture() {
	sql ||= getFantasySql();
	await ensureFantasyBroadcastsTable(sql);
	tools ||= createBroadcastTools(config, sql);
}

describe('fantasy broadcast tools', () => {
	it('a null config declines drafting and sending entirely', async () => {
		const { draftGroupMessage, sendGroupMessage } = createBroadcastTools(null);
		expect(await draftGroupMessage.execute!({ note: 'x', text: 'y' }, {} as never)).toMatchObject({ ok: false });
		expect(await sendGroupMessage.execute!({ draftId: 'abcdef12' }, {} as never)).toMatchObject({ ok: false, outcome: 'blocked' });
	});

	it('draft stores the exact text and returns a short id', async () => {
		await fixture();
		const out = await callDraft({ note: 'test intro', text: 'Quiet bot in the chat now.' });
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.text).toBe('Quiet bot in the chat now.');
			expect(out.draftId).toMatch(/^[0-9a-f]{8}$/);
		}
		const rows = await sql`SELECT draft_text, status FROM fantasy_broadcasts WHERE id = ${out.draftId ?? '?'}`;
		expect((rows as Record<string, unknown>[])[0]).toMatchObject({ draft_text: 'Quiet bot in the chat now.', status: 'draft' });
	});

	it('send of an unknown draft id is blocked without any outbound attempt', async () => {
		await fixture();
		const out = await callSend('deadbeef');
		expect(out.ok).toBe(false);
		expect(out.outcome).toBe('blocked');
		expect(out.error).toContain('no draft'); // no import('./deliver') ran at all: only DB status lines
	});

	it('an already-sent or attempted draft can never resend (atomic claim)', async () => {
		await fixture();
		await sql`INSERT INTO fantasy_broadcasts (id, draft_text, status) VALUES ('seed_1', 'old', 'sent') ON CONFLICT (id) DO UPDATE SET status = 'sent'`;
		const sent = await callSend('seed_1');
		expect(sent).toMatchObject({ ok: false, outcome: 'blocked' });
		expect(sent.error).toContain('\'sent\'');
		await sql`UPDATE fantasy_broadcasts SET status = 'send_attempted' WHERE id = 'seed_1'`;
		const attempted = await callSend('seed_1');
		expect(attempted).toMatchObject({ ok: false, outcome: 'blocked' });
		expect(attempted.error).toContain('send_attempted');
	});
});
