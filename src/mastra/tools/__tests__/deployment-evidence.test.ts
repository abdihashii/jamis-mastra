import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { parseDeploymentEvidence, readDeploymentEvidence } from '../deployment-evidence';

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
};

async function socketResponse(response: string | null, timeoutMs = 200) {
	const dir = await mkdtemp('/tmp/jamis-evidence-');
	const path = join(dir, 'probe.sock');
	const server = createServer((socket) => {
		if (response !== null)
			socket.end(response);
	});
	await new Promise<void>(resolve => server.listen(path, resolve));
	try {
		return await readDeploymentEvidence(path, timeoutMs, now);
	}
	finally {
		server.close();
		await rm(dir, { recursive: true, force: true });
	}
}

describe('deployment evidence boundary', () => {
	test('returns fixed current evidence and classifies stale time', () => {
		const fresh = parseDeploymentEvidence(JSON.stringify(valid), now);
		expect(fresh.host.freshness).toBe('fresh');
		expect(fresh.docker.containers).toHaveLength(4);
		expect(parseDeploymentEvidence(JSON.stringify(valid), now + 31_000).host.freshness).toBe('stale');
	});

	test('rejects hostile fields per source without erasing the other source', () => {
		const hostile = {
			...valid,
			host: { ...valid.host, rawName: 'secret +15551234567' },
			docker: { ...valid.docker, containers: [...valid.docker.containers, { component: 'secret', state: 'running' }] },
			metadata: 'secret',
		};
		const result = parseDeploymentEvidence(JSON.stringify(hostile), now);
		expect(result.host.freshness).toBe('unavailable');
		expect(result.docker.freshness).toBe('unavailable');
		expect(JSON.stringify(result)).not.toMatch(/secret|15551234567|rawName|metadata/);
		const partial = parseDeploymentEvidence(JSON.stringify({ ...valid, docker: hostile.docker }), now);
		expect(partial.host.freshness).toBe('fresh');
		expect(partial.docker.freshness).toBe('unavailable');
	});

	test('connection failure, deadline, and malformed response are unavailable', async () => {
		const missing = await readDeploymentEvidence('/tmp/jamis-evidence-missing.sock', 20, now);
		expect(missing.host.freshness).toBe('unavailable');
		expect(missing.docker.freshness).toBe('unavailable');
		expect((await socketResponse(null, 20)).host.freshness).toBe('unavailable');
		expect((await socketResponse('{bad json')).docker.freshness).toBe('unavailable');
	});
});
