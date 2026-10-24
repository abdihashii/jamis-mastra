import type { z } from 'zod';

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { deploymentEvidenceTool, parseDeploymentEvidence, readDeploymentEvidence, readFullDeploymentEvidence } from '../deployment-evidence';

const now = Date.parse('2026-09-23T12:00:00Z');
const valid = {
	host: {
		component: 'host',
		source: 'procfs',
		observedAt: '2026-09-23T12:00:00Z',
		scope: 'current',
		availability: 'available',
		memoryAvailableMiB: 512,
		load1: 0.5,
		uptimeSeconds: 1000,
		gaps: ['external_reachability', 'recent_host_events'],
	},
	docker: {
		component: 'docker',
		source: 'docker_engine',
		observedAt: '2026-09-23T12:00:00Z',
		scope: 'current',
		availability: 'available',
		containers: [
			{ component: 'app', state: 'running' },
			{ component: 'postgres', state: 'running' },
			{ component: 'clickhouse', state: 'running' },
			{ component: 'cloudflared', state: 'exited' },
		],
		gaps: ['service_functionality', 'external_reachability'],
	},
	cloudflareTunnel: {
		component: 'cloudflare_tunnel',
		source: 'local_cloudflared',
		observedAt: '2026-09-23T12:00:00Z',
		scope: 'current_and_recent_5m',
		availability: 'available',
		containerState: 'exited',
		recentDiagnostic: 'unknown',
		gaps: ['external_reachability', 'recent_tunnel_diagnostics_unavailable'],
	},
	tailscale: {
		component: 'tailscale',
		source: 'local_tailscale',
		observedAt: '2026-09-23T12:00:00Z',
		scope: 'current',
		availability: 'available',
		serviceState: 'active',
		backendState: 'Running',
		gaps: ['operator_device_reachability'],
	},
};

async function withSocket<T>(response: string | null, read: (path: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp('/tmp/jamis-evidence-');
	const path = join(dir, 'probe.sock');
	const server = createServer((socket) => {
		if (response !== null)
			socket.end(response);
	});
	await new Promise<void>(resolve => server.listen(path, resolve));
	try {
		return await read(path);
	} finally {
		server.close();
		await rm(dir, { recursive: true, force: true });
	}
}

const socketResponse = (response: string | null, timeoutMs = 200) => withSocket(response, path => readDeploymentEvidence(path, timeoutMs, now));

describe('deployment evidence boundary', () => {
	test('returns fixed current evidence and classifies stale time', () => {
		const fresh = parseDeploymentEvidence(JSON.stringify(valid), now);
		expect(fresh.host.freshness).toBe('fresh');
		expect(fresh.docker.containers).toHaveLength(4);
		expect([fresh.host, fresh.docker, fresh.cloudflareTunnel, fresh.tailscale].map(item => item.correlation))
			.toEqual(['uncorrelated_context', 'uncorrelated_context', 'uncorrelated_context', 'uncorrelated_context']);
		expect(fresh.tailscale.backendState).toBe('Running');
		expect(parseDeploymentEvidence(JSON.stringify(valid), now + 31_000).host.freshness).toBe('stale');
		expect(parseDeploymentEvidence(JSON.stringify(valid), now + 31_000).tailscale.freshness).toBe('stale');
	});

	test('rejects hostile fields per source without erasing the other source', () => {
		const hostile = {
			...valid,
			host: { ...valid.host, rawName: 'secret +15551234567' },
			docker: { ...valid.docker, containers: [...valid.docker.containers, { component: 'secret', state: 'running' }] },
			cloudflareTunnel: { ...valid.cloudflareTunnel, rawLog: 'secret +15551234567' },
			tailscale: { ...valid.tailscale, deviceName: 'secret +15551234567' },
			metadata: 'secret',
		};
		const result = parseDeploymentEvidence(JSON.stringify(hostile), now);
		expect(result.host.freshness).toBe('unavailable');
		expect(result.docker.freshness).toBe('unavailable');
		expect(result.cloudflareTunnel.freshness).toBe('unavailable');
		expect(result.tailscale.freshness).toBe('unavailable');
		expect(JSON.stringify(result)).not.toMatch(/secret|15551234567|rawName|metadata/);
		const partial = parseDeploymentEvidence(JSON.stringify({ ...valid, docker: hostile.docker }), now);
		expect(partial.host.freshness).toBe('fresh');
		expect(partial.docker.freshness).toBe('unavailable');
		expect(partial.cloudflareTunnel.freshness).toBe('fresh');
	});

	test('connection failure, deadline, and malformed response are unavailable', async () => {
		const missing = await readDeploymentEvidence('/tmp/jamis-evidence-missing.sock', 20, now);
		expect(missing.host.freshness).toBe('unavailable');
		expect(missing.docker.freshness).toBe('unavailable');
		expect(missing.cloudflareTunnel.freshness).toBe('unavailable');
		expect(missing.tailscale.freshness).toBe('unavailable');
		expect((await socketResponse(null, 20)).host.freshness).toBe('unavailable');
		expect((await socketResponse('{bad json')).docker.freshness).toBe('unavailable');
	});

	test('unavailable results retain the UTC check or probe time', async () => {
		const checkedAt = `${new Date(now).toISOString().slice(0, 19)}Z`;
		const failed = await readFullDeploymentEvidence(async () => undefined, () => {
			throw new Error('down');
		}, 'league-secret', '/tmp/jamis-evidence-missing.sock', now);
		expect(Object.values(failed).every(item => item.observedAt === checkedAt)).toBe(true);

		const probeTime = `${new Date(now - 5_000).toISOString().slice(0, 19)}Z`;
		const partial = parseDeploymentEvidence(JSON.stringify({
			...valid,
			host: { ...valid.host, observedAt: probeTime, availability: 'unavailable', memoryAvailableMiB: null, load1: null, uptimeSeconds: null, gaps: ['host_probe_unavailable'] },
			docker: { ...valid.docker, observedAt: probeTime, availability: 'unavailable', containers: [], gaps: ['docker_probe_unavailable'] },
			cloudflareTunnel: { ...valid.cloudflareTunnel, observedAt: probeTime, availability: 'unavailable', containerState: 'unknown', recentDiagnostic: 'unknown', gaps: ['tunnel_probe_unavailable'] },
			tailscale: { ...valid.tailscale, observedAt: probeTime, availability: 'unavailable', serviceState: 'unknown', backendState: 'unknown', gaps: ['tailscale_probe_unavailable'] },
		}), now);
		expect(Object.values(partial).every(item => item.observedAt === probeTime)).toBe(true);
	});

	test('source-native readers keep exact references and independent failures', async () => {
		const sql = async (parts: TemplateStringsArray) => parts.join(' ').includes('SELECT 1')
			? [{ connected: 1 }]
			: [{ fantasy_week: 2, status: 'failed', latest_attempt_trace_id: 'a'.repeat(32), updated_at: new Date(now - 60_000), last_error: 'secret +15551234567' }];
		const getStore = async () => ({
			listTracesLight: async () => ({ spans: [
				{ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), startedAt: new Date(now - 60_000), status: 'error', inputPreview: 'secret +15551234567' },
				{ traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), startedAt: new Date(now - 60_000), status: 'success' },
				{ traceId: 'nearby-but-not-exact', spanId: 'c'.repeat(16), startedAt: new Date(now - 60_000), status: 'error' },
			] }),
		}) as never;
		const result = await readFullDeploymentEvidence(getStore, () => sql, 'league-secret', '/tmp/jamis-evidence-missing.sock', now);
		expect(result.app.freshness).toBe('fresh');
		expect(result.host.freshness).toBe('unavailable');
		expect(result.postgres.recentFantasyRun?.traceId).toBe('a'.repeat(32));
		expect(result.clickhouse.recentTraces).toEqual([
			{ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), startedAt: '2026-09-23T11:59:00Z', status: 'error' },
			{ traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), startedAt: '2026-09-23T11:59:00Z', status: 'success' },
		]);
		expect(result.clickhouse.gaps).toContain('trace_reference_unavailable');
		expect(JSON.stringify(result)).not.toMatch(/secret|15551234567|inputPreview|last_error|nearby-but-not-exact/);

		const failedPostgres = await readFullDeploymentEvidence(getStore, () => async () => {
			throw new Error('secret');
		}, 'league-secret', '/tmp/jamis-evidence-missing.sock', now);
		expect(failedPostgres.postgres.availability).toBe('unavailable');
		expect(failedPostgres.clickhouse.recentTraces).toHaveLength(2);
		const partial = await withSocket(JSON.stringify(valid), path => readFullDeploymentEvidence(
			getStore,
			() => async () => { throw new Error('secret'); },
			'league-secret',
			path,
			now,
		));
		expect(partial.postgres.availability).toBe('unavailable');
		expect(partial.host.freshness).toBe('fresh');
		expect(partial.docker.freshness).toBe('fresh');
		expect(partial.cloudflareTunnel.freshness).toBe('fresh');
		expect(partial.tailscale.freshness).toBe('fresh');
		expect(partial.clickhouse.freshness).toBe('fresh');
		const empty = await readFullDeploymentEvidence(async () => ({ listTracesLight: async () => ({ spans: [] }) }) as never, () => async () => [], '', '/tmp/jamis-evidence-missing.sock', now);
		expect(empty.clickhouse.gaps).toContain('no_recent_traces');
		expect(empty.postgres.gaps).toContain('fantasy_not_configured');
	});

	test('ClickHouse history follows the requested 1 to 168 hour window', async () => {
		let filters: unknown;
		const result = await readFullDeploymentEvidence(async () => ({
			listTracesLight: async (args: any) => {
				filters = args.filters;
				return { spans: [] };
			},
		}) as never, () => async () => [{ connected: 1 }], undefined, '/tmp/jamis-evidence-missing.sock', now, 72);
		expect(filters).toEqual({ startedAt: { start: new Date(now - 72 * 3_600_000), end: new Date(now) } });
		expect(result.clickhouse.scope).toBe('recent_72h');
		expect((deploymentEvidenceTool.outputSchema as unknown as z.ZodTypeAny).safeParse(result).success).toBe(true);
	});
});
