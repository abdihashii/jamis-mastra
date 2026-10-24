import { Mastra } from '@mastra/core';
import { Observability } from '@mastra/observability';
import { PostgresStore } from '@mastra/pg';
import { SQL } from 'bun';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { filterProjectTrace, protectProjectSignals, spanOutputProcessors } from '../../observability';

if (!process.env.JAMIS_DELEGATION_TEST) {
	test('production typed delegation runs with controlled capabilities', async () => {
		const child = Bun.spawn([process.execPath, '--no-env-file', 'test', import.meta.path], {
			env: {
				...process.env,
				JAMIS_DELEGATION_TEST: '1',
				JAMIS_ALLOWED_NUMBER: '+15555550101',
				SENDBLUE_WEBHOOK_SECRET: 'fixture',
				SENDBLUE_API_KEY: 'fixture',
				SENDBLUE_API_SECRET: 'fixture',
				SENDBLUE_FROM_NUMBER: '+15555550100',
				OPEN_WEATHER_API_KEY: 'fixture',
				FIRECRAWL_API_KEY: 'fc-fixture',
				PERPLEXITY_API_KEY: 'pplx-fixture',
				GOOGLE_CLIENT_ID: 'fixture',
				GOOGLE_CLIENT_SECRET: 'fixture',
				OPERATOR_TIMEZONE: 'UTC',
			},
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 30_000,
		});
		const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		expect({ exit, output: exit ? stdout + stderr : '' }).toEqual({ exit: 0, output: '' });
	}, 35_000);
} else {
	const { runJamisChannelFixture, runJamisDelegationFixture, runJamisNestedResearchFixture, runJamisResearchFixture, runJamisWeatherValidationFixture } = await import('./jamis-delegation.fixture');
	const { runJamisAmbientAuthorityFixture } = await import('./specialist-ambient.fixture');
	const { runSpecialistClarificationFixture } = await import('./specialist-clarification.fixture');
	test('genuine Jamis entry: fresh clarification, supersession, independent partial and denied bypass', async () => {
		await runJamisDelegationFixture(new Mastra({ logger: false }));
	}, 10_000);
	test('Weather completed requires retrieved matching place and date', async () => {
		await runJamisWeatherValidationFixture(new Mastra({ logger: false }));
	}, 10_000);
	test('Jamis owns simple forecast and alert composition; migrated telemetry stays protected', async () => {
		const signals: unknown[] = [];
		const observability = new Observability({ configs: { fixture: {
			serviceName: 'jamis-stage2-fixture',
			spanOutputProcessors,
			spanFilter: filterProjectTrace,
			exporters: [protectProjectSignals({
				name: 'capture',
				onTracingEvent: (event) => { signals.push(structuredClone(event.exportedSpan)); },
				onLogEvent: (event) => { signals.push(structuredClone(event.log)); },
				onMetricEvent: (event) => { signals.push(structuredClone(event.metric)); },
				exportTracingEvent: async () => {},
				flush: async () => {},
				shutdown: async () => {},
			})],
		} } });
		try {
			await runJamisResearchFixture(new Mastra({ logger: false, observability }));
			await runJamisNestedResearchFixture(new Mastra({ logger: false, observability }));
			await observability.getInstance('fixture')!.flush();
			const exported = JSON.stringify(signals);
			expect(exported).not.toContain('PRIVATE_ARCHITECTURE_SENTINEL');
			expect(exported).toContain('invoke_research');
			expect(exported).toContain('invoke_weather');
			expect(exported).toContain('research-agent');
			expect(exported).toContain('weather-agent');
			expect(signals.some((value) => {
				const usage = (value as { attributes?: { usage?: { inputTokens?: number; outputTokens?: number } } }).attributes?.usage;
				return typeof usage?.inputTokens === 'number' && typeof usage.outputTokens === 'number';
			})).toBe(true);
		} finally { await observability.getInstance('fixture')!.shutdown(); }
	}, 10_000);
	test.skipIf(!process.env.JAMIS_TEST_DATABASE_URL)('native production DM handler preserves clarification and supersedes unfinished weather', async () => {
		const databaseUrl = process.env.JAMIS_TEST_DATABASE_URL!;
		const url = new URL(databaseUrl);
		expect(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/jamis_sessions_test' && url.searchParams.size === 0).toBe(true);
		const schema = `jamis_delegation_${randomUUID().replaceAll('-', '')}`;
		const storage = new PostgresStore({ id: schema, connectionString: databaseUrl, schemaName: schema });
		const sql = new SQL(databaseUrl, { connection: { search_path: schema } });
		try {
			await storage.init();
			await runJamisChannelFixture(new Mastra({ logger: false, storage }), sql);
			await runJamisAmbientAuthorityFixture(new Mastra({ logger: false, storage }), sql);
			await runSpecialistClarificationFixture(new Mastra({ logger: false, storage }), sql);
		} finally {
			await sql.close();
			try {
				await storage.db.none(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
			} finally { await storage.close(); }
		}
	}, 20_000);
}
