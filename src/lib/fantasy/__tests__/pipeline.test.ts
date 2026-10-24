import type { GatewayLanguageModel } from '@mastra/core/llm';
import type { createFantasyEditorialProcedure as CreateEditorial } from '../../../mastra/workflows/prepare-fantasy-recap';
import type { createFantasyPublicationProcedure as CreatePublication } from '../../../mastra/workflows/publish-fantasy-recap';
import type { SendOutcome } from '../deliver';
import type { EditorialOutcome } from '../editorial-loop';
import type { GenerationState } from '../generation-state';
import type { NflSourceResult } from '../nfl-sources.types';
import type { PipelineDeps } from '../pipeline';
import type { RecapEvidencePacket } from '../recap-evidence';
import type { SqlLike } from '../recaps';
import type { SavedReportReference } from '../runs';
import type { SavedReport } from '../saved-report';
import type { EditorialModelInput } from './fixtures/editorial-runtime.fixture';
import { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { Mastra } from '@mastra/core';
import { MastraModelGateway } from '@mastra/core/llm';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { runWeeklyRecap } from '../coordinator';
import { buildEditorialCandidate } from '../editorial';
import { getGenerationRun, readGenerationDebug } from '../generation-runs';
import { initialGenerationState, parseGenerationState } from '../generation-state';
import { runRecapPipeline } from '../pipeline';
import { ensureFantasyRecapsTable, recordApprovedReport } from '../recaps';
import {
	claimRun,
	confirmSavedReportPart,
	createRunsStore,
	ensureFantasyRunsTable,
	getSavedReportState,
	markDeliveryUnknown,
	markFailed,
	markSent,
	recordAttemptText,
	savedPartStatus,
} from '../runs';
import { buildSavedReport, parseSavedReport } from '../saved-report';
import { dispatchSavedReport, readSavedReportReceipt } from '../saved-report-delivery';
import { editorialFixtureRuntime, passingEditorialReview } from './fixtures/editorial-runtime.fixture';
import {
	editorialFixtureConfig,
	editorialFixtureNow,
	editorialFixtureQuote,
	editorialFixtureSleeper,
	editorialFixtureWindow,
	frozenEditorialFixture,
	validEditorialDraft,
} from './fixtures/editorial.fixture';
import { reportingWindowFixture } from './fixtures/reporting-window.fixture';

const request = { config: editorialFixtureConfig, season: 2026, week: 1, window: reportingWindowFixture(editorialFixtureWindow) };
const scope = {
	leagueId: editorialFixtureConfig.sleeperLeagueId,
	groupId: editorialFixtureConfig.sendblueGroupId,
	season: 2026,
	week: 1,
};
const expires = () => new Date(Date.now() + 60_000);
const reference = (report: SavedReport): SavedReportReference => ({ ...report.scope, reportId: report.id });
const accepted = (handle = 'fixture-receipt'): SendOutcome => ({ kind: 'sent', handle });
const normalize = (strings: TemplateStringsArray) => strings.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
const emptyNfl: NflSourceResult = {
	status: 'empty',
	trust: 'untrusted-source-data',
	requestId: 'fixture-request',
	catalogueRequestId: null,
	quotedCredits: 1,
	credits: 1,
	adminActionUrl: null,
	chargeIdPresent: true,
	gaps: [],
	source: null,
	records: [],
};
type TransactionalSql = SqlLike & { begin: <T>(action: (tx: SqlLike) => Promise<T>) => Promise<T> };
type QueryMatch = (query: string, values: unknown[]) => boolean;

// A lost COMMIT acknowledgement is injected outside the native transaction callback, not a rollback.
function watchedSql(base: SqlLike, fault?: { matches: QueryMatch; mode: 'before' | 'after' }) {
	let queries = 0;
	let hits = 0;
	let committedFault = false;
	const wrap = (client: SqlLike, transaction: boolean): SqlLike => {
		const tagged: SqlLike = async (strings, ...values) => {
			if (++queries > 400)
				throw new Error('fixture SQL budget exceeded');
			const match = hits === 0 && fault?.matches(normalize(strings), values);
			if (match) {
				hits++;
				if (fault!.mode === 'before')
					throw new Error('fixture SQL write rejected');
			}
			const result = await client(strings, ...values);
			if (match) {
				if (!transaction)
					throw new Error('fixture SQL acknowledgement lost');
				committedFault = true;
			}
			return result;
		};
		if ('begin' in client && typeof client.begin === 'function') {
			Object.assign(tagged, { begin: async <T>(action: (tx: SqlLike) => Promise<T>): Promise<T> => {
				const result = await (client as TransactionalSql).begin(tx => action(wrap(tx, true)));
				if (committedFault) {
					committedFault = false;
					throw new Error('fixture COMMIT acknowledgement lost');
				}
				return result;
			} });
		}
		return tagged;
	};
	return { sql: wrap(base, false), queries: () => queries, hits: () => hits };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

type LunaAction = { tool: true } | { handback: unknown };
function lunaRuntime(respond: (options: any) => Promise<LunaAction>) {
	const calls: any[] = [];
	const resolved: string[] = [];
	async function reply(options: any) {
		calls.push(options);
		return respond(options);
	}
	const model = new MastraLanguageModelV2Mock({
		doGenerate: async (options) => {
			const action = await reply(options);
			return {
				content: 'tool' in action
					? [{ type: 'tool-call' as const, toolCallId: `delivery-${calls.length}`, toolName: 'deliver_saved_report', input: '{}' }]
					: [{ type: 'text' as const, text: JSON.stringify({ handback: action.handback }) }],
				finishReason: 'tool' in action ? 'tool-calls' : 'stop',
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				warnings: [],
			};
		},
		doStream: async (options) => {
			const action = await reply(options);
			return { stream: new ReadableStream({ start(controller) {
				controller.enqueue({ type: 'stream-start', warnings: [] });
				if ('tool' in action) {
					controller.enqueue({ type: 'tool-call', toolCallId: `delivery-${calls.length}`, toolName: 'deliver_saved_report', input: '{}' });
				} else {
					controller.enqueue({ type: 'text-start', id: 'reply' });
					controller.enqueue({ type: 'text-delta', id: 'reply', delta: JSON.stringify({ handback: action.handback }) });
					controller.enqueue({ type: 'text-end', id: 'reply' });
				}
				controller.enqueue({ type: 'finish', finishReason: 'tool' in action ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
				controller.close();
			} }) };
		},
	});
	class FixtureGateway extends MastraModelGateway {
		readonly id = 'openai-codex';
		readonly name = 'Pipeline Luna fixture';
		fetchProviders() { return Promise.resolve({ 'openai-codex': { name: this.name, gateway: this.id, apiKeyEnvVar: '', models: ['gpt-6-luna'], npm: '@ai-sdk/openai' } }); }
		buildUrl() { return undefined; }
		getApiKey() { return Promise.resolve('fixture'); }
		resolveLanguageModel({ modelId }: { modelId: string }): Promise<GatewayLanguageModel> {
			resolved.push(modelId);
			return Promise.resolve(model);
		}
	}
	return { runtime: new Mastra({ logger: false, gateways: { fixture: new FixtureGateway() } }), calls, resolved };
}

// Never read application credentials or silently fall back to a normal database/schema.
const databaseUrl = process.env.JAMIS_TEST_DATABASE_URL;
if (databaseUrl) {
	const url = new URL(databaseUrl);
	if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
		|| url.port !== '15458' || url.pathname !== '/jamis_sessions_test' || url.search || url.hash) {
		throw new Error('Disposable loopback port 15458 jamis_sessions_test URL required');
	}
}

describe.skipIf(!databaseUrl)('pipeline native PostgreSQL + scripted private Astra/Luna (no external effects)', () => {
	const schema = `pipeline_${randomUUID().replaceAll('-', '')}`;
	let root: SQL;
	let sql: SQL;
	let createEditorial: typeof CreateEditorial;
	let createPublication: typeof CreatePublication;
	let packet: RecapEvidencePacket;
	let reports: SavedReport[];
	let fetchGuard: ReturnType<typeof spyOn>;
	let networkCalls = 0;
	let checks: Array<() => void>;

	beforeAll(async () => {
		fetchGuard = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => {
			networkCalls++;
			throw new Error('External fetch forbidden in pipeline fixture');
		}, { preconnect: () => {
			networkCalls++;
			throw new Error('External preconnect forbidden in pipeline fixture');
		} }));
		({ createFantasyEditorialProcedure: createEditorial } = await import('../../../mastra/workflows/prepare-fantasy-recap'));
		({ createFantasyPublicationProcedure: createPublication } = await import('../../../mastra/workflows/publish-fantasy-recap'));
		root = new SQL(databaseUrl!, { connectionTimeout: 1 });
		await root.unsafe(`CREATE SCHEMA "${schema}"`);
		sql = new SQL(databaseUrl!, { max: 4, connectionTimeout: 1, connection: { search_path: schema, statement_timeout: '5000', lock_timeout: '2000' } });
		await ensureFantasyRunsTable(sql);
		await ensureFantasyRecapsTable(sql);
		packet = await frozenEditorialFixture();
		reports = [false, true].map((multipart) => {
			const built = buildEditorialCandidate(packet, draftFor(packet, multipart));
			if (built.status !== 'candidate')
				throw new Error('Fixture candidate required');
			const report = buildSavedReport(packet, { status: 'approved', evidenceId: packet.id, candidate: built.candidate, counts: { drafts: 1, reviews: 1 }, review: { evidenceId: packet.id, candidateId: built.candidate.id, verdict: 'pass', issues: [] } });
			expect(report.parts).toHaveLength(multipart ? 3 : 1);
			return report;
		});
	}, 30_000);
	beforeEach(async () => {
		checks = [];
		await sql`TRUNCATE fantasy_recap_runs, fantasy_recap_generations`;
	});
	afterEach(() => {
		expect(networkCalls).toBe(0);
		expect(fetchGuard).not.toHaveBeenCalled();
		for (const check of checks) check();
	});
	afterAll(async () => {
		try {
			await sql?.close();
		} finally {
			try {
				if (root) {
					await root.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
					expect([...await root`SELECT 1 FROM pg_namespace WHERE nspname = ${schema}`]).toEqual([]);
				}
			} finally {
				try {
					await root?.close();
				} finally {
					fetchGuard?.mockRestore();
				}
			}
		}
	});

	function draftFor(value: RecapEvidencePacket, multipart = false) {
		const draft = validEditorialDraft(value);
		if (multipart) {
			draft.stories = ['First', 'Second', 'Third'].map(angle => ({ headline: `${angle} perspective`, body: `${angle} story. `.repeat(900), supportIds: ['score:1:1'] }));
		}
		return draft;
	}
	async function state() {
		const value = await getGenerationRun(scope, sql);
		expect(value).not.toBeNull();
		return value!;
	}
	async function snapshot() {
		return {
			runs: [...await sql`SELECT to_jsonb(r) AS row FROM fantasy_recap_runs r ORDER BY league_id, fantasy_week`],
			history: [...await sql`
				SELECT
					to_jsonb(g) AS row
				FROM
					fantasy_recap_generations g
				ORDER BY
					league_id,
					fantasy_week,
					generator_version,
					model
			`],
		};
	}
	async function unpublished() {
		const snap = await snapshot();
		expect(snap.history).toEqual([]);
		for (const run of snap.runs)
			expect(run.row).toMatchObject({ saved_report: null, part_delivery: null, final_text: null, send_attempt_at: null });
	}
	async function save(report = reports[0]!) {
		expect((await claimRun(scope.leagueId, scope.week, 'saved-owner', expires(), null, sql)).claimed).toBe(true);
		expect(await recordApprovedReport(report, 'saved-owner', sql)).toBe(true);
		return reference(report);
	}
	async function legacy(status: 'failed' | 'delivery_unknown' | 'sent' = 'failed') {
		const text = `Legacy exact bytes\n${editorialFixtureQuote}`;
		expect((await claimRun(scope.leagueId, scope.week, 'legacy-owner', expires(), null, sql)).claimed).toBe(true);
		expect(await recordAttemptText(scope.leagueId, scope.week, 'legacy-owner', text, sql)).toBe(true);
		if (status === 'failed')
			expect(await markFailed(scope.leagueId, scope.week, 'legacy-owner', 'fixture delivery failed', 'reply_delivery', 'delivery_failed', sql)).toBe(true);
		else if (status === 'sent')
			expect(await markSent(scope.leagueId, scope.week, 'legacy-owner', 'old-receipt', sql)).toBe(true);
		else
			await markDeliveryUnknown(scope.leagueId, scope.week, 'legacy-owner', 'fixture unknown', sql);
		return text;
	}

	function harness(options: {
		multipart?: boolean;
		nfl?: boolean;
		signal?: AbortSignal;
		fault?: Parameters<typeof watchedSql>[1];
		respond?: (input: EditorialModelInput, value: RecapEvidencePacket) => unknown | Promise<unknown>;
		afterPrepare?: (outcome: EditorialOutcome) => Promise<void>;
		send?: (index: number) => Promise<SendOutcome>;
		luna?: (afterDelivery: boolean, ref: SavedReportReference) => Promise<LunaAction>;
	} = {}) {
		const database = watchedSql(sql, options.fault);
		const events = { source: 0, archive: 0, nfl: 0, prepare: 0, publish: 0, legacy: 0 };
		const notices: string[] = [];
		const sent: Array<{ groupId: string; text: string }> = [];
		const publicationResults: Array<Awaited<ReturnType<ReturnType<typeof CreatePublication>>>> = [];
		const intents: Array<{ kind: string; paid: string | null; call: unknown; packetJson: string | null }> = [];
		let collected: RecapEvidencePacket | undefined;
		let bound: SavedReportReference;
		async function observeIntent(kind: 'nfl' | 'writer' | 'reviewer') {
			const owned = await state();
			const debug = await readGenerationDebug({ ...scope, attemptId: owned.generation.current.id }, sql);
			intents.push({
				kind,
				paid: owned.generation.current.paidWorkAtUtc,
				call: structuredClone(owned.generation.current.calls.at(-1)),
				packetJson: debug!.bundle.packetJson,
			});
		}
		const editorial = editorialFixtureRuntime(async (input) => {
			await observeIntent(input.role);
			return options.respond
				? options.respond(input, collected!)
				: input.role === 'writer'
					? { case: 'completed', result: draftFor(collected!, options.multipart) }
					: passingEditorialReview(input.data);
		});
		const luna = lunaRuntime(async (modelOptions) => {
			const afterDelivery = modelOptions.prompt.some((row: any) => row.role === 'tool');
			if (options.luna)
				return options.luna(afterDelivery, bound);
			if (!afterDelivery)
				return { tool: true };
			const receipt = await readSavedReportReceipt(bound, sql);
			return { handback: { case: 'completed', result: { reportId: receipt.reportId, status: receipt.status } } };
		});
		const prepare = createEditorial(editorial.runtime);
		const publish = createPublication(luna.runtime, {
			leagueId: scope.leagueId,
			groupId: scope.groupId,
			sql: database.sql,
			sendExact: async (groupId, text) => {
				const saved = await getSavedReportState(bound, sql);
				expect(saved).not.toBeNull();
				const index = saved!.progress.parts.findIndex(attempts => savedPartStatus(attempts) === 'sending');
				expect(index).toBeGreaterThanOrEqual(0);
				expect(Buffer.from(text)).toEqual(Buffer.from(saved!.report.parts[index]!));
				expect(groupId).toBe(scope.groupId);
				expect(saved!.progress.parts[index]!.at(-1)).toMatchObject({
					state: 'sending',
					claimToken: saved!.claimToken,
					operationId: saved!.progress.operationId,
				});
				expect(saved!.sendAttemptAt).not.toBeNull();
				const savedHistory = await sql`SELECT final_text, facts FROM fantasy_recap_generations`;
				expect([...savedHistory]).toEqual([{ final_text: saved!.report.parts.join('\n\n'), facts: { version: saved!.report.version, report: saved!.report } }]);
				sent.push({ groupId, text });
				return options.send ? options.send(sent.length - 1) : accepted(`fixture-${sent.length}`);
			},
		});
		const sleeper = Object.fromEntries(Object.entries(editorialFixtureSleeper).map(([key, method]) => [key, (...args: unknown[]) => {
			events.source++;
			return Reflect.apply(method, editorialFixtureSleeper, args);
		}])) as NonNullable<PipelineDeps['sleeper']>;
		const deps: PipelineDeps = {
			sql: database.sql,
			sleeper,
			now: editorialFixtureNow,
			signal: options.signal,
			memory: {
				getThreadById: async ({ threadId }) => {
					events.archive++;
					return {
						id: threadId,
						resourceId: threadId,
						createdAt: editorialFixtureNow(),
						updatedAt: editorialFixtureNow(),
					};
				},
				listMessages: async () => {
					const threadId = `fantasy-group-${scope.groupId}`;
					events.archive++;
					return { total: 1, page: 0, perPage: 1000, hasMore: false, messages: [{
						id: 'exact-source',
						threadId,
						resourceId: threadId,
						role: 'user',
						createdAt: new Date('2026-09-02T01:00:00Z'),
						content: { format: 2, parts: [{ type: 'text', text: editorialFixtureQuote }], metadata: { channel: 'sendblue', groupId: scope.groupId, senderNumber: '+15550000001', sentAt: '2026-09-02T01:00:00Z' } },
					}] };
				},
			},
			readNfl: options.nfl === false
				? undefined
				: async () => {
					events.nfl++;
					await observeIntent('nfl');
					return structuredClone(emptyNfl);
				},
			prepare: async (value, signal, observer) => {
				events.prepare++;
				collected = value;
				const outcome = await prepare(value, signal, observer);
				await options.afterPrepare?.(outcome);
				return outcome;
			},
			publish: async (ref, token, signal) => {
				events.publish++;
				bound = ref;
				const result = await publish(ref, token, signal);
				publicationResults.push(result);
				return result;
			},
			notify: async (text) => { notices.push(text); },
			legacyRetry: async (week) => {
				events.legacy++;
				return runWeeklyRecap({
					config: request.config,
					week,
					model: 'never-used',
					loadFacts: async () => {
						events.source++;
						throw new Error('Legacy retry must not collect');
					},
					generate: async () => { throw new Error('Legacy retry must not generate'); },
				}, {
					runs: createRunsStore(scope.leagueId, database.sql),
					recaps: { ensureSchema: () => ensureFantasyRecapsTable(database.sql), record: async () => { throw new Error('Legacy retry must not rewrite history'); } },
					groupId: scope.groupId,
					leagueId: scope.leagueId,
					now: () => new Date(),
					readThreadMessages: async () => {
						events.archive++;
						throw new Error('Legacy retry must not read archive');
					},
					send: {
						sendToGroup: async (groupId, text) => {
							sent.push({ groupId, text });
							return accepted();
						},
						directMessage: async (text) => { notices.push(text); },
					},
				});
			},
		};
		const h = {
			deps,
			database,
			events,
			intents,
			notices,
			sent,
			editorial,
			luna,
			publicationResults,
			packet: () => collected,
		};
		checks.push(() => {
			expect(database.queries()).toBeLessThanOrEqual(400);
			for (const intent of intents) {
				expect(intent.paid).not.toBeNull();
				expect(intent.call).toMatchObject({ kind: intent.kind, state: 'reserved', settledAtUtc: null });
				if (intent.kind !== 'nfl')
					expect(intent.packetJson).toBe(JSON.stringify(collected));
			}
			expect(editorial.resolved.every(id => id === 'gpt-6-astra')).toBe(true);
			expect(luna.resolved.every(id => id === 'gpt-6-luna')).toBe(true);
		});
		return h;
	}
	function noGeneration(h: ReturnType<typeof harness>) {
		expect(h.events).toMatchObject({ source: 0, archive: 0, nfl: 0, prepare: 0 });
		expect(h.editorial.calls).toEqual([]);
	}
	function noEffects(h: ReturnType<typeof harness>) {
		noGeneration(h);
		expect(h.events.publish).toBe(0);
		expect(h.sent).toEqual([]);
		expect(h.luna.calls).toEqual([]);
	}

	test('an unclosed queried period cannot create a generation attempt or spend', async () => {
		const h = harness();
		expect(await runRecapPipeline({ ...request, window: { status: 'blocked', reason: 'calendar_period_unclosed' } }, h.deps))
			.toMatchObject({ outcome: 'noop-no-completed-week', reason: 'calendar_period_unclosed' });
		noEffects(h);
		expect((await snapshot()).runs).toEqual([]);
	});

	test('a supplied moving bound cannot override the queried proof before a claim or paid work', async () => {
		const h = harness();
		const reporting = structuredClone(request.window);
		reporting.window.endAtUtc = editorialFixtureNow().toISOString();
		expect(await runRecapPipeline({ ...request, window: reporting }, h.deps)).toMatchObject({ outcome: 'failed' });
		noEffects(h);
		expect((await snapshot()).runs).toEqual([]);
	});

	test('a proofless pre-fix held attempt cannot be retrofitted or even resolve a replacement calendar', async () => {
		const old = initialGenerationState(scope, editorialFixtureWindow, randomUUID(), new Date().toISOString());
		old.current.phase = 'blocked';
		old.current.reasonCode = 'legacy_hold';
		await sql`INSERT INTO fantasy_recap_runs (league_id, fantasy_week, status, editorial_attempt) VALUES (${scope.leagueId}, ${scope.week}, 'failed', ${old})`;
		const before = await snapshot();
		let calendars = 0;
		const h = harness();
		const result = await runRecapPipeline({ ...request, restartAttemptId: old.current.id, window: async () => {
			calendars++;
			return request.window;
		} }, h.deps);
		expect(result).toMatchObject({ outcome: 'failed', reason: 'reporting_calendar_missing' });
		expect(calendars).toBe(0);
		noEffects(h);
		expect(await snapshot()).toEqual(before);
	});

	test('a held verified attempt cannot silently restart under a changed calendar', async () => {
		const first = harness({ respond: async () => ({ case: 'blocked', reason: 'fixture_stop', progress: null }) });
		const held = await runRecapPipeline(request, first.deps);
		expect(held).toMatchObject({ outcome: 'failed', reason: 'editorial_blocked' });
		const before = await snapshot();
		const h = harness();
		const changed = reportingWindowFixture({ ...editorialFixtureWindow, startAtUtc: '2026-09-02T00:00:00.000Z' });
		expect(await runRecapPipeline({ ...request, window: changed, restartAttemptId: held.attemptId }, h.deps))
			.toMatchObject({ outcome: 'failed', reason: 'reporting_calendar_changed' });
		noEffects(h);
		expect(await snapshot()).toEqual(before);
	});

	test('reordered identical games permit restart without rewriting the retained proof', async () => {
		const original = structuredClone(request.window);
		original.source.games.push({ ...original.source.games[0]!, id: '401000002', home: 'KC', away: 'DEN' });
		const first = harness({ respond: async () => ({ case: 'blocked', reason: 'fixture_stop', progress: null }) });
		const held = await runRecapPipeline({ ...request, window: original }, first.deps);
		const retained = structuredClone((await state()).generation.current.calendarProof);
		const reordered = structuredClone(original);
		reordered.source.games.reverse();
		const h = harness();
		expect(await runRecapPipeline({ ...request, window: reordered, restartAttemptId: held.attemptId }, h.deps))
			.toMatchObject({ outcome: 'sent' });
		expect((await state()).generation.current.calendarProof).toEqual(retained);
		expect(h.packet()?.scope.calendarProof).toEqual(retained);
	});

	test('a fresh verification timestamp does not replace the retained proof on explicit restart', async () => {
		const first = harness({ respond: async () => ({ case: 'blocked', reason: 'fixture_stop', progress: null }) });
		const held = await runRecapPipeline(request, first.deps);
		const retained = (await state()).generation.current.calendarProof;
		const fresh = structuredClone(request.window);
		fresh.source.retrievedAtUtc = '2026-09-09T01:00:00.000Z';
		const h = harness();
		expect(await runRecapPipeline({ ...request, window: fresh, restartAttemptId: held.attemptId }, h.deps))
			.toMatchObject({ outcome: 'sent' });
		const next = await state();
		expect(next.generation.current.calendarProof).toEqual(retained);
		expect(next.generation.prior[0]!.calendarProof).toEqual(retained);
		expect(h.packet()?.scope.calendarProof).toEqual(retained);
	});

	test.each([false, true])('real collection, native typed Astra/Luna, atomic approval and exact sent bytes (multipart=%s)', async (multipart) => {
		const h = harness({ multipart });
		const result = await runRecapPipeline(request, h.deps);
		expect(result).toMatchObject({ outcome: 'sent', counts: { nfl: 3, drafts: 1, reviews: 1 } });
		expect(h.events).toMatchObject({ source: 8, archive: 2, nfl: 3, prepare: 1, publish: 1, legacy: 0 });
		expect(h.editorial.calls.map(call => call.role)).toEqual(['writer', 'reviewer']);
		expect(h.luna.calls).toHaveLength(2);
		const owned = await state();
		const debug = await readGenerationDebug({ ...scope, attemptId: result.attemptId! }, sql);
		expect(debug!.bundle.packetJson).toBe(JSON.stringify(h.packet()));
		expect(debug!.bundle.outputs.map(output => output.kind)).toEqual(['nfl', 'nfl', 'nfl', 'writer', 'reviewer']);
		expect(debug!.bundle.outputs.slice(0, 3).map(output => output.valueJson))
			.toEqual(Array.from({ length: 3 }, () => JSON.stringify(emptyNfl)));
		expect(JSON.parse(debug!.bundle.outputs[3]!.valueJson!)).toEqual(draftFor(h.packet()!, multipart));
		expect(JSON.parse(debug!.bundle.outputs[4]!.valueJson!))
			.toEqual(passingEditorialReview(h.editorial.calls[1]!.data).result);
		expect(owned.generation.current.calls.every(call => call.state === 'completed')).toBe(true);
		expect(owned.generation.current).toMatchObject({ phase: 'approved', reportId: result.reportId, evidenceId: h.packet()!.id });
		const ref = { ...scope, reportId: result.reportId! };
		const saved = (await getSavedReportState(ref, sql))!;
		expect(parseSavedReport(saved.report)).toEqual(saved.report);
		expect(saved.report.parts).toHaveLength(multipart ? 3 : 1);
		expect(saved.report.parts.join('')).toContain(editorialFixtureQuote);
		expect(saved.report.parts.join('')).not.toBe(saved.report.parts.join('').normalize('NFC'));
		expect(h.sent.map(call => call.text)).toEqual(saved.report.parts);
		expect(saved.progress.parts.map(savedPartStatus)).toEqual(saved.report.parts.map(() => 'accepted'));
		expect(saved.progress.parts.map(attempts => attempts.length)).toEqual(saved.report.parts.map(() => 1));
		expect(saved).toMatchObject({ status: 'sent', deliverySource: 'api' });
		const { id, ...content } = saved.report;
		expect(id).toBe(`report-${createHash('sha256').update(JSON.stringify(content)).digest('hex')}`);
		const before = await snapshot();
		expect(before.history).toHaveLength(1);
		expect(before.history[0]!.row.final_text).toBe(saved.report.parts.join('\n\n'));
		expect(before.runs[0]!.row.final_text).toBe(before.history[0]!.row.final_text);
		const restarted = harness();
		expect((await runRecapPipeline(request, restarted.deps)).outcome).toBe('noop-already-sent');
		noEffects(restarted);
		expect(await snapshot()).toEqual(before);
		for (const privateValue of [scope.groupId, scope.leagueId, editorialFixtureQuote, owned.claimToken!])
			expect(JSON.stringify(result)).not.toContain(privateValue);
	});

	test.each([0, 1, 2])('new-format safe retry sends only exact remaining parts after failure at index %s', async (failedIndex) => {
		const report = reports[1]!;
		const ref = await save(report);
		let sent = 0;
		expect((await dispatchSavedReport(ref, 'saved-owner', sql, async () => sent++ === failedIndex ? { kind: 'failed', error: 'fixture rejected' } : accepted())).status).toBe('failed');
		const before = await snapshot();
		const h = harness();
		expect((await runRecapPipeline(request, h.deps)).outcome).toBe('sent');
		noGeneration(h);
		expect(h.events.legacy).toBe(0);
		expect(h.sent.map(call => call.text)).toEqual(report.parts.slice(failedIndex));
		const saved = (await getSavedReportState(ref, sql))!;
		expect(saved.report).toEqual(report);
		expect(saved.progress.parts.map(attempts => attempts.length))
			.toEqual(report.parts.map((_, i) => i === failedIndex ? 2 : 1));
		expect((await snapshot()).history).toEqual(before.history);
	});

	test.each([false, true])('uncertain saved delivery alerts once with exact selectors even if notification throws=%s', async (throws) => {
		const h = harness({ send: async () => ({ kind: 'unknown', error: 'fixture timeout' }) });
		const notify = h.deps.notify;
		h.deps.notify = async (text) => {
			await notify(text);
			if (throws)
				throw new Error('fixture notification unavailable');
		};
		const result = await runRecapPipeline(request, h.deps);
		expect(result.outcome).toBe('delivery_unknown');
		const ref = { ...scope, reportId: result.reportId! };
		const saved = (await getSavedReportState(ref, sql))!;
		const attempt = saved.progress.parts[0]!.at(-1)!;
		expect(h.notices).toHaveLength(1);
		expect(h.notices[0]).toContain(`confirm-sent --week 1 --report-id ${result.reportId} --part 1 --attempt-id ${attempt.id}`);
		const after = await snapshot();
		const again = harness();
		expect((await runRecapPipeline(request, again.deps)).outcome).toBe('blocked-delivery-unknown');
		expect(again.notices).toEqual([]);
		noEffects(again);
		expect(await snapshot()).toEqual(after);
	});

	test('legacy safe retry uses only persisted exact bytes, with no evidence or private model', async () => {
		const text = await legacy();
		const h = harness();
		expect((await runRecapPipeline(request, h.deps)).outcome).toBe('sent');
		noGeneration(h);
		expect(h.events).toMatchObject({ legacy: 1, publish: 0 });
		expect(h.sent).toEqual([{ groupId: scope.groupId, text }]);
		expect(h.luna.calls).toEqual([]);
		expect((await snapshot()).history).toEqual([]);
	});

	test.each(['new', 'legacy'] as const)('%s unknown delivery blocks all source/model/send effects across recreated dependencies', async (format) => {
		if (format === 'new') {
			const ref = await save(reports[1]);
			let count = 0;
			await dispatchSavedReport(ref, 'saved-owner', sql, async () => ++count === 2 ? { kind: 'unknown', error: 'fixture unknown' } : accepted());
		} else {
			await legacy('delivery_unknown');
		}
		if (format === 'new') {
			const first = harness();
			expect((await runRecapPipeline(request, first.deps)).outcome).toBe('blocked-delivery-unknown');
			expect(first.notices).toHaveLength(1);
			noEffects(first);
		}
		const before = await snapshot();
		for (let retry = 0; retry < 2; retry++) {
			const h = harness();
			expect((await runRecapPipeline(request, h.deps)).outcome).toBe('blocked-delivery-unknown');
			noEffects(h);
		}
		expect(await snapshot()).toEqual(before);
	});

	test('confirmed unknown prefix retains hold on the untouched tail', async () => {
		const report = reports[1]!;
		const ref = await save(report);
		let count = 0;
		await dispatchSavedReport(ref, 'saved-owner', sql, async () => ++count === 2 ? { kind: 'unknown', error: 'fixture unknown' } : accepted());
		const saved = (await getSavedReportState(ref, sql))!;
		expect(await confirmSavedReportPart(ref, 2, saved.progress.parts[1]!.at(-1)!.id, sql)).toBe(true);
		const h = harness();
		expect((await runRecapPipeline(request, h.deps)).outcome).toBe('blocked-delivery-unknown');
		expect(h.notices).toHaveLength(1);
		noEffects(h);
		const before = await snapshot();
		const again = harness();
		expect((await runRecapPipeline(request, again.deps)).outcome).toBe('blocked-delivery-unknown');
		expect(again.notices).toEqual([]);
		expect(await snapshot()).toEqual(before);
	});

	test('legacy already-sent is read-only with no retry callback', async () => {
		await legacy('sent');
		const before = await snapshot();
		const h = harness();
		expect((await runRecapPipeline(request, h.deps)).outcome).toBe('noop-already-sent');
		noEffects(h);
		expect(h.events.legacy).toBe(0);
		expect(await snapshot()).toEqual(before);
	});

	const failingReview = ({ role, data }: EditorialModelInput, value: RecapEvidencePacket) => role === 'writer'
		? { case: 'completed', result: draftFor(value) }
		: { case: 'completed', result: { ...passingEditorialReview(data).result, verdict: 'fail', issues: [{ path: 'manager', category: 'grounding', message: 'Fixture unsupported claim', supportIds: ['score:1:1'] }] } };

	test('terminal review block notifies once and never refreshes paid budget across recreated dependencies', async () => {
		const h = harness({ respond: failingReview });
		expect((await runRecapPipeline(request, h.deps)).outcome).toBe('failed');
		const owned = await state();
		expect(owned.generation.current).toMatchObject({ phase: 'blocked', counts: { nfl: 3, drafts: 3, reviews: 3 } });
		expect(h.notices).toHaveLength(1);
		expect(h.notices[0]).toContain(`--attempt-id ${owned.generation.current.id}`);
		expect(h.events.publish).toBe(0);
		const before = await snapshot();
		for (let retry = 0; retry < 2; retry++) {
			const again = harness();
			expect((await runRecapPipeline(request, again.deps)).attemptId).toBe(owned.generation.current.id);
			noEffects(again);
			expect(again.notices).toEqual([]);
		}
		expect(await snapshot()).toEqual(before);
		await unpublished();
	});

	test('restart grants exactly one new attempt for the exact current blocked selector', async () => {
		const first = harness({ respond: failingReview });
		await runRecapPipeline(request, first.deps);
		const old = (await state()).generation.current.id;
		const before = await snapshot();
		const wrong = harness();
		expect((await runRecapPipeline({ ...request, restartAttemptId: randomUUID() }, wrong.deps)).outcome).not.toBe('sent');
		noEffects(wrong);
		expect(await snapshot()).toEqual(before);
		const next = harness({ respond: failingReview });
		await runRecapPipeline({ ...request, restartAttemptId: old }, next.deps);
		const current = await state();
		expect(current.generation.current.id).not.toBe(old);
		expect(current.generation.prior.map(attempt => attempt.id)).toEqual([old]);
		expect(current.generation.current.counts).toEqual({ nfl: 3, drafts: 3, reviews: 3 });
		const after = await snapshot();
		const reused = harness();
		await runRecapPipeline({ ...request, restartAttemptId: old }, reused.deps);
		noEffects(reused);
		expect(await snapshot()).toEqual(after);
		await unpublished();
	});

	test.each(['new', 'legacy'] as const)('restart selector can never select an existing %s publication', async (format) => {
		if (format === 'new')
			await save();
		else await legacy();
		const before = await snapshot();
		const h = harness();
		expect(await runRecapPipeline({ ...request, restartAttemptId: randomUUID() }, h.deps)).toMatchObject({ outcome: 'failed', reason: 'restart_has_publication' });
		noEffects(h);
		expect(h.events.legacy).toBe(0);
		expect(await snapshot()).toEqual(before);
	});

	test.each(['no-storage', 'missing-thread', 'read-error'] as const)('missing archive (%s) fails closed instead of becoming empty usable chat', async (failure) => {
		const h = harness();
		if (failure === 'no-storage') {
			h.deps.memory = null;
		} else if (failure === 'missing-thread') {
			h.deps.memory!.getThreadById = async () => null;
		} else {
			h.deps.memory!.listMessages = async () => {
				throw new Error('fixture archive unavailable');
			};
		}
		expect(await runRecapPipeline(request, h.deps)).toMatchObject({ outcome: 'failed', reason: 'evidence_blocked' });
		expect(h.events).toMatchObject({ nfl: 0, prepare: 0, publish: 0 });
		const owned = await state();
		expect(owned.generation.current).toMatchObject({ phase: 'source_retryable', paidWorkAtUtc: null, counts: { nfl: 0, drafts: 0, reviews: 0 } });
		const debug = await readGenerationDebug({ ...scope, attemptId: owned.generation.current.id }, sql);
		const blocked = JSON.parse(debug!.bundle.packetJson!);
		expect(blocked.admission.canDraft).toBe(false);
		expect(blocked.chat.status).not.toBe('empty');
		expect(blocked.gaps.some((gap: any) => gap.source === 'chat' && gap.blocking)).toBe(true);
		await unpublished();
	});

	test('positive source-only failure before paid work permits one automatic fresh attempt', async () => {
		const h = harness();
		h.deps.memory = null;
		await runRecapPipeline(request, h.deps);
		const old = (await state()).generation.current.id;
		const again = harness();
		expect((await runRecapPipeline(request, again.deps)).outcome).toBe('sent');
		const owned = await state();
		expect(owned.generation.prior).toMatchObject([{ id: old, phase: 'source_retryable', paidWorkAtUtc: null }]);
		expect(owned.generation.current.id).not.toBe(old);
		expect((await snapshot()).history).toHaveLength(1);
	});

	test('essential Sleeper failure before paid work is source-retryable, not a terminal paid hold', async () => {
		const h = harness();
		h.deps.sleeper!.getLeague = async () => {
			throw new Error('fixture league unavailable');
		};
		expect((await runRecapPipeline(request, h.deps)).outcome).toBe('failed');
		expect((await state()).generation.current).toMatchObject({ phase: 'source_retryable', paidWorkAtUtc: null });
		expect(h.events).toMatchObject({ nfl: 0, prepare: 0, publish: 0 });
		const retry = harness();
		expect((await runRecapPipeline(request, retry.deps)).outcome).toBe('sent');
		expect((await state()).generation.prior).toHaveLength(1);
	});

	test('paid model failure is a durable hold, never source-retryable or automatically regenerated', async () => {
		const h = harness({ respond: async () => {
			throw new Error('fixture paid model unavailable');
		} });
		await runRecapPipeline(request, h.deps);
		const owned = await state();
		expect(owned.generation.current.phase).toBe('blocked');
		expect(owned.generation.current.paidWorkAtUtc).not.toBeNull();
		const before = await snapshot();
		const again = harness();
		await runRecapPipeline(request, again.deps);
		noEffects(again);
		expect(await snapshot()).toEqual(before);
		await unpublished();
	});

	test('pre-aborted caller starts no collection, NFL, editorial or publication work', async () => {
		const controller = new AbortController();
		controller.abort();
		const h = harness({ signal: controller.signal });
		expect((await runRecapPipeline(request, h.deps)).outcome).not.toBe('sent');
		noEffects(h);
		await unpublished();
	});

	test.each(['writer', 'reviewer'] as const)('caller abort during native %s holds the paid attempt without sending or regranting', async (role) => {
		const controller = new AbortController();
		let modelSignal: AbortSignal | undefined;
		const h = harness({ signal: controller.signal, respond: async (input, value) => {
			if (input.role === role) {
				modelSignal = input.options.abortSignal;
				controller.abort();
			}
			return input.role === 'writer' ? { case: 'completed', result: draftFor(value) } : passingEditorialReview(input.data);
		} });
		await runRecapPipeline(request, h.deps);
		expect(modelSignal?.aborted).toBe(true);
		expect(h.editorial.calls.map(call => call.role)).toEqual(role === 'writer' ? ['writer'] : ['writer', 'reviewer']);
		expect(h.events.publish).toBe(0);
		expect((await state()).generation.current.phase).toBe('blocked');
		const before = await snapshot();
		const retry = harness();
		await runRecapPipeline(request, retry.deps);
		noEffects(retry);
		expect(await snapshot()).toEqual(before);
		await unpublished();
	});

	test('global caller abort reaches an in-flight Sleeper read, not only the editorial workflow', async () => {
		const controller = new AbortController();
		const entered = deferred();
		let sleeperSignal: AbortSignal | undefined;
		const h = harness({ signal: controller.signal });
		h.deps.sleeper!.getNflState = async (signal) => {
			sleeperSignal = signal;
			entered.resolve();
			return new Promise((_, reject) => {
				if (signal?.aborted)
					reject(signal.reason);
				else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
		};
		const pending = runRecapPipeline(request, h.deps);
		try {
			await entered.promise;
			controller.abort();
			await pending;
			expect(sleeperSignal?.aborted).toBe(true);
			expect(h.events).toMatchObject({ nfl: 0, prepare: 0, publish: 0 });
			await unpublished();
		} finally {
			controller.abort();
			await pending;
		}
	}, 10_000);

	test('persisted global deadline aborts in-flight Sleeper even without caller cancellation', async () => {
		const h = harness();
		const original = h.deps.sql as TransactionalSql;
		let shortened = false;
		const timed: SqlLike = (strings, ...values) => original(strings, ...values);
		Object.assign(timed, { begin: async <T>(action: (tx: SqlLike) => Promise<T>): Promise<T> => {
			const result = await original.begin(action);
			const owned = await getGenerationRun(scope, sql);
			if (!shortened && owned) {
				shortened = true;
				const generation = owned.generation;
				generation.current.workDeadlineAtUtc = new Date(Date.now() + 500).toISOString();
				await sql`UPDATE fantasy_recap_runs SET editorial_attempt = ${parseGenerationState(generation)}`;
			}
			return result;
		} });
		h.deps.sql = timed;
		let sleeperSignal: AbortSignal | undefined;
		h.deps.sleeper!.getNflState = async (signal) => {
			sleeperSignal = signal;
			return new Promise((_, reject) => {
				if (signal?.aborted)
					reject(signal.reason);
				else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
		};
		expect((await runRecapPipeline(request, h.deps)).outcome).toBe('failed');
		expect(shortened).toBe(true);
		expect(sleeperSignal?.aborted).toBe(true);
		expect(h.events).toMatchObject({ nfl: 0, prepare: 0, publish: 0 });
		await unpublished();
	}, 10_000);

	test.each(['expired', 'replaced', 'wrong-token'] as const)('fully approved native result cannot publish under %s owner', async (failure) => {
		const h = harness({ afterPrepare: async (outcome) => {
			expect(outcome.status).toBe('approved');
			if (failure === 'expired')
				await sql`UPDATE fantasy_recap_runs SET lease_expires_at = ${new Date(Date.now() - 1000).toISOString()}`;
			else await sql`UPDATE fantasy_recap_runs SET claim_token = ${failure === 'replaced' ? randomUUID() : 'wrong-owner'}`;
		} });
		await runRecapPipeline(request, h.deps);
		expect(h.events.publish).toBe(0);
		expect(h.sent).toEqual([]);
		const retry = harness();
		await runRecapPipeline(request, retry.deps);
		noEffects(retry);
		await unpublished();
	});

	test('wrong publication token cannot convert a saved approval into transport authority', async () => {
		const h = harness();
		const publish = h.deps.publish;
		h.deps.publish = (ref, _token, signal) => publish(ref, 'wrong-token', signal);
		expect((await runRecapPipeline(request, h.deps)).outcome).toBe('blocked-active-claim');
		expect(h.sent).toEqual([]);
		expect(h.luna.calls).toEqual([]);
		expect((await state()).generation.current.phase).toBe('approved');
		expect((await snapshot()).history).toHaveLength(1);
		const retry = harness();
		expect((await runRecapPipeline(request, retry.deps)).outcome).toBe('blocked-active-claim');
		noEffects(retry);
	});

	test('same-week concurrent entry owns one collection, paid budget, history and send', async () => {
		const entered = deferred();
		const release = deferred();
		const first = harness({ respond: async (input, value) => {
			if (input.role === 'writer') {
				entered.resolve();
				await release.promise;
			}
			return input.role === 'writer' ? { case: 'completed', result: draftFor(value) } : passingEditorialReview(input.data);
		} });
		const pending = runRecapPipeline(request, first.deps);
		try {
			await entered.promise;
			const second = harness();
			expect((await runRecapPipeline(request, second.deps)).outcome).toBe('blocked-active-claim');
			noEffects(second);
			release.resolve();
			expect((await pending).outcome).toBe('sent');
			expect(first.sent).toHaveLength(1);
			expect((await state()).generation.prior).toEqual([]);
			expect((await snapshot()).history).toHaveLength(1);
		} finally {
			release.resolve();
			await pending;
		}
	}, 15_000);

	const approvalQuery: QueryMatch = query => query.includes('insert into fantasy_recap_generations');
	const generationUpdate = (predicate: (generation: GenerationState) => boolean): QueryMatch => (query, values) => query.startsWith('update fantasy_recap_runs')
		&& query.includes('editorial_attempt =') && values.some(value => value && typeof value === 'object' && 'current' in value && predicate(value as GenerationState));

	test.each(['before', 'after'] as const)('%s-commit approval failure cannot regenerate, duplicate history or resend', async (mode) => {
		const h = harness({ fault: { mode, matches: approvalQuery } });
		const result = await runRecapPipeline(request, h.deps);
		expect(h.database.hits()).toBe(1);
		if (mode === 'before') {
			expect(result.outcome).not.toBe('sent');
			expect(h.sent).toEqual([]);
			await unpublished();
		} else {
			expect(result.outcome).toBe('sent');
			expect(h.sent).toHaveLength(1);
			expect((await snapshot()).history).toHaveLength(1);
		}
		const before = await snapshot();
		const retry = harness();
		await runRecapPipeline(request, retry.deps);
		noEffects(retry);
		expect(await snapshot()).toEqual(before);
	});

	test.each(['claim', 'nfl-intent', 'writer-output', 'reviewer-output'] as const)('lost %s acknowledgement never grants a duplicate generation or send', async (stage) => {
		const matches: QueryMatch = stage === 'claim'
			? query => query.includes('insert into fantasy_recap_runs')
			: stage === 'nfl-intent'
				? generationUpdate(generation => generation.current.calls.some(call => call.kind === 'nfl' && call.state === 'reserved'))
				: generationUpdate(generation => generation.current.calls.some(call => call.kind === (stage === 'writer-output' ? 'writer' : 'reviewer') && call.state === 'completed'));
		const h = harness({ fault: { mode: 'after', matches } });
		await runRecapPipeline(request, h.deps);
		expect(h.database.hits()).toBe(1);
		const owned = await state();
		if (stage === 'claim')
			expect(h.events.source).toBe(0);
		if (stage === 'nfl-intent') {
			expect(h.events.nfl).toBe(0);
			expect(owned.generation.current.counts.nfl).toBe(1);
		}
		const before = await snapshot();
		const retry = harness();
		await runRecapPipeline(request, retry.deps);
		noEffects(retry);
		expect(await snapshot()).toEqual(before);
		expect(h.sent.length).toBeLessThanOrEqual(1);
	});

	test('failed packet storage after paid NFL work holds, never silently skips capture to draft', async () => {
		const h = harness({ fault: { mode: 'before', matches: generationUpdate(generation => Object.values(generation.debug).some(bundle => bundle.packetJson !== null)) } });
		await runRecapPipeline(request, h.deps);
		expect(h.database.hits()).toBe(1);
		expect(h.events).toMatchObject({ nfl: 3, prepare: 0, publish: 0 });
		expect((await state()).generation.current.phase).toBe('blocked');
		const retry = harness();
		await runRecapPipeline(request, retry.deps);
		noEffects(retry);
		await unpublished();
	});

	test('lost accepted-part SQL acknowledgement keeps authoritative sent and sends exactly once', async () => {
		const h = harness({ fault: { mode: 'after', matches: (query, values) => query.startsWith('update fantasy_recap_runs') && query.includes('part_delivery =')
			&& values.some(value => value && typeof value === 'object' && 'parts' in value && Array.isArray(value.parts)
				&& value.parts.flat().some((part: any) => part?.state === 'accepted')) } });
		expect((await runRecapPipeline(request, h.deps)).outcome).toBe('sent');
		expect(h.database.hits()).toBe(1);
		expect(h.sent).toHaveLength(1);
		const before = await snapshot();
		const retry = harness();
		expect((await runRecapPipeline(request, retry.deps)).outcome).toBe('noop-already-sent');
		noEffects(retry);
		expect(await snapshot()).toEqual(before);
	});

	test.each(['refusal', 'wrong-status', 'throw'] as const)('Luna %s after delivery cannot erase the effect receipt or replay bytes', async (failure) => {
		const h = harness({ luna: async (afterDelivery, ref) => {
			if (!afterDelivery)
				return { tool: true };
			expect((await getSavedReportState(ref, sql))!.status).toBe('sent');
			if (failure === 'throw')
				throw new Error('fixture lost model result');
			return { handback: failure === 'refusal'
				? { case: 'blocked', reason: 'Fixture refusal', progress: null }
				: { case: 'completed', result: { reportId: ref.reportId, status: 'failed' } } };
		} });
		expect((await runRecapPipeline(request, h.deps)).outcome).toBe('sent');
		expect(h.publicationResults[0]!.contribution.case).not.toBe('completed');
		expect(h.publicationResults[0]!.receipt.status).toBe('sent');
		const retry = harness();
		expect((await runRecapPipeline(request, retry.deps)).outcome).toBe('noop-already-sent');
		noEffects(retry);
		expect(h.sent).toHaveLength(1);
	});

	test('spoofed sent handback without delivery leaves held saved report, never a sent effect', async () => {
		const h = harness({ luna: async (_, ref) => ({ handback: { case: 'completed', result: { reportId: ref.reportId, status: 'sent' } } }) });
		expect((await runRecapPipeline(request, h.deps)).outcome).toBe('failed');
		expect(h.sent).toEqual([]);
		expect(h.publicationResults[0]!.receipt).toMatchObject({ status: 'failed', acceptedParts: 0 });
		const retry = harness();
		expect((await runRecapPipeline(request, retry.deps)).outcome).toBe('blocked-delivery-unknown');
		noEffects(retry);
		expect((await snapshot()).history).toHaveLength(1);
	});

	test.each(['before', 'after'] as const)('publication invocation throws %s transport: no second generation and no erased accepted receipt', async (when) => {
		const h = harness();
		const actual = h.deps.publish;
		h.deps.publish = async (...args) => {
			if (when === 'after')
				await actual(...args);
			throw new Error('fixture publication result lost');
		};
		const result = await runRecapPipeline(request, h.deps);
		expect(result.outcome).toBe(when === 'after' ? 'sent' : 'failed');
		expect(h.sent).toHaveLength(when === 'after' ? 1 : 0);
		expect((await snapshot()).history).toHaveLength(1);
		const before = await snapshot();
		const retry = harness();
		expect((await runRecapPipeline(request, retry.deps)).outcome).toBe(when === 'after' ? 'noop-already-sent' : 'blocked-delivery-unknown');
		noEffects(retry);
		expect(await snapshot()).toEqual(before);
	});

	test.each(['null-report', 'null-progress', 'invalid-report', 'invalid-progress', 'bad-digest', 'invalid-generation', 'generation-with-legacy-text'] as const)('invalid/mixed %s columns never fall back to legacy or fresh generation', async (failure) => {
		if (failure === 'generation-with-legacy-text') {
			await legacy();
			await sql`UPDATE fantasy_recap_runs SET editorial_attempt = ${{ version: 'unknown-generation-version' }}`;
		} else {
			await save();
			if (failure === 'null-report')
				await sql`UPDATE fantasy_recap_runs SET saved_report = NULL`;
			if (failure === 'null-progress')
				await sql`UPDATE fantasy_recap_runs SET part_delivery = NULL`;
			if (failure === 'invalid-report')
				await sql`UPDATE fantasy_recap_runs SET saved_report = ${{ version: 'invalid' }}`;
			if (failure === 'invalid-progress')
				await sql`UPDATE fantasy_recap_runs SET part_delivery = ${{ parts: [] }}`;
			if (failure === 'bad-digest')
				await sql`UPDATE fantasy_recap_runs SET saved_report = ${{ ...reports[0]!, id: `report-${'0'.repeat(64)}` }}`;
			if (failure === 'invalid-generation')
				await sql`UPDATE fantasy_recap_runs SET editorial_attempt = ${{ version: 'invalid' }}`;
		}
		const before = await snapshot();
		const h = harness();
		const result = await runRecapPipeline(request, h.deps);
		noEffects(h);
		expect(h.events.legacy).toBe(0);
		expect(result.outcome).toBe('failed');
		expect(await snapshot()).toEqual(before);
	});

	test('accepted native result remains approved after a late pipeline caller cancellation', async () => {
		const controller = new AbortController();
		const h = harness({ signal: controller.signal, send: async () => {
			controller.abort();
			return accepted();
		} });
		expect((await runRecapPipeline(request, h.deps)).outcome).toBe('sent');
		expect((await state()).generation.current.phase).toBe('approved');
		const saved = await snapshot();
		expect(saved.runs[0]!.row.status).toBe('sent');
		expect(saved.history).toHaveLength(1);
		const retry = harness();
		expect((await runRecapPipeline(request, retry.deps)).outcome).toBe('noop-already-sent');
		noEffects(retry);
		expect(await snapshot()).toEqual(saved);
	});

	test('expired global work budget stops before any scripted paid model', async () => {
		const h = harness({ nfl: false });
		const original = h.deps.memory!.listMessages;
		h.deps.memory!.listMessages = async (input) => {
			const owned = await state();
			const generation = owned.generation;
			const started = Date.parse(generation.current.startedAtUtc);
			generation.current.workDeadlineAtUtc = new Date(started + 1).toISOString();
			await sql`UPDATE fantasy_recap_runs SET editorial_attempt = ${parseGenerationState(generation)}`;
			return original(input);
		};
		await runRecapPipeline(request, h.deps);
		expect(h.editorial.calls).toEqual([]);
		expect(h.luna.calls).toEqual([]);
		expect(h.sent).toEqual([]);
		await unpublished();
	});
});
