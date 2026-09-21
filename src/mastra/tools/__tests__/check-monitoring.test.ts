import type { z } from 'zod';
import type { SqlLike } from '../../../fantasy/recaps';
import type { FantasyMonitoringRun } from '../../../fantasy/runs';
import type { MonitoringStore } from '../check-monitoring';

import { describe, expect, test } from 'bun:test';

import { listFantasyMonitoringRuns } from '../../../fantasy/runs';
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
}

function fixture(options: FixtureOptions = {}) {
	const metricCalls: MetricArgs[] = [];
	const logCalls: LogArgs[] = [];
	const store: MonitoringStore = {
		async getMetricAggregate(args) {
			metricCalls.push(args);
			const name = args.name[0];
			if (name === 'mastra_agent_duration_ms') {
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
		expect(schema.safeParse({ scope: 'fantasy', week: 19 }).success).toBe(false);
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
		expect(serializedProviderSchema).toContain('"maximum":18');
		expect(serializedProviderSchema).not.toContain('leagueId');
		expect(serializedProviderSchema).not.toContain('season');
	});

	test('returns a healthy summary with bounded Jamis-only queries', async () => {
		const { store, metricCalls, logCalls } = fixture();
		const result = await readMonitoring(async () => store, 24, Date.parse('2026-09-15T12:00:00.000Z'));

		expect(result).toEqual({
			status: 'healthy',
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

	test('degrades on failed runs or Jamis-rooted warnings, even without completed runs', async () => {
		const failed = fixture({ completedRuns: 0, failedRuns: 1, averageDurationMs: null });
		expect((await readMonitoring(async () => failed.store))).toMatchObject({
			status: 'degraded',
			completedRuns: 0,
			failedRuns: 1,
		});

		const warning = fixture({ completedRuns: 0, averageDurationMs: null, logs: [log('retry scheduled')] });
		const result = await readMonitoring(async () => warning.store);
		expect(result.status).toBe('degraded');
		expect(result.completedRuns).toBe(0);
	});

	test('distinguishes empty telemetry and missing optional token metrics from reported zero', async () => {
		const empty = fixture({ completedRuns: 0, averageDurationMs: null, inputTokens: 0, inputTokenRecords: 0, outputTokens: 0, outputTokenRecords: 0 });
		expect((await readMonitoring(async () => empty.store))).toMatchObject({
			status: 'empty',
			completedRuns: 0,
			averageDurationMs: null,
			inputTokens: null,
			outputTokens: null,
			unavailableQueries: [],
		});

		const noTokens = fixture({ inputTokens: 0, inputTokenRecords: 0, outputTokens: 0, outputTokenRecords: 0 });
		expect((await readMonitoring(async () => noTokens.store))).toMatchObject({
			status: 'healthy',
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
			status: 'unavailable',
			completedRuns: null,
			logs: [],
			unavailableQueries: ['storage'],
		});

		const partial = fixture({ completedRuns: 12, averageDurationMs: 2100, failLogs: true });
		const result = await readMonitoring(async () => partial.store);
		expect(result).toMatchObject({
			status: 'unavailable',
			completedRuns: 12,
			averageDurationMs: 2100,
			logs: [],
			unavailableQueries: ['logs'],
		});
		expect(JSON.stringify(result)).not.toContain('password');
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

		expect(result.status).toBe('degraded');
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
		expect(executed).toMatchObject({ status: 'degraded' });
		expect(calls).toEqual(['flush', 'store']);

		const unavailable = await checkMonitoringTool.execute!(
			{ scope: 'application', hours: 24 },
			{ mastra: { observability: { flush: async () => { throw new Error('flush failed'); } } } } as never,
		);
		expect(unavailable).toMatchObject({ status: 'unavailable', unavailableQueries: ['storage'] });
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
			expect(result).toEqual({ availability: 'available', mode: 'week', week: run!.fantasyWeek, run: expected[index] });
		}
	});

	test('returns null for a missing exact week and zero counts for an empty season', async () => {
		expect(await readFantasyMonitoring('configured-league', async () => [], 18, nowMs)).toEqual({
			availability: 'available',
			mode: 'week',
			week: 18,
			run: null,
		});
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
		expect(calls[0]!.text).toContain('WHERE league_id = ? AND fantasy_week BETWEEN 1 AND 18');
		expect(calls[0]!.text).toContain('ORDER BY fantasy_week DESC LIMIT 18');
		expect(calls[1]!.values).toEqual(['configured-league', 2]);
		expect(calls[1]!.text).toContain('WHERE league_id = ? AND fantasy_week = ? LIMIT 1');
		for (const call of calls) {
			expect(call.text).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i);
			expect(call.text).not.toMatch(/final_text|last_error|message_handle|claim_token|latest_attempt_trace_id/i);
			expect(call.text).not.toMatch(/metric|logs|traces|fantasy_recap_generations/i);
		}
	});
});
