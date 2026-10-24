import type { z } from 'zod';
import type { SqlLike } from '../../../lib/fantasy/recaps';
import { SQL } from 'bun';
import { describe, expect, test } from 'bun:test';
import { listFantasyMonitoringRuns } from '../../../lib/fantasy/runs';
import { checkMonitoringTool, readFantasyMonitoring } from '../check-monitoring';
import { deploymentEvidenceTool, readFullDeploymentEvidence } from '../deployment-evidence';
import { readDeploymentMonitoring } from '../deployment-monitoring';

process.env.JAMIS_ALLOWED_NUMBER = '+15555550101';
process.env.SENDBLUE_API_KEY = 'test-api-key';
process.env.SENDBLUE_API_SECRET = 'test-api-secret';
process.env.SENDBLUE_FROM_NUMBER = '+15555550100';
process.env.SENDBLUE_WEBHOOK_SECRET = 'test-webhook-secret';
const { readIncident, triageIncidentTool } = await import('../triage-incident');

const now = Date.parse('2026-10-21T02:00:00Z');
const privateText = 'PRIVATE_REASON_SENTINEL +15555550101 group context packetJson rejected outputs';
const generationSummary = {
	attemptId: '11111111-1111-4111-8111-111111111111',
	generatorVersion: 'fantasy-recap-v13',
	phase: 'blocked',
	counts: { nfl: 1, drafts: 3, reviews: 3 },
	reasonCode: 'draft_limit',
	evidenceId: `evidence-${'a'.repeat(64)}`,
	candidateId: `candidate-${'b'.repeat(64)}`,
	reportId: null,
};
const row = {
	fantasy_week: 22,
	status: 'failed',
	failure_stage: 'model',
	failure_classification: 'execution_failed',
	lease_expires_at: null,
	send_attempt_at: null,
	delivery_source: null,
	sent_at: null,
	updated_at: new Date(now),
	latest_attempt_trace_id: 'c'.repeat(32),
	generation_summary: generationSummary,
	editorial_attempt: { current: { scope: privateText, window: privateText }, debug: { packetJson: privateText } },
	final_text: privateText,
};
const sql: SqlLike = async () => [row];

describe('Fantasy generation monitoring boundary', () => {
	test('projects only bounded current generation metadata and keeps week 22', async () => {
		const queries: string[] = [];
		const runs = await listFantasyMonitoringRuns('fixture-league', undefined, async (parts) => {
			queries.push(parts.join('?'));
			return [row];
		});
		await listFantasyMonitoringRuns('fixture-league', 22, async (parts) => {
			queries.push(parts.join('?'));
			return [row];
		});
		expect(runs[0]).toMatchObject({ fantasyWeek: 22, generationSummary });
		for (const query of queries) {
			expect(query).toContain('jsonb_build_object');
			expect(query).not.toMatch(/SELECT\s+\*|debug|packetJson|scope|window|calls|final_text|last_error/i);
			expect(query).not.toMatch(/editorial_attempt\s*(?:,|FROM)/i);
		}
		const result = await readFantasyMonitoring('fixture-league', async () => runs, 22, now);
		expect(result).toMatchObject({ week: 22, run: { generationSummary } });
		expect((checkMonitoringTool.outputSchema as z.ZodTypeAny).safeParse(result).success).toBe(true);
		expect(JSON.stringify([runs, result])).not.toContain(privateText);
	});

	test('drops malformed summaries entirely, including unsafe reason and hidden source fields', async () => {
		for (const invalid of [
			{ ...generationSummary, reasonCode: privateText },
			{ ...generationSummary, counts: { nfl: 4, drafts: 0, reviews: 0 } },
			{ ...generationSummary, attemptId: privateText },
			{ ...generationSummary, reportId: privateText },
			{ ...generationSummary, scope: privateText },
			{ ...generationSummary, counts: { ...generationSummary.counts, debug: privateText } },
			null,
		]) {
			const runs = await listFantasyMonitoringRuns('fixture-league', 22, async () => [{ ...row, generation_summary: invalid }]);
			expect(runs[0]).not.toHaveProperty('generationSummary');
			expect(JSON.stringify(runs)).not.toContain(privateText);
		}
	});

	test('preserves source-owned metadata through deployment evidence, findings, and incident output', async () => {
		const runs = await listFantasyMonitoringRuns('fixture-league', 22, sql);
		const evidence = await readFullDeploymentEvidence(async () => undefined, () => sql, 'fixture-league', '/tmp/jamis-monitoring-missing.sock', now);
		expect(evidence.postgres.recentFantasyRun).toMatchObject({ week: 22, generationSummary, traceId: 'c'.repeat(32) });
		expect((deploymentEvidenceTool.outputSchema as z.ZodTypeAny).safeParse(evidence).success).toBe(true);
		const deployment = await readDeploymentMonitoring({
			getStore: async () => undefined,
			readWorkflowRuns: async () => [],
			readFantasyRuns: async () => runs,
			readEvidence: async () => evidence,
		}, 24, now);
		expect(deployment.needsAttention).toContainEqual(expect.objectContaining({ week: 22, generationSummary }));
		const incident = await readIncident({ kind: 'application', component: 'fantasy-weekly-recap', humanDomainReference: 'week 22', window: { start: new Date(now - 1000), end: new Date(now) } }, {
			fantasyLeagueId: 'fixture-league',
			flush: async () => {},
			getStore: async () => undefined,
			readFantasyRuns: async () => runs as never,
		});
		expect(incident).toMatchObject({ status: 'found', incident: { humanDomainReference: 'week 22', generationSummary, stage: 'model', classification: 'execution_failed' } });
		expect((triageIncidentTool.outputSchema as z.ZodTypeAny).safeParse(incident).success).toBe(true);
		expect(JSON.stringify([evidence, deployment, incident])).not.toContain(privateText);
	});

	test('keeps the nine workflow outcomes while exposing only validated v13 output references', async () => {
		const evidence = await readFullDeploymentEvidence(async () => undefined, () => sql, 'fixture-league', '/tmp/jamis-monitoring-missing.sock', now);
		const outcomes = ['noop-already-sent', 'noop-no-completed-week', 'skipped-unconfigured', 'error', 'sent', 'failed', 'delivery_unknown', 'blocked-active-claim', 'blocked-delivery-unknown'];
		for (const outcome of outcomes) {
			const outputRefs = { attemptId: generationSummary.attemptId, reportId: `report-${'d'.repeat(64)}`, reason: 'generation_blocked', counts: generationSummary.counts };
			const result = await readDeploymentMonitoring({
				getStore: async () => undefined,
				readFantasyRuns: async () => [],
				readEvidence: async () => evidence,
				readWorkflowRuns: async () => [{ updatedAt: new Date(now), snapshot: { status: 'success', result: { status: 'success', output: { outcome, week: 22, ...outputRefs, debug: privateText, packetJson: privateText, scope: privateText, rejected: privateText } } } }],
			}, 24, now);
			expect(result.unknowns.some(item => item.gap === 'fantasy_execution_unverified')).toBe(false);
			if (['error', 'failed', 'sent', 'delivery_unknown', 'blocked-delivery-unknown', 'noop-already-sent', 'noop-no-completed-week'].includes(outcome))
				expect([...result.needsAttention, ...result.operatingNormally]).toContainEqual(expect.objectContaining({ week: 22, outputRefs }));
			expect(JSON.stringify(result)).not.toContain(privateText);
		}
		for (const reason of [privateText, 'x'.repeat(101)]) {
			const result = await readDeploymentMonitoring({
				getStore: async () => undefined,
				readFantasyRuns: async () => [],
				readEvidence: async () => evidence,
				readWorkflowRuns: async () => [{ updatedAt: new Date(now), snapshot: { status: 'success', result: { status: 'success', output: { outcome: 'error', reason } } } }],
			}, 24, now);
			expect(result.needsAttention).toContainEqual({ subject: 'fantasy_recaps', fact: 'recap_execution_failed', boundary: 'recent_history', at: new Date(now).toISOString() });
			expect(JSON.stringify(result)).not.toContain(reason);
		}
	});

	test('accepts week 22 but refuses model-supplied generation metadata and references', () => {
		const monitoring = checkMonitoringTool.inputSchema as z.ZodTypeAny;
		const incident = triageIncidentTool.inputSchema as z.ZodTypeAny;
		expect(monitoring.safeParse({ scope: 'fantasy', week: 22 }).success).toBe(true);
		expect(monitoring.safeParse({ scope: 'fantasy', week: 23 }).success).toBe(false);
		expect(incident.safeParse({ kind: 'application', component: 'fantasy-weekly-recap', humanDomainReference: 'week 22' }).success).toBe(true);
		expect(incident.safeParse({ kind: 'application', component: 'fantasy-weekly-recap', humanDomainReference: 'week 23' }).success).toBe(false);
		for (const extra of [{ generationSummary }, { outputRefs: { attemptId: generationSummary.attemptId } }, { attemptId: generationSummary.attemptId }, { reportId: generationSummary.reportId }, { scope: privateText }, { debug: privateText }]) {
			expect(monitoring.safeParse({ scope: 'fantasy', week: 22, ...extra }).success).toBe(false);
			expect(incident.safeParse({ kind: 'monitoring_finding', finding: { week: 22, ...extra } }).success).toBe(false);
		}
	});
});

const databaseUrl = process.env.JAMIS_TEST_DATABASE_URL;
const disposableDatabase = databaseUrl && new URL(databaseUrl).port === '15458' && ['127.0.0.1', 'localhost'].includes(new URL(databaseUrl).hostname);
(disposableDatabase ? test : test.skip)('native PostgreSQL projection returns no private generation state and leaves legacy output absent', async () => {
	const db = new SQL(databaseUrl!, { max: 1 });
	try {
		await db.begin(async (tx) => {
			await tx`
	CREATE TEMP TABLE fantasy_recap_runs (
		league_id TEXT,
		fantasy_week INTEGER,
		status TEXT,
		failure_stage TEXT,
		failure_classification TEXT,
		lease_expires_at TIMESTAMPTZ,
		send_attempt_at TIMESTAMPTZ,
		delivery_source TEXT,
		sent_at TIMESTAMPTZ,
		updated_at TIMESTAMPTZ,
		latest_attempt_trace_id TEXT,
		editorial_attempt JSONB
	) ON
	COMMIT
	DROP
`;
			const { attemptId, ...current } = generationSummary;
			const state = { current: { ...current, id: attemptId, scope: privateText, window: privateText, calls: [privateText] }, debug: { packetJson: privateText, outputs: [privateText] } };
			await tx`
	INSERT INTO
		fantasy_recap_runs (
			league_id,
			fantasy_week,
			status,
			updated_at,
			editorial_attempt
		)
	VALUES
		(
			'fixture-league',
			22,
			'failed',
			${new Date(now)},
			${state}::jsonb
		),
		(
			'fixture-league',
			1,
			'sent',
			${new Date(now)},
			NULL
		)
`;
			const nativeRows: unknown[] = [];
			const scoped: SqlLike = async (parts, ...values) => {
				const result = await tx(parts, ...values);
				nativeRows.push(...result);
				return result;
			};
			const runs = await listFantasyMonitoringRuns('fixture-league', undefined, scoped);
			expect(nativeRows[0]).toMatchObject({ generation_summary: generationSummary });
			expect(runs[0]).toMatchObject({ fantasyWeek: 22, generationSummary });
			expect(runs[1]).not.toHaveProperty('generationSummary');
			expect(await listFantasyMonitoringRuns('fixture-league', 22, scoped)).toEqual([runs[0]!]);
			expect(await listFantasyMonitoringRuns('other-fixture', undefined, scoped)).toEqual([]);
			expect(JSON.stringify(nativeRows)).not.toMatch(/PRIVATE_REASON_SENTINEL|editorial_attempt|scope|window|calls|packetJson|debug|outputs/);
		});
	} finally {
		await db.close();
	}
});
