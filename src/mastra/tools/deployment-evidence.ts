import type { ObservabilityStorage } from '@mastra/core/storage';
import type { SqlLike } from '../../fantasy/recaps';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import process from 'node:process';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getFantasyConfig } from '../../fantasy/config';
import { getFantasySql } from '../../fantasy/recaps';

const socketPath = '/run/jamis-evidence/probe.sock';
const utcTime = z.iso.datetime({ precision: 0 });
const utcSeconds = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;
const freshness = z.enum(['fresh', 'stale', 'unavailable']);
const hostGaps = z.enum(['external_reachability', 'recent_host_events', 'host_probe_unavailable']);
const dockerGaps = z.enum(['external_reachability', 'service_functionality', 'docker_probe_unavailable']);
const tunnelGaps = z.enum(['external_reachability', 'recent_tunnel_diagnostics_unavailable', 'tunnel_probe_unavailable']);
const tailscaleGaps = z.enum(['operator_device_reachability', 'tailscale_status_unavailable', 'tailscale_probe_unavailable']);
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
const tunnelSchema = z.object({
	component: z.literal('cloudflare_tunnel'),
	source: z.literal('local_cloudflared'),
	observedAt: utcTime.nullable(),
	scope: z.literal('current_and_recent_5m'),
	availability: z.enum(['available', 'unavailable']),
	containerState: state,
	recentDiagnostic: z.enum(['connection_registered', 'local_error', 'none_observed', 'unknown']),
	gaps: z.array(tunnelGaps).max(2),
}).strict();
const tailscaleSchema = z.object({
	component: z.literal('tailscale'),
	source: z.literal('local_tailscale'),
	observedAt: utcTime.nullable(),
	scope: z.literal('current'),
	availability: z.enum(['available', 'unavailable']),
	serviceState: z.enum(['active', 'inactive', 'failed', 'activating', 'deactivating', 'unknown']),
	backendState: z.enum(['Running', 'Starting', 'Stopped', 'NeedsLogin', 'NeedsMachineAuth', 'unknown']),
	gaps: z.array(tailscaleGaps).max(2),
}).strict();
const traceId = z.string().regex(/^[a-f0-9]{32}$/);
const spanId = z.string().regex(/^[a-f0-9]{16}$/);
const fantasyRunSchema = z.object({
	week: z.number().int().min(1).max(18),
	status: z.enum(['started', 'sent', 'failed', 'delivery_unknown']),
	updatedAt: utcTime,
	traceId: traceId.nullable(),
}).strict();
const postgresSchema = z.object({
	component: z.literal('postgres'),
	source: z.literal('postgres_sql'),
	observedAt: utcTime.nullable(),
	scope: z.literal('current_and_configured_fantasy_season'),
	availability: z.enum(['available', 'unavailable']),
	freshness,
	recentFantasyRun: fantasyRunSchema.nullable(),
	gaps: z.array(z.enum(['postgres_query_unavailable', 'fantasy_not_configured', 'fantasy_runs_unavailable', 'no_fantasy_runs', 'trace_reference_missing'])).max(2),
}).strict();
const clickhouseTraceSchema = z.object({
	traceId,
	spanId,
	startedAt: utcTime,
	status: z.enum(['success', 'error', 'running', 'unknown']),
}).strict();
const clickhouseSchema = z.object({
	component: z.literal('clickhouse'),
	source: z.literal('mastra_observability'),
	observedAt: utcTime.nullable(),
	scope: z.literal('recent_24h'),
	availability: z.enum(['available', 'unavailable']),
	freshness,
	recentTraces: z.array(clickhouseTraceSchema).max(3),
	gaps: z.array(z.enum(['clickhouse_query_unavailable', 'no_recent_traces', 'trace_reference_unavailable', 'product_outcomes_unchecked'])).max(2),
}).strict();
const appSchema = z.object({
	component: z.literal('app'),
	source: z.literal('current_process'),
	observedAt: utcTime,
	scope: z.literal('current_instance'),
	availability: z.literal('available'),
	freshness: z.literal('fresh'),
	uptimeSeconds: z.number().int().min(0).max(10_000_000_000),
	gaps: z.tuple([z.literal('external_reachability'), z.literal('product_outcomes_unchecked')]),
}).strict();

interface ContextEvidence { freshness: z.infer<typeof freshness>; correlation: 'uncorrelated_context' }
type HostEvidence = z.infer<typeof hostSchema> & ContextEvidence;
type DockerEvidence = z.infer<typeof dockerSchema> & ContextEvidence;
type TunnelEvidence = z.infer<typeof tunnelSchema> & ContextEvidence;
type TailscaleEvidence = z.infer<typeof tailscaleSchema> & ContextEvidence;

function unavailable(): { host: HostEvidence; docker: DockerEvidence; cloudflareTunnel: TunnelEvidence; tailscale: TailscaleEvidence } {
	return {
		host: {
			component: 'host',
			source: 'procfs',
			observedAt: null,
			scope: 'current',
			correlation: 'uncorrelated_context',
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
			correlation: 'uncorrelated_context',
			availability: 'unavailable',
			freshness: 'unavailable',
			containers: [],
			gaps: ['docker_probe_unavailable'],
		},
		cloudflareTunnel: {
			component: 'cloudflare_tunnel',
			source: 'local_cloudflared',
			observedAt: null,
			scope: 'current_and_recent_5m',
			correlation: 'uncorrelated_context',
			availability: 'unavailable',
			freshness: 'unavailable',
			containerState: 'unknown',
			recentDiagnostic: 'unknown',
			gaps: ['tunnel_probe_unavailable'],
		},
		tailscale: {
			component: 'tailscale',
			source: 'local_tailscale',
			observedAt: null,
			scope: 'current',
			correlation: 'uncorrelated_context',
			availability: 'unavailable',
			freshness: 'unavailable',
			serviceState: 'unknown',
			backendState: 'unknown',
			gaps: ['tailscale_probe_unavailable'],
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
	const tunnel = tunnelSchema.safeParse(record.cloudflareTunnel);
	const tailscale = tailscaleSchema.safeParse(record.tailscale);
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
			? { ...host.data, correlation: 'uncorrelated_context' as const, freshness: sourceFreshness(host.data.observedAt, host.data.availability, nowMs) }
			: fallback.host,
		docker: dockerValid
			? { ...docker.data, correlation: 'uncorrelated_context' as const, freshness: sourceFreshness(docker.data.observedAt, docker.data.availability, nowMs) }
			: fallback.docker,
		cloudflareTunnel: tunnel.success && sourceFreshness(tunnel.data.observedAt, tunnel.data.availability, nowMs) !== 'unavailable'
			? { ...tunnel.data, correlation: 'uncorrelated_context' as const, freshness: sourceFreshness(tunnel.data.observedAt, tunnel.data.availability, nowMs) }
			: fallback.cloudflareTunnel,
		tailscale: tailscale.success && sourceFreshness(tailscale.data.observedAt, tailscale.data.availability, nowMs) !== 'unavailable'
			? { ...tailscale.data, correlation: 'uncorrelated_context' as const, freshness: sourceFreshness(tailscale.data.observedAt, tailscale.data.availability, nowMs) }
			: fallback.tailscale,
	};
}

export async function readDeploymentEvidence(path = socketPath, timeoutMs = 10_000, nowMs = Date.now()) {
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

function deadline<T>(read: () => Promise<T>, fallback: T): Promise<T> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, 3_000, fallback);
		Promise.resolve().then(read).then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(fallback);
			},
		);
	});
}

async function readPostgres(sqlFactory: () => SqlLike, leagueId: string | undefined, nowMs: number) {
	const unavailable: z.infer<typeof postgresSchema> = {
		component: 'postgres',
		source: 'postgres_sql',
		observedAt: null,
		scope: 'current_and_configured_fantasy_season',
		availability: 'unavailable',
		freshness: 'unavailable',
		recentFantasyRun: null,
		gaps: ['postgres_query_unavailable'],
	};
	return await deadline(async () => {
		const sql = sqlFactory();
		await sql`SELECT 1 AS connected`;
		const result: z.infer<typeof postgresSchema> = {
			...unavailable,
			observedAt: utcSeconds(new Date(nowMs)),
			availability: 'available',
			freshness: 'fresh',
			gaps: leagueId ? ['no_fantasy_runs'] : ['fantasy_not_configured'],
		};
		if (!leagueId)
			return result;
		try {
			const rows = await sql`
				SELECT fantasy_week, status, latest_attempt_trace_id, updated_at
				FROM fantasy_recap_runs WHERE league_id = ${leagueId} AND fantasy_week BETWEEN 1 AND 18
				ORDER BY fantasy_week DESC LIMIT 1
			`;
			const row = rows[0] as Record<string, unknown> | undefined;
			if (!row)
				return result;
			const updatedAt = row.updated_at instanceof Date ? utcSeconds(row.updated_at) : null;
			const parsed = fantasyRunSchema.safeParse({
				week: row.fantasy_week,
				status: row.status,
				updatedAt,
				traceId: traceId.safeParse(row.latest_attempt_trace_id).success ? row.latest_attempt_trace_id : null,
			});
			if (!parsed.success) {
				result.gaps = ['fantasy_runs_unavailable'];
				return result;
			}
			result.recentFantasyRun = parsed.data;
			result.gaps = parsed.data.traceId ? [] : ['trace_reference_missing'];
		}
		catch {
			result.gaps = ['fantasy_runs_unavailable'];
		}
		return result;
	}, unavailable);
}

type TraceStore = Pick<ObservabilityStorage, 'listTracesLight'>;

async function readClickHouse(getStore: () => Promise<TraceStore | undefined>, nowMs: number) {
	const unavailable: z.infer<typeof clickhouseSchema> = {
		component: 'clickhouse',
		source: 'mastra_observability',
		observedAt: null,
		scope: 'recent_24h',
		availability: 'unavailable',
		freshness: 'unavailable',
		recentTraces: [],
		gaps: ['clickhouse_query_unavailable'],
	};
	return await deadline(async () => {
		const store = await getStore();
		if (!store)
			return unavailable;
		const response = await store.listTracesLight({
			filters: { startedAt: { start: new Date(nowMs - 86_400_000), end: new Date(nowMs) } },
			pagination: { page: 0, perPage: 3 },
			orderBy: { field: 'startedAt', direction: 'DESC' },
		});
		const recentTraces = response.spans.slice(0, 3).map(row => clickhouseTraceSchema.safeParse({
			traceId: row.traceId,
			spanId: row.spanId,
			startedAt: row.startedAt instanceof Date ? utcSeconds(row.startedAt) : null,
			status: row.status ?? 'unknown',
		}));
		return {
			...unavailable,
			observedAt: utcSeconds(new Date(nowMs)),
			availability: 'available' as const,
			freshness: 'fresh' as const,
			recentTraces: recentTraces.filter(result => result.success).map(result => result.data),
			gaps: [recentTraces.length === 0 ? 'no_recent_traces' : recentTraces.some(result => !result.success) ? 'trace_reference_unavailable' : 'product_outcomes_unchecked'],
		} satisfies z.infer<typeof clickhouseSchema>;
	}, unavailable);
}

export async function readFullDeploymentEvidence(
	getStore: () => Promise<TraceStore | undefined>,
	sqlFactory: () => SqlLike = getFantasySql,
	leagueId = getFantasyConfig()?.sleeperLeagueId,
	path = socketPath,
	nowMs = Date.now(),
) {
	const [hostEvidence, postgres, clickhouse] = await Promise.all([
		readDeploymentEvidence(path, 10_000, nowMs),
		readPostgres(sqlFactory, leagueId, nowMs),
		readClickHouse(getStore, nowMs),
	]);
	return {
		...hostEvidence,
		app: {
			component: 'app' as const,
			source: 'current_process' as const,
			observedAt: utcSeconds(new Date(nowMs)),
			scope: 'current_instance' as const,
			availability: 'available' as const,
			freshness: 'fresh' as const,
			uptimeSeconds: Math.min(10_000_000_000, Math.floor(process.uptime())),
			gaps: ['external_reachability', 'product_outcomes_unchecked'] as ['external_reachability', 'product_outcomes_unchecked'],
		},
		postgres,
		clickhouse,
	};
}

export const deploymentEvidenceTool = createTool({
	id: 'deployment-evidence',
	description: 'Read fixed, source-owned Deployment evidence.',
	inputSchema: z.object({}).strict(),
	outputSchema: z.object({
		host: hostSchema.extend({ freshness, correlation: z.literal('uncorrelated_context') }),
		docker: dockerSchema.extend({ freshness, correlation: z.literal('uncorrelated_context') }),
		cloudflareTunnel: tunnelSchema.extend({ freshness, correlation: z.literal('uncorrelated_context') }),
		tailscale: tailscaleSchema.extend({ freshness, correlation: z.literal('uncorrelated_context') }),
		app: appSchema,
		postgres: postgresSchema,
		clickhouse: clickhouseSchema,
	}).strict(),
	execute: (_input, context) => readFullDeploymentEvidence(
		async () => await context.mastra?.getStorage()?.getStore('observability'),
	),
});
