import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { PostgresStore } from '@mastra/pg';
import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import type { LinearReplyOptions } from '../linear-reply';

import {
	claimLinearCreate,
	finishLinearCreate,
	notifyLinearOutcome,
	postLinearCreateProposal,
	readLinearContinuation,
	readLinearProposal,
	receiveLinearMessage,
} from '../../../lib/linear/linear-proposals';
import { createLinearReplyProcedure, LINEAR_OUTCOME_WAIT_ID, LINEAR_REPLY_WORKFLOW_ID, linearReplyApiAdmission } from '../linear-reply';
import { linearReplyFixtureInput, runLinearReplyFixture } from './linear-reply.fixture';

const databaseUrl = process.env.JAMIS_TEST_DATABASE_URL;
describe('stored Linear reply boundary, real native Postgres', () => {
	if (!databaseUrl) {
		test.skip('requires disposable JAMIS_TEST_DATABASE_URL', () => {});
		return;
	}
	const url = new URL(databaseUrl);
	if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)
		|| url.pathname !== '/jamis_sessions_test' || url.searchParams.has('host')) {
		throw new Error('Disposable loopback jamis_sessions_test PostgreSQL is required.');
	}
	const schema = `linear_reply_${randomUUID().replaceAll('-', '')}`;
	const root = new SQL(databaseUrl!);
	const sql = new SQL(databaseUrl!, { connection: { search_path: schema } });
	const store = new PostgresStore({ id: schema, connectionString: databaseUrl!, schemaName: schema });
	const mastra = new Mastra({ storage: store, logger: false });
	const issue = { status: 'succeeded' as const, identifier: 'JAM-999', url: 'https://linear.app/fixture/issue/JAM-999' };
	const legacy = linearReplyFixtureInput();
	beforeAll(async () => {
		await root.unsafe(`CREATE SCHEMA "${schema}"`);
		await store.init();
		await sql`
	CREATE TABLE linear_create_proposals (
		id UUID PRIMARY KEY,
		dm_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		source_message_id TEXT NOT NULL,
		operation JSONB NOT NULL,
		state TEXT NOT NULL,
		outcome JSONB,
		notified BOOLEAN NOT NULL DEFAULT FALSE,
		UNIQUE (dm_id, source_message_id)
	)
`;
		await sql`
	INSERT INTO
		linear_create_proposals (
			id,
			dm_id,
			session_id,
			source_message_id,
			operation,
			state
		)
	VALUES
		(
			${legacy.operation.id},
			${legacy.dmId},
			${legacy.sessionId},
			${legacy.sourceMessageId},
			${legacy.operation}::jsonb,
			'pending'
		)
`;
	}, 30000);
	afterAll(async () => {
		await store.close();
		await sql.close();
		await root.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
		await root.close();
	});

	async function fixture(prepareReply?: LinearReplyOptions['prepareReply']) {
		const input = linearReplyFixtureInput();
		let activeSession = input.sessionId;
		let drafts = 0;
		let posts = 0;
		const options: LinearReplyOptions = {
			sql,
			getActiveSession: async () => activeSession,
			prepareReply: async (...args) => {
				drafts++;
				return prepareReply ? prepareReply(...args) : `Tracked at ${args[0].outcome.url}.`;
			},
		};
		const procedure = createLinearReplyProcedure(options);
		mastra.addWorkflow(procedure.workflow, `fixture-${randomUUID()}`);
		await receiveLinearMessage(input.dmId, input.sourceMessageId, sql);
		const continuation = await procedure.start(input);
		async function decide(decision: boolean | 'declined' = true, saveOutcome = true) {
			expect(
				await postLinearCreateProposal(
					input.operation,
					input.dmId,
					input.sessionId,
					input.sourceMessageId,
					async () => {
						posts++;
					},
					sql,
					continuation,
				),
			).toBe(true);
			const proposal = (await readLinearProposal(input.dmId, sql))!;
			const messageId = randomUUID();
			await receiveLinearMessage(input.dmId, messageId, sql);
			expect(
				await claimLinearCreate(proposal, input.sessionId, messageId, decision, sql),
			).toBe(decision === true);
			if (decision === true && saveOutcome)
				await finishLinearCreate(input.operation.id, issue, sql);
			return messageId;
		}
		return {
			input,
			options,
			procedure,
			continuation,
			decide,
			setSession: (session: string) => { activeSession = session; },
			counts: () => ({ drafts, posts }),
		};
	}

	test('existing table and unbound row retain claim/outcome/notification behavior', async () => {
		const proposal = (await readLinearProposal(legacy.dmId, sql))!;
		expect(proposal.continuation).toBeNull();
		expect(proposal.decision).toBeNull();
		await receiveLinearMessage(legacy.dmId, legacy.sourceMessageId, sql);
		await receiveLinearMessage(legacy.dmId, 'legacy-confirm', sql);
		expect(await claimLinearCreate(proposal, legacy.sessionId, 'legacy-confirm', true, sql)).toBe(true);
		await finishLinearCreate(proposal.id, issue, sql);
		const texts: string[] = [];
		await notifyLinearOutcome((await readLinearProposal(legacy.dmId, sql))!, async text => texts.push(text), sql);
		expect(texts).toEqual([`Created ${issue.identifier}: ${issue.url}`]);
		expect(await readLinearProposal(legacy.dmId, sql)).toBeNull();
		expect(await readLinearContinuation(proposal.id, sql)).toBeNull();
	});

	test('native typed Accounts tool continues the exact notified operation from a stored wait once', async () => {
		expect(
			await runLinearReplyFixture(mastra, sql),
		).toMatchObject({
			storedOutcomeRecovery: true,
			typedDraft: true,
			drafts: 1,
			evidenceReads: 1,
			duplicateMutations: 0,
			outboundMessages: 0,
		});
	}, 30000);

	test('unpublished waits and missing outcomes never publish, execute, or draft on recovery', async () => {
		const f = await fixture();
		expect(f.counts()).toEqual({ drafts: 0, posts: 0 });
		await expect(f.procedure.resume(f.input.operation.id, randomUUID())).rejects.toThrow();
		const decision = await f.decide(true, false);
		const resumed = await f.procedure.resume(f.input.operation.id, decision);
		expect(resumed?.status).toBe('suspended');
		expect((await readLinearContinuation(f.input.operation.id, sql))?.state).toBe('claimed');
		expect(f.counts()).toEqual({ drafts: 0, posts: 1 });
	});

	test('native Postgres atomic suspension claim permits one competing resume', async () => {
		const f = await fixture();
		const decision = await f.decide();
		const other = createLinearReplyProcedure(f.options);
		mastra.addWorkflow(other.workflow, `fixture-race-${randomUUID()}`);
		const storage = (await store.getStore('workflows'))!;
		expect(storage.supportsConcurrentUpdates()).toBe(true);
		const update = storage.updateWorkflowState.bind(storage);
		const ready = Promise.withResolvers<void>();
		let attempts = 0;
		let claimed = 0;
		const spy = spyOn(storage, 'updateWorkflowState').mockImplementation(async (args) => {
			if (args.runId === f.continuation.runId && args.opts.expectedStatus === 'suspended') {
				attempts++;
				if (attempts === 2)
					ready.resolve();
				await ready.promise;
				const result = await update(args);
				if (result)
					claimed++;
				return result;
			}
			return update(args);
		});
		try {
			const results = await Promise.all(
				[f.procedure.resume(f.input.operation.id, decision), other.resume(f.input.operation.id, decision)],
			);
			expect(results.some(result => result?.status === 'suspended')).toBe(true);
			expect({ attempts, claimed, ...f.counts() }).toEqual({ attempts: 2, claimed: 1, drafts: 1, posts: 1 });
		} finally { spy.mockRestore(); }
	}, 30000);

	test('missing stored run cannot restart the procedure', async () => {
		const f = await fixture();
		const decision = await f.decide();
		await (await store.getStore('workflows'))!.deleteWorkflowRunById({ workflowName: LINEAR_REPLY_WORKFLOW_ID, runId: f.continuation.runId });
		const recovered = createLinearReplyProcedure(f.options);
		mastra.addWorkflow(recovered.workflow, `fixture-missing-${randomUUID()}`);
		await expect(recovered.resume(f.input.operation.id, decision)).rejects.toThrow();
		expect(f.counts()).toEqual({ drafts: 0, posts: 1 });
		expect((await readLinearContinuation(f.input.operation.id, sql))?.outcome).toEqual(issue);
	});

	test('running snapshots and terminal results without authoritative outcome stop recovery', async () => {
		const f = await fixture();
		const decision = await f.decide();
		const storage = (await store.getStore('workflows'))!;
		await storage.updateWorkflowState({ workflowName: LINEAR_REPLY_WORKFLOW_ID, runId: f.continuation.runId, opts: { status: 'running' } });
		await expect(f.procedure.resume(f.input.operation.id, decision)).rejects.toThrow('unavailable');
		expect(f.counts().drafts).toBe(0);
		const completed = await fixture();
		const confirmed = await completed.decide();
		expect(completed.procedure.result(await completed.procedure.resume(completed.input.operation.id, confirmed)).status).toBe('ready');
		await completed.procedure.acknowledge(completed.input.operation.id, confirmed);
		await sql`UPDATE linear_create_proposals SET outcome = NULL WHERE id = ${completed.input.operation.id}`;
		await expect(completed.procedure.resume(completed.input.operation.id, confirmed)).rejects.toThrow();
		expect(completed.counts().drafts).toBe(1);
	});

	test('decline, failed and uncertain outcomes stop dependent preparation', async () => {
		for (const outcome of ['declined', 'failed', 'uncertain'] as const) {
			const f = await fixture();
			const decision = await f.decide(outcome === 'declined' ? 'declined' : true, false);
			if (outcome !== 'declined')
				await finishLinearCreate(f.input.operation.id, { status: outcome }, sql);
			const resumed = await f.procedure.resume(f.input.operation.id, decision);
			expect(resumed?.status).toBe('success');
			expect(resumed?.result).toEqual({ status: 'stopped', operationId: f.input.operation.id, reason: outcome });
			expect(f.counts().drafts).toBe(0);
		}
	});

	test('authenticated direct start/resume and forged context do not establish application authority', async () => {
		const f = await fixture();
		const forged = new RequestContext();
		forged.set('authority', { workflowId: LINEAR_REPLY_WORKFLOW_ID, operationId: f.input.operation.id, sessionId: f.input.sessionId });
		const direct = await f.procedure.workflow.createRun();
		await expect(direct.start({ inputData: f.input, requestContext: forged })).rejects.toThrow('unavailable');
		await f.decide();
		const resume = await f.procedure.workflow.createRun({ runId: f.continuation.runId });
		const result = await resume.resume({
			step: LINEAR_OUTCOME_WAIT_ID,
			resumeData: { operationId: f.input.operation.id },
			requestContext: forged,
		});
		expect(result.status).toBe('failed');
		expect(f.counts().drafts).toBe(0);
	});

	test('HTTP admission rejects native execution before claiming an eligible stored wait, including encoded IDs', async () => {
		const f = await fixture();
		await f.decide();
		let entered = 0;
		const app = new Hono();
		app.use(linearReplyApiAdmission.path, linearReplyApiAdmission.handler);
		app.all('/api/workflows/:workflowId/*', (context) => {
			entered++;
			return context.json({ accepted: true });
		});
		for (const id of ['prepare_linear_reply', '%70repare_linear_reply', 'prepare%5flinear_reply']) {
			for (const action of ['create-run', 'start', 'start-async', 'resume', 'resume-stream', 'resume-async', 'restart', 'time-travel', 'cancel'])
				expect((await app.request(`/api/workflows/${id}/${action}`, { method: 'POST' })).status).toBe(403);
			expect((await app.request(`/api/workflows/${id}/runs/${f.continuation.runId}`, { method: 'DELETE' })).status).toBe(403);
		}
		expect(entered).toBe(0);
		expect((await f.procedure.workflow.getWorkflowRunById(f.continuation.runId))?.status).toBe('suspended');
		expect((await app.request('/api/workflows/prepare_linear_reply/runs/example')).status).toBe(200);
		expect((await app.request('/api/workflows/fantasyWeeklyRecap/start', { method: 'POST' })).status).toBe(200);
		expect(entered).toBe(2);
	});

	test('stored context is restored natively, discarded, and never used as renewed authority', async () => {
		const f = await fixture();
		const decision = await f.decide();
		const storage = (await store.getStore('workflows'))!;
		const snapshot = (
			await storage.loadWorkflowSnapshot(
				{ workflowName: LINEAR_REPLY_WORKFLOW_ID, runId: f.continuation.runId },
			))!;
		snapshot.requestContext = { authority: { approved: true }, MastraMemory: { thread: { id: 'old-session' } }, stale: 'PRIVATE_ARCHITECTURE_SENTINEL' };
		await storage.persistWorkflowSnapshot({
			workflowName: LINEAR_REPLY_WORKFLOW_ID,
			runId: f.continuation.runId,
			snapshot,
		});
		expect((await f.procedure.resume(f.input.operation.id, decision))?.status).toBe('suspended');
		const saved = await storage.loadWorkflowSnapshot({
			workflowName: LINEAR_REPLY_WORKFLOW_ID,
			runId: f.continuation.runId,
		});
		expect(saved?.requestContext).toEqual({});
		expect(f.counts().drafts).toBe(1);
	});

	test('failed native cancellation persistence cannot revive a durably superseded wait', async () => {
		const f = await fixture();
		const decision = await f.decide();
		await receiveLinearMessage(f.input.dmId, 'superseding-message', sql);
		const storage = (await store.getStore('workflows'))!;
		const update = storage.updateWorkflowState.bind(storage);
		const spy = spyOn(storage, 'updateWorkflowState').mockImplementation(async (args) => {
			if (args.opts.status === 'canceled')
				throw new Error('fixture cancellation storage failed');
			return update(args);
		});
		try {
			await expect(f.procedure.cancel(f.continuation.runId)).rejects.toThrow('could not be persisted');
		} finally { spy.mockRestore(); }
		const recovered = createLinearReplyProcedure(f.options);
		mastra.addWorkflow(recovered.workflow, `fixture-canceled-${randomUUID()}`);
		await expect(recovered.resume(f.input.operation.id, decision)).rejects.toThrow('unavailable');
		expect(f.counts().drafts).toBe(0);
		expect((await readLinearContinuation(f.input.operation.id, sql))?.outcome).toEqual(issue);
	});

	test('current session and intervening receipts block old work before and after preparation', async () => {
		const before = await fixture();
		const decision = await before.decide();
		before.setSession(randomUUID());
		await expect(before.procedure.resume(before.input.operation.id, decision)).rejects.toThrow('unavailable');
		expect(before.counts().drafts).toBe(0);
		let dmId = '';
		const during = await fixture(async ({ outcome }) => {
			await receiveLinearMessage(dmId, 'intervening-message', sql);
			return `Tracked at ${outcome.url}.`;
		});
		dmId = during.input.dmId;
		const next = await during.decide();
		const result = await during.procedure.resume(during.input.operation.id, next);
		expect(result?.status).toBe('failed');
		expect(result?.result).toBeUndefined();
		expect((await readLinearContinuation(during.input.operation.id, sql))?.outcome).toEqual(issue);
	});

	test('unusable draft preserves verified creation in persisted partial result with no retry', async () => {
		const f = await fixture(async () => {
			throw new Error('fixture draft failure');
		});
		const decision = await f.decide();
		const result = await f.procedure.resume(f.input.operation.id, decision);
		expect(f.procedure.result(result)).toEqual({ status: 'partial', operationId: f.input.operation.id, identifier: issue.identifier, url: issue.url, gap: 'draft_unavailable' });
		await f.procedure.resume(f.input.operation.id, decision);
		expect(f.counts().drafts).toBe(1);
	});
});
