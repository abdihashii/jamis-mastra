import { SQL } from 'bun';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { Mastra } from '@mastra/core';
import { Observability } from '@mastra/observability';
import { PostgresStore } from '@mastra/pg';

import { runSpecialistBoundaryFixture } from '../src/mastra/agents/__tests__/specialist-boundary.fixture';
import { openAICodexGateway } from '../src/mastra/gateways/openai-codex-gateway';
import { createProjectLogger, filterProjectTrace, protectProjectSignals, spanOutputProcessors } from '../src/mastra/observability';
import { runLinearReplyFixture } from '../src/mastra/workflows/__tests__/linear-reply.fixture';
import { runArchitectureLiveModelFixture } from './fixtures/architecture-live-model';

const databaseUrl = process.env.JAMIS_TEST_DATABASE_URL;
assert(databaseUrl, 'Set both database URLs to disposable loopback jamis_sessions_test Postgres.');
const url = new URL(databaseUrl);
assert(['postgres:', 'postgresql:'].includes(url.protocol) && ['localhost', '127.0.0.1'].includes(url.hostname)
	&& url.pathname === '/jamis_sessions_test' && url.searchParams.size === 0, 'Disposable loopback jamis_sessions_test Postgres without query overrides is required.');
assert.equal(process.env.DATABASE_URL, databaseUrl, 'DATABASE_URL must equal JAMIS_TEST_DATABASE_URL.');
assert(process.argv.slice(2).every(arg => arg === '--live'), 'Only --live is supported.');

const schema = `jamis_architecture_${randomUUID().replaceAll('-', '')}`;
const storage = new PostgresStore({ id: schema, connectionString: databaseUrl, schemaName: schema });
const sql = new SQL(databaseUrl, { connection: { search_path: schema } });
const events: unknown[] = [];
const observability = new Observability({ configs: { smoke: {
	serviceName: 'jamis-architecture-smoke',
	spanOutputProcessors,
	spanFilter: filterProjectTrace,
	exporters: [protectProjectSignals({
		name: 'capture',
		onTracingEvent: (event) => { events.push(structuredClone(event.exportedSpan)); },
		onLogEvent: (event) => { events.push(structuredClone(event.log)); },
		onMetricEvent: (event) => { events.push(structuredClone(event.metric)); },
		exportTracingEvent: async () => {},
		flush: async () => {},
		shutdown: async () => {},
	})],
} } });
const mastra = new Mastra({ storage, observability, logger: createProjectLogger(), gateways: { 'openai-codex': openAICodexGateway } });
try {
	await storage.init();
	console.log(JSON.stringify({ typed: await runSpecialistBoundaryFixture(mastra) }));
	console.log(JSON.stringify({ durable: await runLinearReplyFixture(mastra, sql) }));
	if (process.argv.includes('--live'))
		console.log(JSON.stringify({ live: await runArchitectureLiveModelFixture(mastra) }));
	await observability.getInstance('smoke')!.flush();
	assert(!JSON.stringify(events).includes('PRIVATE_ARCHITECTURE_SENTINEL'), 'Private context entered exported signals.');
	console.log('PASS: native typed handback, nested public isolation, stored outcome recovery; no live mutations or outbound messages.');
}
finally {
	await observability.getInstance('smoke')!.shutdown();
	await sql.close();
	try {
		await storage.db.none(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
	}
	finally { await storage.close(); }
}
