import type { WeekFacts } from '../analysis';
import type { CoordinatorDeps } from '../coordinator';
import type { SendClient, SendOutcome } from '../deliver';
import type { RecapGenerationRecord, SqlLike } from '../recaps';

import type { RecapRun } from '../runs';
import { describe, expect, it } from 'bun:test';
import { parseFantasyConfig } from '../config';
import { confirmSent, retryWeek, runWeeklyRecap } from '../coordinator';
import { ensureFantasyRunsTable, listActionableRuns } from '../runs';

const config = parseFantasyConfig({
	FANTASY_SENDBLUE_GROUP_ID: 'g1',
	FANTASY_SLEEPER_LEAGUE_ID: '111',
	FANTASY_MANAGER_MAP: '{"+15550001111":"u1","+15550002222":"u2"}',
	FANTASY_RECAP_TIMEZONE: 'America/Chicago',
})!;

const NOW = '2026-09-10T16:00:00Z';

const managers = [
	{ rosterId: 1, userId: 'u1', displayName: 'alpha' },
	{ rosterId: 2, userId: 'u2', displayName: 'bravo' },
];

function factsStub(): WeekFacts {
	const alpha = { rosterId: 1, userId: 'u1', displayName: 'alpha' };
	const bravo = { rosterId: 2, userId: 'u2', displayName: 'bravo' };
	const result = { a: alpha, b: bravo, aPoints: 120.5, bPoints: 97.25, margin: 23.25, winner: alpha, loser: bravo };
	return {
		leagueId: '111',
		leagueName: 'Test League',
		season: '2026',
		week: 2,
		isPlayoffWeek: false,
		isChampionshipWeek: false,
		results: [result],
		high: { teams: [alpha], points: 120.5 },
		low: { teams: [bravo], points: 97.25 },
		closest: result,
		blowout: result,
		standings: null,
		movement: [],
		upcoming: [{ a: bravo, b: alpha }],
		playerStoryCandidates: [],
	};
}

const shaping = {
	awards: {
		roughestWeek: 'A quiet week for the last-place dynasty.',
		bestWeek: 'The league briefly became a private showcase.',
		mostEntertainingMatchup: 'Nobody was permitted a comfortable Sunday.',
		biggestBlowout: 'The contest became paperwork before dinner.',
	},
	editorial: [],
};

/** In-memory RunsStore preserving the SQL functions' semantics. */
function memoryRuns(seed: RecapRun[] = []) {
	const rows = new Map<number, RecapRun>(seed.map(r => [r.fantasyWeek, { ...r }]));
	const alerted = new Set<string>();
	return {
		rows,
		ensureSchema: async () => {},
		getRun: async (week: number) => rows.get(week) ?? null,
		claimRun: async (week: number, claimToken: string, leaseExpiresAt: Date, traceId: string | null) => {
			const row = rows.get(week);
			if (!row) {
				rows.set(week, blankRun(week, { status: 'started', claimToken, leaseExpiresAt, latestAttemptTraceId: traceId }));
				return { claimed: true, run: rows.get(week)! };
			}
			if (row.status === 'failed') {
				rows.set(week, {
					...row,
					status: 'started',
					claimToken,
					leaseExpiresAt,
					sendAttemptAt: null,
					lastError: null,
					latestAttemptTraceId: traceId,
					failureStage: null,
					failureClassification: null,
				});
				return { claimed: true, run: rows.get(week)! };
			}
			return { claimed: false, run: row };
		},
		claimForRetry: async (week: number, claimToken: string, leaseExpiresAt: Date) => {
			const row = rows.get(week);
			if (!row || (row.status !== 'failed' && row.status !== 'delivery_unknown'))
				return null;
			rows.set(week, {
				...row,
				status: 'started',
				claimToken,
				leaseExpiresAt,
				sendAttemptAt: null,
				lastError: null,
				latestAttemptTraceId: null,
				failureStage: null,
				failureClassification: null,
			});
			return row.finalText;
		},
		recordAttemptText: async (week: number, claimToken: string, finalText: string) => {
			const row = rows.get(week);
			if (!row || row.status !== 'started' || row.claimToken !== claimToken)
				return false;
			rows.set(week, { ...row, finalText, sendAttemptAt: new Date(NOW) });
			return true;
		},
		markSent: async (week: number, claimToken: string, handle: string) => {
			const row = rows.get(week);
			if (!row || row.status !== 'started' || row.claimToken !== claimToken)
				return false;
			rows.set(week, {
				...row,
				status: 'sent',
				messageHandle: handle,
				deliverySource: 'api',
				sentAt: new Date(NOW),
				failureStage: null,
				failureClassification: null,
			});
			return true;
		},
		markFailed: async (week: number, claimToken: string, error: string, failureStage: RecapRun['failureStage'], failureClassification: RecapRun['failureClassification']) => {
			const row = rows.get(week);
			if (!row || row.status !== 'started' || row.claimToken !== claimToken)
				return false;
			rows.set(week, { ...row, status: 'failed', lastError: error, failureStage, failureClassification });
			return true;
		},
		markDeliveryUnknown: async (week: number, claimToken: string, error: string) => {
			const row = rows.get(week);
			if (row?.status === 'started' && row.claimToken === claimToken)
				rows.set(week, { ...row, status: 'delivery_unknown', lastError: error, failureStage: 'reply_delivery', failureClassification: 'unknown' });
		},
		confirmSentByOperator: async (week: number) => {
			const row = rows.get(week);
			if (!row || row.status !== 'delivery_unknown')
				return false;
			rows.set(week, {
				...rows.get(week)!,
				status: 'sent',
				deliverySource: 'operator',
				sentAt: row.sendAttemptAt,
				failureStage: null,
				failureClassification: null,
			});
			return true;
		},
		expireStaleLeases: async (now: Date, reason: string) => {
			const stale = [...rows.values()].filter(r => r.status === 'started' && r.leaseExpiresAt != null && r.leaseExpiresAt < now);
			return stale.map((row) => {
				const updated = {
					...row,
					status: row.sendAttemptAt && row.finalText ? 'delivery_unknown' as const : 'failed' as const,
					lastError: row.sendAttemptAt && row.finalText ? reason : 'recap processing interrupted before send',
					failureStage: row.sendAttemptAt && row.finalText ? 'reply_delivery' as const : null,
					failureClassification: 'execution_interrupted' as const,
				};
				rows.set(row.fantasyWeek, updated);
				return updated;
			});
		},
		hasNewerActiveRun: async (week: number) =>
			[...rows.values()].some(r => r.fantasyWeek > week && r.status !== 'failed'),
		latestSentRunBefore: async (week: number) =>
			[...rows.values()].filter(r => r.fantasyWeek < week && r.status === 'sent').sort((a, b) => b.fantasyWeek - a.fantasyWeek)[0] ?? null,
		alertUnmappedSenderOnce: async (hash: string) => {
			const wasNew = !alerted.has(hash);
			alerted.add(hash);
			return wasNew;
		},
	};
}

function blankRun(week: number, overrides: Partial<RecapRun> = {}): RecapRun {
	return {
		leagueId: '111',
		fantasyWeek: week,
		status: 'started',
		latestAttemptTraceId: null,
		failureStage: null,
		failureClassification: null,
		finalText: null,
		claimToken: null,
		leaseExpiresAt: null,
		sendAttemptAt: null,
		messageHandle: null,
		deliverySource: null,
		sentAt: null,
		lastError: null,
		createdAt: new Date(NOW),
		updatedAt: new Date(NOW),
		...overrides,
	};
}

function sendClient(outcomes: SendOutcome[], dms: string[]) {
	const sends: string[] = [];
	return {
		sends,
		dms,
		client: {
			sendToGroup: async (_groupId: string, text: string) => {
				sends.push(text);
				return outcomes.shift() ?? { kind: 'sent' as const, handle: 'sb_default' };
			},
			directMessage: async (text: string) => {
				dms.push(text);
			},
		} satisfies SendClient,
	};
}

function depsFor(args: {
	runs: ReturnType<typeof memoryRuns>;
	send: SendClient;
	dms?: string[];
	recorded?: RecapGenerationRecord[];
	messagesAwait?: unknown[];
}) {
	const recorded = args.recorded ?? [];
	const deps: CoordinatorDeps = {
		runs: args.runs,
		recaps: {
			ensureSchema: async () => {},
			record: async (record, claimToken) => {
				const run = args.runs.rows.get(record.fantasyWeek);
				if (!run || run.status !== 'started' || run.claimToken !== claimToken)
					return false;
				args.runs.rows.set(record.fantasyWeek, { ...run, finalText: record.finalText });
				recorded.push(record);
				return true;
			},
		},
		groupId: 'g1',
		leagueId: '111',
		readThreadMessages: async () => (args.messagesAwait ?? []) as never,
		send: args.send,
		now: () => new Date(NOW),
	};
	return { deps, recorded };
}

const generate = async () => shaping;

describe('runWeeklyRecap delivery state machine', () => {
	it('sends a fresh week and records handle, text-before-send, and generation history', async () => {
		const runs = memoryRuns();
		const dms: string[] = [];
		const { sends } = sendClient([], dms);
		const order: string[] = [];
		const { deps, recorded } = depsFor({
			runs,
			send: {
				sendToGroup: async (_g: string, text: string) => {
					order.push(runs.rows.get(2)!.finalText ? 'send-after-text' : 'send-before-text');
					sends.push(text);
					return { kind: 'sent', handle: 'sb_abc' };
				},
				directMessage: async () => {},
			},
		});
		const result = await runWeeklyRecap(
			{ config, week: 2, loadFacts: async () => ({ facts: factsStub(), managers }), model: 'm1', traceId: 'trace-week-2', generate },
			deps,
		);
		expect(result.outcome).toBe('sent');
		expect(order).toEqual(['send-after-text']); // the text was durable before the request fired
		const row = runs.rows.get(2)!;
		expect(row.status).toBe('sent');
		expect(row.latestAttemptTraceId).toBe('trace-week-2');
		expect(row.messageHandle).toBe('sb_abc');
		expect(row.deliverySource).toBe('api');
		expect(row.finalText).toBe(sends[0]);
		expect(row.sendAttemptAt).toEqual(new Date(NOW));
		expect(recorded[0].generatorVersion).toBe('fantasy-recap-v7');
		expect(recorded[0].finalText).toBe(sends[0]);
		expect(dms).toEqual([]);
	});

	it('claims before loading facts and records a fixed pre-generation failure', async () => {
		const runs = memoryRuns();
		const { deps } = depsFor({ runs, send: sendClient([], []).client });
		const result = await runWeeklyRecap({
			config,
			week: 2,
			traceId: 'trace-facts',
			loadFacts: async () => {
				expect(runs.rows.get(2)).toMatchObject({ status: 'started', latestAttemptTraceId: 'trace-facts' });
				throw new Error('private Sleeper response');
			},
			model: 'm1',
			generate,
		}, deps);

		expect(result.outcome).toBe('failed');
		expect(runs.rows.get(2)).toMatchObject({
			status: 'failed',
			failureStage: 'scheduled_job',
			failureClassification: 'execution_failed',
		});
	});

	it('does not retry a provider-accepted recap when recording sent fails', async () => {
		const runs = memoryRuns();
		runs.markSent = async () => {
			throw new Error('database unavailable');
		};
		const dms: string[] = [];
		const { sends, client } = sendClient([{ kind: 'sent', handle: 'sb_accepted' }], dms);
		const { deps } = depsFor({ runs, send: client });

		const first = await runWeeklyRecap({ config, week: 2, loadFacts: async () => ({ facts: factsStub(), managers }), model: 'm1', generate }, deps);
		expect(first.outcome).toBe('delivery_unknown');
		expect(runs.rows.get(2)!.status).toBe('delivery_unknown');

		const second = await runWeeklyRecap({ config, week: 2, loadFacts: async () => ({ facts: factsStub(), managers }), model: 'm1', generate }, deps);
		expect(second.outcome).toBe('blocked-delivery-unknown');
		expect(sends).toHaveLength(1);
		expect(dms.some(message => message.includes('delivery result could not be recorded'))).toBe(true);
	});

	it('is a no-op once sent, never sending twice', async () => {
		const runs = memoryRuns([blankRun(2, { status: 'sent', finalText: 'recap v2', sentAt: new Date(NOW) })]);
		const { sends, client } = sendClient([], []);
		const { deps } = depsFor({ runs, send: client });
		const result = await runWeeklyRecap({ config, week: 2, loadFacts: async () => ({ facts: factsStub(), managers }), model: 'm1', generate }, deps);
		expect(result.outcome).toBe('noop-already-sent');
		expect(sends).toEqual([]);
	});

	it('no completed week is a plain no-op', async () => {
		const runs = memoryRuns();
		const { client } = sendClient([], []);
		const { deps } = depsFor({ runs, send: client });
		const result = await runWeeklyRecap({ config, week: null, loadFacts: null, model: 'm1', generate }, deps);
		expect(result.outcome).toBe('noop-no-completed-week');
	});

	it('definite pre-send failure marks failed, alerts, and auto-retries the identical text next run', async () => {
		const runs = memoryRuns();
		const dms: string[] = [];
		const { sends, client } = sendClient([{ kind: 'failed', error: 'sendblue HTTP 422' }, { kind: 'sent', handle: 'sb_retry' }], dms);
		const { deps, recorded } = depsFor({ runs, send: client });
		let retryGenerateCalls = 0;
		const first = await runWeeklyRecap({
			config,
			week: 2,
			loadFacts: async () => ({ facts: factsStub(), managers }),
			model: 'm1',
			async generate(_f, _c) {
				retryGenerateCalls += 1;
				return shaping;
			},
		}, deps);
		expect(first.outcome).toBe('failed');
		expect(runs.rows.get(2)).toMatchObject({
			status: 'failed',
			failureStage: 'reply_delivery',
			failureClassification: 'delivery_failed',
		});
		expect(dms.some(m => m.includes('failed before Sendblue accepted'))).toBe(true);
		// automatic retry on the next scheduled run resends the stored text verbatim, no regeneration
		const countingGenerate = async () => {
			retryGenerateCalls += 1;
			return shaping;
		};
		const second = await runWeeklyRecap({ config, week: 2, loadFacts: async () => ({ facts: factsStub(), managers }), model: 'm1', generate: countingGenerate }, deps);
		expect(second.outcome).toBe('sent');
		expect(sends[1]).toBe(sends[0]); // stored text, resent verbatim
		expect(retryGenerateCalls).toBe(1); // generation happened once; the retry resends without it
		expect(recorded).toHaveLength(1); // generation recorded exactly once
	});

	it('a timeout becomes delivery_unknown, alerts, and blocks later automatic sends', async () => {
		const runs = memoryRuns();
		const dms: string[] = [];
		const { sends, client } = sendClient([{ kind: 'unknown', error: 'send timed out after 15000ms' }], dms);
		const { deps } = depsFor({ runs, send: client });
		const result = await runWeeklyRecap({ config, week: 2, loadFacts: async () => ({ facts: factsStub(), managers }), model: 'm1', generate }, deps);
		expect(result.outcome).toBe('delivery_unknown');
		expect(runs.rows.get(2)).toMatchObject({
			status: 'delivery_unknown',
			failureStage: 'reply_delivery',
			failureClassification: 'unknown',
		});
		expect(dms.some(m => m.includes('delivery is unknown'))).toBe(true);
		const again = await runWeeklyRecap({ config, week: 2, loadFacts: async () => ({ facts: factsStub(), managers }), model: 'm1', generate }, deps);
		expect(again.outcome).toBe('blocked-delivery-unknown');
		expect(sends).toHaveLength(1);
	});

	it('recovers a crash-after-attempt row via the expired-lease sweep instead of resending', async () => {
		const runs = memoryRuns([
			blankRun(2, { status: 'started', claimToken: 'dead', leaseExpiresAt: new Date('2026-09-10T15:00:00Z'), sendAttemptAt: new Date('2026-09-10T15:00:00Z'), finalText: 'half-sent text' }),
		]);
		const dms: string[] = [];
		const { sends, client } = sendClient([], dms);
		const { deps } = depsFor({ runs, send: client });
		const result = await runWeeklyRecap({ config, week: 2, loadFacts: null, model: 'm1', generate }, deps);
		// the row was classified unknown instead of being re-claimed and sent again
		expect(runs.rows.get(2)!.status).toBe('delivery_unknown');
		expect(runs.rows.get(2)).toMatchObject({ failureStage: 'reply_delivery', failureClassification: 'execution_interrupted' });
		expect(sends).toEqual([]);
		expect(dms.some(m => m.includes('interrupted'))).toBe(true);
		expect(result.outcome).toBe('blocked-delivery-unknown');
	});

	it('retries work interrupted before any send attempt without operator recovery', async () => {
		const runs = memoryRuns([
			blankRun(2, { status: 'started', claimToken: 'dead', leaseExpiresAt: new Date('2026-09-10T15:00:00Z') }),
		]);
		const dms: string[] = [];
		const { sends, client } = sendClient([], dms);
		const { deps } = depsFor({ runs, send: client });

		const result = await runWeeklyRecap({ config, week: 2, loadFacts: async () => ({ facts: factsStub(), managers }), model: 'm1', generate }, deps);

		expect(result.outcome).toBe('sent');
		expect(sends).toHaveLength(1);
		expect(runs.rows.get(2)!.sendAttemptAt).toEqual(new Date(NOW));
		expect(dms).toEqual([]);
	});

	it('does not guess a stage for work interrupted before send', async () => {
		const runs = memoryRuns([
			blankRun(2, { status: 'started', claimToken: 'dead', leaseExpiresAt: new Date('2026-09-10T15:00:00Z') }),
		]);

		const [stuck] = await runs.expireStaleLeases(new Date(NOW), 'send interrupted');

		expect(stuck).toMatchObject({ status: 'failed', failureStage: null, failureClassification: 'execution_interrupted' });
	});

	it('classifies persistence failures separately from generation', async () => {
		const runs = memoryRuns();
		const { sends, client } = sendClient([], []);
		const { deps } = depsFor({ runs, send: client });
		deps.recaps.record = async () => {
			throw new Error('database unavailable');
		};

		const result = await runWeeklyRecap({
			config,
			week: 2,
			loadFacts: async () => ({ facts: factsStub(), managers }),
			model: 'm1',
			generate,
		}, deps);

		expect(result.outcome).toBe('failed');
		expect(runs.rows.get(2)).toMatchObject({
			status: 'failed',
			failureStage: 'application_storage',
			failureClassification: 'execution_failed',
		});
		expect(sends).toEqual([]);
	});

	it('retries legacy pre-send work that stamped an attempt at claim time', async () => {
		const runs = memoryRuns([
			blankRun(2, {
				status: 'started',
				claimToken: 'dead',
				leaseExpiresAt: new Date('2026-09-10T15:00:00Z'),
				sendAttemptAt: new Date('2026-09-10T14:59:00Z'),
			}),
		]);
		const dms: string[] = [];
		const { sends, client } = sendClient([], dms);
		const { deps } = depsFor({ runs, send: client });

		const result = await runWeeklyRecap({ config, week: 2, loadFacts: async () => ({ facts: factsStub(), managers }), model: 'm1', generate }, deps);

		expect(result.outcome).toBe('sent');
		expect(sends).toHaveLength(1);
		expect(dms).toEqual([]);
	});

	it('refuses a second concurrent claim; one outbound call total', async () => {
		const runs = memoryRuns([
			blankRun(2, { status: 'started', claimToken: 'runner-a', leaseExpiresAt: new Date('2026-09-10T16:30:00Z') }),
		]);
		const { sends, client } = sendClient([], []);
		const { deps } = depsFor({ runs, send: client });
		const result = await runWeeklyRecap({ config, week: 2, loadFacts: async () => ({ facts: factsStub(), managers }), model: 'm1', generate }, deps);
		expect(result.outcome).toBe('blocked-active-claim');
		expect(sends).toEqual([]);
	});

	it('does not record or send after losing its claim during generation', async () => {
		const runs = memoryRuns();
		const { sends, client } = sendClient([], []);
		const { deps, recorded } = depsFor({ runs, send: client });
		const result = await runWeeklyRecap({
			config,
			week: 2,
			loadFacts: async () => ({ facts: factsStub(), managers }),
			model: 'm1',
			generate: async () => {
				const row = runs.rows.get(2)!;
				runs.rows.set(2, { ...row, claimToken: 'replacement' });
				return shaping;
			},
		}, deps);
		expect(result.outcome).toBe('blocked-active-claim');
		expect(recorded).toEqual([]);
		expect(sends).toEqual([]);
	});

	it('does not overwrite newer state after losing its claim during delivery', async () => {
		const runs = memoryRuns();
		const sends: string[] = [];
		const { deps } = depsFor({
			runs,
			send: {
				sendToGroup: async (_groupId, text) => {
					sends.push(text);
					const row = runs.rows.get(2)!;
					runs.rows.set(2, { ...row, claimToken: 'replacement' });
					return { kind: 'sent', handle: 'stale-handle' };
				},
				directMessage: async () => {},
			},
		});
		const result = await runWeeklyRecap({ config, week: 2, loadFacts: async () => ({ facts: factsStub(), managers }), model: 'm1', generate }, deps);
		expect(result.outcome).toBe('delivery_unknown');
		expect(runs.rows.get(2)!.claimToken).toBe('replacement');
		expect(runs.rows.get(2)!.messageHandle).toBeNull();
		expect(sends).toHaveLength(1);
	});

	it('alerts once per unmapped sender, never twice', async () => {
		const runs = memoryRuns();
		const dms: string[] = [];
		const { client } = sendClient([], dms);
		const messages = [{
			id: 'x1',
			role: 'user',
			createdAt: new Date('2026-09-09T00:00:00Z'),
			threadId: 't',
			resourceId: 't',
			content: { format: 2, parts: [{ type: 'text', text: 'hello' }], metadata: { senderNumber: '+19998887777' } },
		}];
		const { deps } = depsFor({ runs, send: client, messagesAwait: messages });
		await runWeeklyRecap({ config, week: 2, loadFacts: async () => ({ facts: factsStub(), managers }), model: 'm1', generate }, deps);
		await runWeeklyRecap({ config, week: 2, loadFacts: async () => ({ facts: factsStub(), managers }), model: 'm1', generate }, deps);
		const alerts = dms.filter(m => m.includes('isn\'t in FANTASY_MANAGER_MAP'));
		expect(alerts).toHaveLength(1);
	});

	it('scopes chat context to messages after the previous sent recap', async () => {
		const priorSentAt = new Date('2026-09-03T12:00:00Z');
		const runs = memoryRuns([blankRun(1, { status: 'sent', sentAt: priorSentAt, sendAttemptAt: priorSentAt })]);
		let seenSince: Date | undefined;
		let sinceWasCalled = false;
		const { deps } = depsFor({ runs, send: sendClient([], []).client });
		deps.readThreadMessages = async (since?: Date) => {
			sinceWasCalled = true;
			seenSince = since;
			return [];
		};
		await runWeeklyRecap({ config, week: 2, loadFacts: async () => ({ facts: factsStub(), managers }), model: 'm1', generate }, deps);
		expect(sinceWasCalled).toBe(true);
		expect(seenSince).toBe(priorSentAt);
	});

	it('marks failed with an operator alert when generation exceeds its one repair attempt', async () => {
		const runs = memoryRuns();
		const dms: string[] = [];
		const { client } = sendClient([], dms);
		const { deps } = depsFor({ runs, send: client });
		const badGenerate = async (): Promise<never> => {
			throw new (await import('../generate')).ShapingValidationError('Callback references unknown message id "nope"');
		};
		const result = await runWeeklyRecap({ config, week: 2, loadFacts: async () => ({ facts: factsStub(), managers }), model: 'm1', generate: badGenerate as never }, deps);
		expect(result.outcome).toBe('failed');
		expect(runs.rows.get(2)).toMatchObject({ status: 'failed', failureStage: 'model', failureClassification: 'execution_failed' });
		expect(dms.some(m => m.includes('could not be generated'))).toBe(true);
	});
});

describe('fantasy recap run schema', () => {
	it('upgrades an existing table idempotently with safe incident columns', async () => {
		const statements: string[] = [];
		const sql = (async (strings: TemplateStringsArray) => {
			statements.push(strings.join(' '));
			return [];
		}) as SqlLike;

		await ensureFantasyRunsTable(sql);
		await ensureFantasyRunsTable(sql);

		const alters = statements.filter(statement => statement.includes('ALTER TABLE fantasy_recap_runs'));
		expect(alters).toHaveLength(2);
		for (const statement of alters) {
			expect(statement).toContain('ADD COLUMN IF NOT EXISTS latest_attempt_trace_id');
			expect(statement).toContain('ADD COLUMN IF NOT EXISTS failure_stage');
			expect(statement).toContain('ADD COLUMN IF NOT EXISTS failure_classification');
		}

		const queryCalls: Array<{ statement: string; values: unknown[] }> = [];
		const querySql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
			queryCalls.push({ statement: strings.join(' '), values });
			return [];
		}) as SqlLike;
		const windowStart = new Date('2026-09-01T00:00:00.000Z');
		const windowEnd = new Date('2026-09-02T00:00:00.000Z');
		await listActionableRuns('111', windowStart, windowEnd, 6, querySql);
		expect(queryCalls[0]!.statement).toContain('updated_at >=');
		expect(queryCalls[0]!.statement).toContain('updated_at <=');
		expect(queryCalls[0]!.statement).toContain('ORDER BY updated_at ASC, fantasy_week ASC');
		expect(queryCalls[0]!.values).toEqual(['111', windowStart.toISOString(), windowEnd.toISOString(), 6]);
	});
});

describe('retryWeek / confirmSent', () => {
	it('resends the byte-identical stored text', async () => {
		const runs = memoryRuns([blankRun(2, { status: 'failed', finalText: 'saved recap text', lastError: 'http 422' })]);
		let schemaChecks = 0;
		runs.ensureSchema = async () => {
			schemaChecks++;
		};
		const { sends, client } = sendClient([{ kind: 'sent', handle: 'sb_retry_1' }], []);
		const { deps } = depsFor({ runs, send: client });
		const result = await retryWeek(2, false, deps);
		expect(result).toMatchObject({ ok: true, outcome: 'sent' });
		expect(sends).toEqual(['saved recap text']);
		expect(runs.rows.get(2)!.messageHandle).toBe('sb_retry_1');
		expect(schemaChecks).toBe(1);
	});

	it('refuses delivery_unknown retry until the operator verifies absence', async () => {
		const runs = memoryRuns([blankRun(2, { status: 'delivery_unknown', finalText: 'maybe sent' })]);
		const { sends, client } = sendClient([], []);
		const { deps } = depsFor({ runs, send: client });
		expect(await retryWeek(2, false, deps)).toMatchObject({ ok: false });
		expect(sends).toEqual([]);
		const verified = sendClient([{ kind: 'sent', handle: 'sb_late' }], []);
		const { deps: deps2 } = depsFor({ runs, send: verified.client });
		const result = await retryWeek(2, true, deps2);
		expect(result).toMatchObject({ ok: true, outcome: 'sent' });
		expect(verified.sends).toEqual(['maybe sent']);
	});

	it('refuses stale weeks once a newer week is claimed or sent', async () => {
		const runs = memoryRuns([
			blankRun(2, { status: 'failed', finalText: 'old' }),
			blankRun(3, { status: 'started', claimToken: 'x', leaseExpiresAt: new Date('2026-09-10T16:30:00Z') }),
		]);
		const { deps } = depsFor({ runs, send: sendClient([], []).client });
		const result = await retryWeek(2, true, deps);
		expect(result.ok).toBe(false);
		expect(result.ok ? '' : result.reason).toMatch(/stale/);
	});

	it('confirm-sent needs delivery_unknown and preserves the original attempt time', async () => {
		const attemptAt = new Date('2026-09-10T15:42:00Z');
		const runs = memoryRuns([blankRun(2, { status: 'delivery_unknown', sendAttemptAt: attemptAt, finalText: 'out there somewhere' })]);
		let schemaChecks = 0;
		runs.ensureSchema = async () => {
			schemaChecks++;
		};
		const { deps } = depsFor({ runs, send: sendClient([], []).client });
		expect(await confirmSent(2, deps)).toBe(true);
		const row = runs.rows.get(2)!;
		expect(row.status).toBe('sent');
		expect(row.deliverySource).toBe('operator');
		expect(row.sentAt).toBe(attemptAt); // effective delivery time = when it actually hit the group
		expect(schemaChecks).toBe(1);
	});

	it('rejects confirm-sent for weeks never in limbo', async () => {
		const runs = memoryRuns([blankRun(2, { status: 'sent' })]);
		const { deps } = depsFor({ runs, send: sendClient([], []).client });
		expect(await confirmSent(2, deps)).toBe(false);
	});
});
