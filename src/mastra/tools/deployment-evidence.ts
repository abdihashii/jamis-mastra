import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const socketPath = '/run/jamis-evidence/probe.sock';
const utcTime = z.iso.datetime({ precision: 0 });
const freshness = z.enum(['fresh', 'stale', 'unavailable']);
const hostGaps = z.enum(['external_reachability', 'recent_host_events', 'host_probe_unavailable']);
const dockerGaps = z.enum(['external_reachability', 'service_functionality', 'docker_probe_unavailable']);
const state = z.enum(['created', 'running', 'restarting', 'exited', 'paused', 'dead', 'removing', 'missing', 'unknown']);
function container<T extends 'app' | 'postgres' | 'clickhouse' | 'cloudflared'>(component: T) {
	return z.object({ component: z.literal(component), state }).strict();
}
const hostSchema = z.object({
	component: z.literal('host'),
	source: z.literal('procfs'),
	observedAt: utcTime.nullable(),
	scope: z.literal('current'),
	availability: z.enum(['available', 'unavailable']),
	memoryAvailableMiB: z.number().int().min(0).max(1_000_000).nullable(),
	load1: z.number().min(0).max(10_000).nullable(),
	uptimeSeconds: z.number().int().min(0).max(10_000_000_000).nullable(),
	gaps: z.array(hostGaps).max(2),
}).strict();
const dockerSchema = z.object({
	component: z.literal('docker'),
	source: z.literal('docker_engine'),
	observedAt: utcTime.nullable(),
	scope: z.literal('current'),
	availability: z.enum(['available', 'unavailable']),
	containers: z.union([z.tuple([]), z.tuple([
		container('app'),
		container('postgres'),
		container('clickhouse'),
		container('cloudflared'),
	])]),
	gaps: z.array(dockerGaps).max(2),
}).strict();

type HostEvidence = z.infer<typeof hostSchema> & { freshness: z.infer<typeof freshness> };
type DockerEvidence = z.infer<typeof dockerSchema> & { freshness: z.infer<typeof freshness> };

function unavailable(): { host: HostEvidence; docker: DockerEvidence } {
	return {
		host: {
			component: 'host',
			source: 'procfs',
			observedAt: null,
			scope: 'current',
			availability: 'unavailable',
			freshness: 'unavailable',
			memoryAvailableMiB: null,
			load1: null,
			uptimeSeconds: null,
			gaps: ['host_probe_unavailable'],
		},
		docker: {
			component: 'docker',
			source: 'docker_engine',
			observedAt: null,
			scope: 'current',
			availability: 'unavailable',
			freshness: 'unavailable',
			containers: [],
			gaps: ['docker_probe_unavailable'],
		},
	};
}

function sourceFreshness(observedAt: string | null, availability: 'available' | 'unavailable', nowMs: number) {
	if (availability === 'unavailable' || !observedAt)
		return 'unavailable' as const;
	const age = nowMs - Date.parse(observedAt);
	if (!Number.isFinite(age) || age < -5_000)
		return 'unavailable' as const;
	return age > 30_000 ? 'stale' as const : 'fresh' as const;
}

export function parseDeploymentEvidence(raw: string, nowMs = Date.now()) {
	const fallback = unavailable();
	let value: unknown;
	try {
		value = JSON.parse(raw);
	}
	catch {
		return fallback;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return fallback;
	const record = value as Record<string, unknown>;
	const host = hostSchema.safeParse(record.host);
	const docker = dockerSchema.safeParse(record.docker);
	const hostValid = host.success && (host.data.availability === 'unavailable'
		? host.data.memoryAvailableMiB === null && host.data.load1 === null && host.data.uptimeSeconds === null
		: host.data.memoryAvailableMiB !== null && host.data.load1 !== null && host.data.uptimeSeconds !== null
			&& sourceFreshness(host.data.observedAt, host.data.availability, nowMs) !== 'unavailable');
	const dockerValid = docker.success && (docker.data.availability === 'unavailable'
		? docker.data.containers.length === 0
		: docker.data.containers.length === 4
			&& sourceFreshness(docker.data.observedAt, docker.data.availability, nowMs) !== 'unavailable');
	return {
		host: hostValid
			? { ...host.data, freshness: sourceFreshness(host.data.observedAt, host.data.availability, nowMs) }
			: fallback.host,
		docker: dockerValid
			? { ...docker.data, freshness: sourceFreshness(docker.data.observedAt, docker.data.availability, nowMs) }
			: fallback.docker,
	};
}

export async function readDeploymentEvidence(path = socketPath, timeoutMs = 3_000, nowMs = Date.now()) {
	if (!existsSync(path))
		return unavailable();
	const raw = await new Promise<string | null>((resolve) => {
		let socket: ReturnType<typeof connect>;
		try {
			socket = connect(path);
		}
		catch {
			resolve(null);
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		const timer = setTimeout(finish, timeoutMs, null);
		function finish(value: string | null) {
			if (settled)
				return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(value);
		}
		socket.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > 8_192)
				finish(null);
			else
				chunks.push(chunk);
		});
		socket.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
		socket.on('error', () => finish(null));
	});
	return raw === null ? unavailable() : parseDeploymentEvidence(raw, nowMs);
}

export const deploymentEvidenceTool = createTool({
	id: 'deployment-evidence',
	description: 'Read fixed current host and Docker evidence.',
	inputSchema: z.object({}).strict(),
	outputSchema: z.object({
		host: hostSchema.extend({ freshness }),
		docker: dockerSchema.extend({ freshness }),
	}).strict(),
	execute: () => readDeploymentEvidence(),
});
