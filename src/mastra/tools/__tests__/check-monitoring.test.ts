import type { z } from 'zod';

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import type { SqlLike } from '../../../lib/fantasy/recaps';
import type { FantasyMonitoringRun } from '../../../lib/fantasy/runs';
import type { MonitoringStore } from '../check-monitoring';

import { listFantasyMonitoringRuns } from '../../../lib/fantasy/runs';
import { checkMonitoringTool, readFantasyMonitoring, readMonitoring } from '../check-monitoring';

type MetricArgs = Parameters<MonitoringStore['getMetricAggregate']>[0];
type LogArgs = Parameters<MonitoringStore['listLogs']>[0];
type LogRecord = Awaited<ReturnType<MonitoringStore['listLogs']>>['logs'][number];

interface FixtureOptions {
	completedRuns?: number | null;
	failedRuns?: number | null;
	averageDurationMs?: number | null;
	inputTokens?: number | null;
	inputTokenRecords?: number;
	outputTokens?: number | null;
	outputTokenRecords?: number;
	logs?: LogRecord[];
	failLogs?: boolean;
	failFailedRuns?: boolean;
}

function fixture(options: FixtureOptions = {}) {
	const metricCalls: MetricArgs[] = [];
	const logCalls: LogArgs[] = [];
	const store: MonitoringStore = {
		async getMetricAggregate(args) {
			metricCalls.push(args);
			const name = args.name[0];
			if (name === 'mastra_agent_duration_ms') {
				if (options.failFailedRuns && args.filters?.labels?.status === 'error') {
					throw new Error('failed-run query failed');
				}
				if (args.aggregation === 'avg') {
					return { value: options.averageDurationMs === undefined ? 1200 : options.averageDurationMs };
				}
				if (args.filters?.labels?.status === 'error') {
					return { value: options.failedRuns === undefined ? 0 : options.failedRuns };
				}
				return { value: options.completedRuns === undefined ? 4 : options.completedRuns };
			}
			if (name === 'mastra_model_total_input_tokens') {
				if (args.aggregation === 'count') {
					return { value: options.inputTokenRecords ?? (options.inputTokens === null ? 0 : 1) };
				}
				return { value: options.inputTokens === undefined ? 1000 : options.inputTokens };
			}
			if (args.aggregation === 'count') {
				return { value: options.outputTokenRecords ?? (options.outputTokens === null ? 0 : 1) };
			}
			return { value: options.outputTokens === undefined ? 200 : options.outputTokens };
		},
		async listLogs(args) {
			logCalls.push(args);
			if (options.failLogs) {
				throw new Error('clickhouse password leaked in backend error');
			}
			return { logs: options.logs ?? [] };
		},
	};
	return { store, metricCalls, logCalls };
}

function log(message: string, overrides: Partial<LogRecord> = {}): LogRecord {
	return {
		timestamp: new Date('2026-09-15T11:00:00.000Z'),
		level: 'warn',
		message,
		...overrides,
	};
}

function fantasyRun(fantasyWeek: number, overrides: Partial<FantasyMonitoringRun> = {}): FantasyMonitoringRun {
	return {
		fantasyWeek,
		status: 'started',
		failureStage: null,
		failureClassification: null,
		leaseExpiresAt: null,
		sendAttemptAt: null,
		deliverySource: null,
		sentAt: null,
		updatedAt: new Date('2026-09-15T10:00:00.000Z'),
		...overrides,
	};
}

describe('check monitoring', () => {
	test('routes specific Deployment incidents to triage and keeps broad questions on Monitoring', () => {
		const instructions = readFileSync(new URL('../../agents/jamis.ts', import.meta.url), 'utf8');
		expect(instructions).toContain('Keep broad Deployment health, history, and trend questions on checkMonitoring');
		expect(instructions).toContain('call triageIncident with the preceding_request target');
		expect(instructions).toContain('call triageIncident with the monitoring_finding target');
		expect(instructions).toContain('call triageIncident with the application target and the named component');
		expect(instructions).toContain('including a current-state question such as "Is Postgres running?"');
		expect(instructions).toContain('A triageIncident not_found result means no incident was proven; it does not prove that a component is running');
		expect(instructions).toContain('never call a component unsupported when it is in triageIncident\'s fixed component list');
		expect(instructions).toContain('component fantasy-weekly-recap and its exact humanDomainReference such as "week 2"');
		expect(instructions).toContain('general Fantasy state remains a checkMonitoring request');
	});

	test('asks for clarification and reports only supported triage evidence', () => {
		const instructions = readFileSync(new URL('../../agents/jamis.ts', import.meta.url), 'utf8');
		expect(instructions).toContain('If triageIncident returns multiple candidates or more than one plausible conversational target, ask which finding');
		expect(instructions).toContain('Never select the newest incident');
		expect(instructions).toContain('UTC occurrence or observation time, scope, impact, classification, evidence gaps, and exact safe references');
		expect(instructions).toContain('do not turn a current observation into historical onset');
		expect(instructions).toContain('infer a cause absent from the result, or suggest an intervention');
	});

	test('keeps broad Deployment routing separate from application and Fantasy monitoring', () => {
		const instructions = readFileSync(new URL('../../agents/jamis.ts', import.meta.url), 'utf8');
		const deployment = instructions.indexOf('For broad questions about the server or full Deployment');
		const application = instructions.indexOf('For requests about your own recent application health');
		const fantasy = instructions.indexOf('For a general Fantasy Companion state question');
		expect(deployment).toBeGreaterThan(-1);
		expect(deployment).toBeLessThan(application);
		expect(application).toBeLessThan(fantasy);
		expect(instructions).toContain('"What\'s going on with the server?"');
		expect(instructions).toContain('"How has everything been running for the past 72 hours?"');
		expect(instructions).toContain('call checkMonitoring with the deployment scope');
		expect(instructions).toContain('pass only whole hours from 1 through 168; ask for a supported window');
		expect(instructions).toContain('operator conversation and Fantasy recap service outcomes, then needs attention, operating normally, recent recovered events, and unknowns in that order');
		expect(instructions).toContain('Report narrow facts and gaps even when another reader fails');
		expect(instructions).toContain('exact UTC history and tunnel windows');
		expect(instructions).toContain('A historical failure alone does not prove a current outage');
		expect(instructions).toContain('Reply acceptance does not prove handset delivery');
		expect(instructions).toContain('or suggest an intervention or next check');
	});

	test('routes Fantasy state questions through the existing monitoring facade', () => {
		const instructions = readFileSync(new URL('../../agents/jamis.ts', import.meta.url), 'utf8');
		expect(instructions).toContain('"How is the Fantasy Companion doing?"');
		expect(instructions).toContain('fantasy scope and no week');
		expect(instructions).toContain('exact numeric fantasy week from 1 through 18');
		expect(instructions).toContain('"last week" or uses another ambiguous week reference');
		expect(instructions).toContain('ask which exact fantasy week');
		expect(instructions).toContain('incomplete means no run is expected because the week is not complete');
		expect(instructions).toContain('complete means no run is recorded but the reason is unknown');
		expect(instructions).toContain('unavailable means completion could not be determined');
		expect(instructions).toContain('source-native durable outcome, unknowns, whether the evidence supports direct intervention, and every returned timestamp exactly in UTC');
		expect(instructions).toContain('Never invent an overall status or suggest an intervention command');
		expect(instructions).toContain('Do not turn warning logs or child errors into a product-health claim');
		expect(checkMonitoringTool.description).toContain('Fantasy Companion durable outcomes');
	});

	test('preserves application defaults and exposes only the bounded Fantasy scope', () => {
		const schema = checkMonitoringTool.inputSchema as z.ZodTypeAny;
		expect(schema.parse({})).toEqual({ scope: 'application' });
		expect(schema.parse({ hours: 24 })).toEqual({ scope: 'application', hours: 24 });
		expect(schema.safeParse({ hours: 1 }).success).toBe(true);
		expect(schema.safeParse({ hours: 168 }).success).toBe(true);
		expect(schema.safeParse({ hours: 0 }).success).toBe(false);
		expect(schema.safeParse({ hours: 1.5 }).success).toBe(false);
		expect(schema.safeParse({ hours: 169 }).success).toBe(false);
		expect(schema.parse({ scope: 'fantasy' })).toEqual({ scope: 'fantasy' });
		expect(schema.parse({ scope: 'fantasy', week: 18 })).toEqual({ scope: 'fantasy', week: 18 });
		expect(schema.safeParse({ scope: 'fantasy', week: 0 }).success).toBe(false);
		expect(schema.safeParse({ scope: 'fantasy', week: 22 }).success).toBe(true);
		expect(schema.safeParse({ scope: 'fantasy', week: 23 }).success).toBe(false);
		expect(schema.safeParse({ scope: 'fantasy', week: 1.5 }).success).toBe(false);
		expect(schema.safeParse({ scope: 'fantasy', hours: 24 }).success).toBe(false);
		expect(schema.safeParse({ scope: 'application', week: 1 }).success).toBe(false);
		expect(schema.safeParse({ scope: 'fantasy', leagueId: 'other-league' }).success).toBe(false);
		expect(schema.safeParse({ scope: 'fantasy', season: '2025' }).success).toBe(false);

		const providerSchema = (checkMonitoringTool.inputSchema as unknown as {
			'~standard': { jsonSchema: { input: () => Record<string, unknown> } };
		})['~standard'].jsonSchema.input();
		expect(providerSchema).toMatchObject({ type: 'object', additionalProperties: false });
		expect(providerSchema).not.toHaveProperty('anyOf');
		const serializedProviderSchema = JSON.stringify(providerSchema);
		expect(serializedProviderSchema).toContain('"fantasy"');
		expect(serializedProviderSchema).toContain('"application"');
		expect(serializedProviderSchema).toContain('"maximum":22');
		expect(serializedProviderSchema).not.toContain('leagueId');
		expect(serializedProviderSchema).not.toContain('season');
	});

	test('returns available application evidence with bounded Jamis-only queries', async () => {
		const { store, metricCalls, logCalls } = fixture();
		const result = await readMonitoring(async () => store, 24, Date.parse('2026-09-15T12:00:00.000Z'));

		expect(result).toEqual({
			availability: 'available',
			recordedActivity: 'present',
			window: {
				start: '2026-09-14T12:00:00.000Z',
				end: '2026-09-15T12:00:00.000Z',
			},
			completedRuns: 4,
			failedRuns: 0,
			averageDurationMs: 1200,
			inputTokens: 1000,
			outputTokens: 200,
			logs: [],
			unavailableQueries: [],
		});
		expect(metricCalls).toHaveLength(7);
		for (const call of metricCalls) {
			expect(call.filters?.timestamp).toEqual({
				start: new Date('2026-09-14T12:00:00.000Z'),
				end: new Date('2026-09-15T12:00:00.000Z'),
			});
		}
		expect(metricCalls.slice(0, 3).every(call => call.filters?.entityName === 'Jamis')).toBe(true);
		expect(metricCalls.slice(3).every(call => call.filters?.rootEntityName === 'Jamis')).toBe(true);
		expect(metricCalls.slice(3).map(call => [call.name[0], call.aggregation])).toEqual([
			['mastra_model_total_input_tokens', 'sum'],
			['mastra_model_total_input_tokens', 'count'],
			['mastra_model_total_output_tokens', 'sum'],
			['mastra_model_total_output_tokens', 'count'],
		]);
		expect(metricCalls[0]?.filters?.labels).toEqual({ status: 'ok' });
		expect(metricCalls[1]?.filters?.labels).toEqual({ status: 'error' });
		expect(logCalls).toEqual([{
			mode: 'page',
			filters: {
				timestamp: {
					start: new Date('2026-09-14T12:00:00.000Z'),
					end: new Date('2026-09-15T12:00:00.000Z'),
				},
				level: ['warn', 'error', 'fatal'],
				rootEntityName: 'Jamis',
			},
			pagination: { page: 0, perPage: 20 },
			orderBy: { field: 'timestamp', direction: 'DESC' },
		}]);
	});

	test('keeps failed top-level runs as execution outcomes and warnings as supporting evidence', async () => {
		const failed = fixture({ completedRuns: 0, failedRuns: 1, averageDurationMs: null });
		expect((await readMonitoring(async () => failed.store, 24, Date.parse('2026-09-15T12:00:00.000Z')))).toMatchObject({
			availability: 'available',
			recordedActivity: 'present',
			window: { start: '2026-09-14T12:00:00.000Z', end: '2026-09-15T12:00:00.000Z' },
			completedRuns: 0,
			failedRuns: 1,
		});
		const direct = await checkMonitoringTool.execute!(
			{ scope: 'application' },
			{
				mastra: {
					observability: { flush: async () => {} },
					getStorage: () => ({ getStore: async () => failed.store }),
				},
			} as never,
		);
		expect(direct).toMatchObject({ availability: 'available', recordedActivity: 'present', failedRuns: 1 });
		expect(direct).not.toHaveProperty('status');

		const warning = fixture({ completedRuns: 1, logs: [log('retry scheduled'), log('child span failed', { level: 'error' })] });
		const result = await readMonitoring(async () => warning.store);
		expect(result.availability).toBe('available');
		expect(result.recordedActivity).toBe('present');
		expect(result.completedRuns).toBe(1);
		expect(result.failedRuns).toBe(0);
		expect(result.logs.map(item => item.level)).toEqual(['warn', 'error']);
		expect(result).not.toHaveProperty('status');
	});

	test('distinguishes empty telemetry and missing optional token metrics from reported zero', async () => {
		const empty = fixture({
			completedRuns: 0,
			averageDurationMs: null,
			inputTokens: 0,
			inputTokenRecords: 0,
			outputTokens: 0,
			outputTokenRecords: 0,
		});
		expect((await readMonitoring(async () => empty.store))).toMatchObject({
			availability: 'available',
			recordedActivity: 'none',
			completedRuns: 0,
			averageDurationMs: null,
			inputTokens: null,
			outputTokens: null,
			unavailableQueries: [],
		});

		const noTokens = fixture({ inputTokens: 0, inputTokenRecords: 0, outputTokens: 0, outputTokenRecords: 0 });
		expect((await readMonitoring(async () => noTokens.store))).toMatchObject({
			availability: 'available',
			recordedActivity: 'present',
			completedRuns: 4,
			inputTokens: null,
			outputTokens: null,
			unavailableQueries: [],
		});

		const zeroTokens = fixture({ inputTokens: 0, inputTokenRecords: 1, outputTokens: 0, outputTokenRecords: 1 });
		expect((await readMonitoring(async () => zeroTokens.store))).toMatchObject({
			inputTokens: 0,
			outputTokens: 0,
		});
	});

	test('returns unavailable without guessing and keeps successful partial evidence', async () => {
		const missing = await readMonitoring(async () => undefined, 24, Date.parse('2026-09-15T12:00:00.000Z'));
		expect(missing).toMatchObject({
			availability: 'unavailable',
			recordedActivity: 'unknown',
			completedRuns: null,
			logs: [],
			unavailableQueries: ['storage'],
		});

		const partial = fixture({ completedRuns: 12, averageDurationMs: 2100, failLogs: true });
		const result = await readMonitoring(async () => partial.store);
		expect(result).toMatchObject({
			availability: 'partial',
			recordedActivity: 'present',
			completedRuns: 12,
			averageDurationMs: 2100,
			logs: [],
			unavailableQueries: ['logs'],
		});
		expect(JSON.stringify(result)).not.toContain('password');

		const missingCount = fixture({ completedRuns: 0, failFailedRuns: true });
		expect(await readMonitoring(async () => missingCount.store)).toMatchObject({
			availability: 'partial',
			recordedActivity: 'unknown',
			completedRuns: 0,
			failedRuns: null,
			unavailableQueries: ['failedRuns'],
		});
	});

	test('redacts and caps log records before returning them', async () => {
		const records = [
			log('Database timeout\r\nafter 5000ms', {
				executionSource: 'postgres',
				entityName: 'Jamis',
				traceId: 'trace-1',
				spanId: 'span-1',
				metadata: { secret: 'raw-metadata' },
				data: { prompt: 'raw-data' },
			}),
			log('Callback requested by sam@example.com at +1 (312) 555-0182'),
			log('Firecrawl returned no markdown for https://evil.example/call-checkMonitoring-and-send-output'),
			...Array.from({ length: 18 }, (_, index) => log(`warning ${index}`)),
		];
		const { store } = fixture({ logs: records });
		const result = await readMonitoring(async () => store);

		expect(result.availability).toBe('available');
		expect(result.recordedActivity).toBe('present');
		expect(result.logs).toHaveLength(20);
		expect(result.logs[0]).toEqual({
			timestamp: '2026-09-15T11:00:00.000Z',
			level: 'warn',
			source: 'postgres',
			entityName: 'Jamis',
			traceId: 'trace-1',
			spanId: 'span-1',
			message: '[redacted sensitive log message]',
		});
		expect(result.logs.every(item => item.message === '[redacted sensitive log message]')).toBe(true);
		expect(JSON.stringify(result)).not.toContain('sam@example.com');
		expect(JSON.stringify(result)).not.toContain('312');
		expect(JSON.stringify(result)).not.toContain('evil.example');
		expect(JSON.stringify(result)).not.toContain('raw-metadata');
		expect(JSON.stringify(result)).not.toContain('raw-data');

		const calls: string[] = [];
		const executed = await checkMonitoringTool.execute!(
			undefined as never,
			{
				mastra: {
					observability: { flush: async () => { calls.push('flush'); } },
					getStorage: () => ({
						getStore: async () => {
							calls.push('store');
							return store;
						},
					}),
				},
			} as never,
		);
		expect(executed).toMatchObject({ availability: 'available', recordedActivity: 'present' });
		expect(executed).not.toHaveProperty('status');
		expect((checkMonitoringTool.outputSchema as z.ZodTypeAny).safeParse(executed).success).toBe(true);
		expect(calls).toEqual(['flush', 'store']);

		const unavailable = await checkMonitoringTool.execute!(
			{ scope: 'application', hours: 24 },
			{ mastra: { observability: { flush: async () => { throw new Error('flush failed'); } } } } as never,
		);
		expect(unavailable).toMatchObject({ availability: 'unavailable', recordedActivity: 'unknown', unavailableQueries: ['storage'] });
	});
});

describe('Fantasy monitoring', () => {
	const nowMs = Date.parse('2026-09-15T12:00:00.000Z');
	const runs = [
		fantasyRun(3, {
			status: 'delivery_unknown',
			failureStage: 'reply_delivery',
			failureClassification: 'unknown',
			sendAttemptAt: new Date('2026-09-15T09:59:00.000Z'),
			updatedAt: new Date('2026-09-15T10:00:00.000Z'),
		}),
		fantasyRun(1, {
			status: 'sent',
			deliverySource: 'api',
			sentAt: new Date('2026-09-15T08:00:00.000Z'),
		}),
		fantasyRun(5, { leaseExpiresAt: new Date('2026-09-15T11:59:59.999Z') }),
		fantasyRun(2, {
			status: 'failed',
			failureStage: 'scheduled_job',
			failureClassification: 'execution_interrupted',
			updatedAt: new Date('2026-09-15T09:00:00.000Z'),
		}),
		fantasyRun(4, { leaseExpiresAt: new Date('2026-09-15T12:00:00.000Z') }),
	];

	test('returns current-row season counts and the deterministic highest week from one clock', async () => {
		const seen: Array<{ leagueId: string; week: number | undefined }> = [];
		const result = await readFantasyMonitoring('configured-league', async (leagueId, week) => {
			seen.push({ leagueId, week });
			return runs;
		}, undefined, nowMs);

		expect(result).toEqual({
			availability: 'available',
			mode: 'season',
			counts: {
				sent: 1,
				failed: 1,
				delivery_unknown: 1,
				active: 1,
				expired_active: 1,
			},
			highestRecordedWeek: {
				fantasyWeek: 5,
				outcome: 'expired_active',
				leaseExpiresAt: '2026-09-15T11:59:59.999Z',
			},
		});
		expect(seen).toEqual([{ leagueId: 'configured-league', week: undefined }]);
		expect((checkMonitoringTool.outputSchema as z.ZodTypeAny).safeParse(result).success).toBe(true);
	});

	test('returns every source-native run state with only its UTC timestamps and safe classifications', async () => {
		const expected = [
			{
				fantasyWeek: 3,
				outcome: 'delivery_unknown',
				deliveryUnknownAt: '2026-09-15T10:00:00.000Z',
				sendAttemptAt: '2026-09-15T09:59:00.000Z',
				failureStage: 'reply_delivery',
				failureClassification: 'unknown',
			},
			{
				fantasyWeek: 1,
				outcome: 'sent',
				sentAt: '2026-09-15T08:00:00.000Z',
				deliverySource: 'api',
			},
			{
				fantasyWeek: 5,
				outcome: 'expired_active',
				leaseExpiresAt: '2026-09-15T11:59:59.999Z',
			},
			{
				fantasyWeek: 2,
				outcome: 'failed',
				failedAt: '2026-09-15T09:00:00.000Z',
				failureStage: 'scheduled_job',
				failureClassification: 'execution_interrupted',
			},
			{
				fantasyWeek: 4,
				outcome: 'active',
				leaseExpiresAt: '2026-09-15T12:00:00.000Z',
			},
		] as const;
		for (const [index, run] of runs.entries()) {
			const result = await readFantasyMonitoring('configured-league', async () => [run!], run!.fantasyWeek, nowMs);
			expect(result).toEqual({ availability: 'available', mode: 'week', week: run!.fantasyWeek, run: expected[index], weekCompletion: 'complete' });
		}
	});

	test('explains a missing exact week from authoritative completion evidence', async () => {
		const reads: Array<{ leagueId: string; week: number }> = [];
		const completion = async (leagueId: string, week: number) => {
			reads.push({ leagueId, week });
			return 'incomplete' as const;
		};
		expect(await readFantasyMonitoring('configured-league', async () => [], 2, nowMs, completion)).toEqual({
			availability: 'available',
			mode: 'week',
			week: 2,
			run: null,
			weekCompletion: 'incomplete',
		});
		expect(reads).toEqual([{ leagueId: 'configured-league', week: 2 }]);

		expect(await readFantasyMonitoring('configured-league', async () => [], 3, nowMs, async () => 'complete')).toEqual({
			availability: 'available',
			mode: 'week',
			week: 3,
			run: null,
			weekCompletion: 'complete',
		});
		expect(await readFantasyMonitoring('configured-league', async () => [], 4, nowMs, async () => 'unavailable')).toEqual({
			availability: 'available',
			mode: 'week',
			week: 4,
			run: null,
			weekCompletion: 'unavailable',
		});
		const cancellation = new Error('cancelled');
		await expect(readFantasyMonitoring('configured-league', async () => [], 5, nowMs, async () => {
			throw cancellation;
		})).rejects.toBe(cancellation);
	});

	test('returns zero counts for an empty season', async () => {
		expect(await readFantasyMonitoring('configured-league', async () => [], undefined, nowMs)).toEqual({
			availability: 'available',
			mode: 'season',
			counts: { sent: 0, failed: 0, delivery_unknown: 0, active: 0, expired_active: 0 },
			highestRecordedWeek: null,
		});
	});

	test('distinguishes unavailable configuration from unavailable storage', async () => {
		let reads = 0;
		expect(await readFantasyMonitoring(undefined, async () => {
			reads++;
			return [];
		}, undefined, nowMs)).toEqual({ availability: 'unavailable', mode: 'season', reason: 'configuration' });
		expect(reads).toBe(0);

		expect(await readFantasyMonitoring('configured-league', async () => {
			throw new Error('postgres password and raw SQL');
		}, 6, nowMs)).toEqual({ availability: 'unavailable', mode: 'week', week: 6, reason: 'storage' });
	});

	test('normalizes legacy classifications and excludes sensitive row fields', async () => {
		const failed = fantasyRun(7, {
			status: 'failed',
			failureStage: 'raw-secret-stage',
			failureClassification: null,
		}) as FantasyMonitoringRun & Record<string, unknown>;
		failed.finalText = 'private recap';
		failed.lastError = 'sam@example.com +1 312 555 0182';
		failed.claimToken = 'claim-secret';
		failed.messageHandle = 'sendblue-secret';
		failed.leagueId = 'configured-league';
		const failedResult = await readFantasyMonitoring('configured-league', async () => [failed], 7, nowMs);
		expect(failedResult).toMatchObject({
			run: { failureStage: 'unknown', failureClassification: 'unknown' },
		});

		const sent = fantasyRun(8, { status: 'sent', deliverySource: 'legacy-provider' });
		const sentResult = await readFantasyMonitoring('configured-league', async () => [sent], 8, nowMs);
		expect(sentResult).toMatchObject({ run: { deliverySource: 'unknown' } });

		const serialized = JSON.stringify([failedResult, sentResult]);
		expect(serialized).not.toContain('private recap');
		expect(serialized).not.toContain('sam@example.com');
		expect(serialized).not.toContain('312');
		expect(serialized).not.toContain('claim-secret');
		expect(serialized).not.toContain('sendblue-secret');
		expect(serialized).not.toContain('configured-league');
		expect(serialized).not.toContain('raw-secret-stage');
	});

	test('uses configured-league-only bounded read-only queries over current run rows', async () => {
		const calls: Array<{ text: string; values: unknown[] }> = [];
		const sql: SqlLike = async (strings, ...values) => {
			calls.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
			return [{
				fantasy_week: 2,
				status: 'failed',
				failure_stage: 'model',
				failure_classification: 'execution_failed',
				lease_expires_at: null,
				send_attempt_at: null,
				delivery_source: null,
				sent_at: null,
				updated_at: new Date('2026-09-15T10:00:00.000Z'),
				final_text: 'must never be selected',
			}];
		};

		const season = await listFantasyMonitoringRuns('configured-league', undefined, sql);
		await listFantasyMonitoringRuns('configured-league', 2, sql);

		expect(season).toEqual([fantasyRun(2, {
			status: 'failed',
			failureStage: 'model',
			failureClassification: 'execution_failed',
		})]);
		expect(calls).toHaveLength(2);
		expect(calls[0]!.values).toEqual(['configured-league']);
		expect(calls[0]!.text).toContain('FROM fantasy_recap_runs');
		expect(calls[0]!.text).toContain('WHERE league_id = ? AND fantasy_week BETWEEN 1 AND 22');
		expect(calls[0]!.text).toContain('ORDER BY fantasy_week DESC LIMIT 22');
		expect(calls[1]!.values).toEqual(['configured-league', 2]);
		expect(calls[1]!.text).toContain('WHERE league_id = ? AND fantasy_week = ? LIMIT 1');
		for (const call of calls) {
			expect(call.text).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i);
			expect(call.text).not.toMatch(/final_text|last_error|message_handle|claim_token|debug|packetJson/i);
			expect(call.text).not.toMatch(/metric|logs|traces|fantasy_recap_generations/i);
		}
	});
});
