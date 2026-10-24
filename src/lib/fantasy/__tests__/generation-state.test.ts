import type { GenerationCallKind, GenerationDebugOutput, GenerationState } from '../generation-state';
import type { NflSourceResult } from '../nfl-sources.types';
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	GENERATION_LIMITS,
	GENERATION_STATE_VERSION,
	GENERATION_VERSION,
	generationReference,
	generationSummary,
	initialGenerationState,
	parseGenerationState,
	purgeExpiredGenerationDebug,
	retainedGenerationDebug,
} from '../generation-state';
import { editorialFixtureQuote, editorialFixtureWindow, frozenEditorialFixture, validEditorialDraft } from './fixtures/editorial.fixture';
import { reportingWindowFixture } from './fixtures/reporting-window.fixture';

const now = '2026-09-09T00:00:00.000Z';
const scope = { leagueId: 'fixture-league', groupId: 'fixture-group', season: 2026, week: 1 };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (milliseconds: number) => new Date(Date.parse(now) + milliseconds).toISOString();
const proof = reportingWindowFixture(editorialFixtureWindow).source;
const fresh = () => initialGenerationState(scope, editorialFixtureWindow, id(1), now);
const verified = () => initialGenerationState(scope, editorialFixtureWindow, id(1), now, proof);
const digest = (prefix: string) => `${prefix}-${'a'.repeat(64)}`;

type Mutation = (state: GenerationState) => void;
function invalid(value: unknown) {
	let thrown: unknown;
	try {
		parseGenerationState(value);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(Error);
	expect(String(thrown)).toBe('Error: invalid_generation_state');
	expect(thrown).not.toHaveProperty('cause');
	expect(thrown).not.toHaveProperty('issues');
}

function addCall(state: GenerationState, kind: GenerationCallKind = 'writer') {
	const attempt = state.current;
	const key = kind === 'nfl' ? 'nfl' : kind === 'writer' ? 'drafts' : 'reviews';
	const call = {
		id: id(100 + attempt.calls.length),
		kind,
		ordinal: ++attempt.counts[key],
		state: 'reserved' as const,
		atUtc: at(1000 + attempt.calls.length * 1000),
		deadlineAtUtc: at(600_000),
		settledAtUtc: null,
		code: null,
	};
	attempt.paidWorkAtUtc = at(0);
	if (kind !== 'nfl') {
		attempt.editorialDeadlineAtUtc = at(1_800_000);
		attempt.phase = 'editorial';
	}
	attempt.calls.push(call);
	return call;
}

function withCalls(verifiedProof = false) {
	const state = verifiedProof ? verified() : fresh();
	addCall(state, 'nfl');
	addCall(state, 'writer');
	addCall(state, 'reviewer');
	return state;
}

function addOutput(state: GenerationState, callIndex: number, value: unknown = null, contributionCase: GenerationDebugOutput['contributionCase'] = 'completed') {
	const call = state.current.calls[callIndex];
	const output: GenerationDebugOutput = {
		callId: call.id,
		kind: call.kind,
		ordinal: call.ordinal,
		contributionCase,
		valueJson: value === null ? null : JSON.stringify(value),
		atUtc: at(10_000),
	};
	state.debug[state.current.id].outputs.push(output);
	return output;
}

function freeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

function jsonbEquivalent(value: unknown): unknown {
	if (Array.isArray(value))
		return value.map(jsonbEquivalent);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
			.map(([key, child]) => [key, jsonbEquivalent(child)]));
	}
	return value;
}

function nflResult(): NflSourceResult {
	return {
		status: 'partial',
		trust: 'untrusted-source-data',
		requestId: id(500),
		catalogueRequestId: id(501),
		quotedCredits: 5,
		credits: 5,
		adminActionUrl: null,
		chargeIdPresent: true,
		gaps: ['truncated_results'],
		source: {
			provider: 'nfl-com',
			capability: 'sports-league-data/news',
			scope: { operation: 'news', team: 'NE' },
			url: 'https://www.nfl.com/news/',
			retrievedAtUtc: now,
			observedAtUtc: now,
			sourceDate: null,
			snapshotAsOfUtc: null,
			licenseState: 'unknown',
			coverage: 'recent-headlines',
			scoring: null,
			truncated: true,
		},
		records: [
			{ kind: 'news-summary', sourceId: 'news-1', title: 'Public news', description: null, summary: 'Public summary', url: 'https://www.nfl.com/news/fixture', publishedAtUtc: now, updatedAtUtc: null },
			{ kind: 'injury', sourceId: 'player-1', gsisId: null, name: 'Player', position: 'QB', team: 'NE', sourceDate: '2026-09-09', designation: null, injuries: [], practiceInjuries: [], practiceStatus: 'FULL', practiceDays: [{ date: '2026-09-09', status: 'FULL' }] },
			{ kind: 'weekly-result', sourceId: 'player-2', name: 'Player', teamName: 'Patriots', position: 'QB', opponent: 'BUF', projectedPoints: 10, actualPoints: 15, actualStats: { passing_yards: 100 }, kickoffAtUtc: null, status: 'final' },
		],
	};
}

describe('checked generation data', () => {
	it('builds a detached mutable collecting attempt with the exact fixed limits', () => {
		const inputScope = { ...scope };
		const inputWindow = { ...editorialFixtureWindow };
		const state = initialGenerationState(inputScope, inputWindow, id(1), now);
		expect(GENERATION_VERSION).toBe('fantasy-recap-v13');
		expect(GENERATION_STATE_VERSION).toBe('fantasy-generation-v1');
		expect(GENERATION_LIMITS).toEqual({ leaseMs: 2_700_000, workMs: 2_400_000, debugMs: 2_592_000_000 });
		expect(Object.isFrozen(GENERATION_LIMITS)).toBe(true);
		expect(state).toEqual({
			version: 'fantasy-generation-v1',
			current: {
				id: id(1),
				scope,
				window: editorialFixtureWindow,
				generatorVersion: 'fantasy-recap-v13',
				phase: 'collecting',
				startedAtUtc: now,
				workDeadlineAtUtc: '2026-09-09T00:40:00.000Z',
				debugExpiresAtUtc: '2026-10-09T00:00:00.000Z',
				paidWorkAtUtc: null,
				editorialDeadlineAtUtc: null,
				counts: { nfl: 0, drafts: 0, reviews: 0 },
				calls: [],
				reasonCode: null,
				evidenceId: null,
				candidateId: null,
				reportId: null,
				notifiedAtUtc: null,
			},
			prior: [],
			debug: { [id(1)]: { packetJson: null, outputs: [], notes: [] } },
		});
		state.current.scope.groupId = 'changed';
		state.current.window.startAtUtc = 'changed';
		expect(inputScope).toEqual(scope);
		expect(inputWindow).toEqual(editorialFixtureWindow);
		expect(Object.isFrozen(inputScope)).toBe(false);
	});

	it('round-trips legacy proof absence without adding a default, including prior history', () => {
		const legacy = withCalls();
		const parsed = parseGenerationState(jsonbEquivalent(JSON.parse(JSON.stringify(legacy))));
		expect(parsed).toEqual(legacy);
		expect(Object.hasOwn(parsed.current, 'calendarProof')).toBe(false);
		const current = verified();
		legacy.current.id = id(2);
		current.prior.push(legacy.current);
		const checked = parseGenerationState(current);
		expect(Object.hasOwn(checked.prior[0], 'calendarProof')).toBe(false);
		expect(checked.current.calendarProof).toEqual(proof);
		const nullProof = fresh();
		Object.assign(nullProof.current, { calendarProof: null });
		invalid(nullProof);
	});

	it('persists a detached checked proof without imposing a wall-clock or start-time condition', () => {
		const source = structuredClone(proof);
		const state = initialGenerationState(scope, editorialFixtureWindow, id(1), '2000-01-01T00:00:00.000Z', source);
		expect(state.current.calendarProof).toEqual(proof);
		expect(state.current.calendarProof).not.toBe(source);
		expect(parseGenerationState(jsonbEquivalent(state))).toEqual(state);
		source.games[0].home = 'NYJ';
		expect(state.current.calendarProof).toEqual(proof);
	});

	it('rejects proof scope, window, final-game and strict-shape violations', () => {
		const mutations: Mutation[] = [
			s => s.current.scope.season++,
			s => s.current.scope.week++,
			s => s.current.window.startAtUtc = '2026-08-31T00:00:00.000Z',
			s => s.current.window.endAtUtc = '2026-09-07T00:00:00.000Z',
			s => s.current.calendarProof!.next.startAtUtc = '2026-09-09T00:00:00.000Z',
			s => Object.assign(s.current.calendarProof!.games[0], { final: false }),
			s => Object.assign(s.current.calendarProof!, { token: 'PRIVATE' }),
			s => Object.assign(s.current.calendarProof!.current, { token: 'PRIVATE' }),
		];
		for (const mutate of mutations) {
			const state = verified();
			mutate(state);
			invalid(state);
		}
	});

	it('normalizes the supplied ChatWindow into canonical UTC', () => {
		const state = initialGenerationState(scope, { startAtUtc: '2026-09-01T01:00:00+01:00', endAtUtc: '2026-09-08T01:00:00+01:00' }, id(1), now);
		expect(state.current.window).toEqual(editorialFixtureWindow);
	});

	const invalidShapes: Array<[string, Mutation]> = [
		['state version', s => Object.assign(s, { version: 'future' })],
		['generator version', s => Object.assign(s.current, { generatorVersion: 'fantasy-recap-v12' })],
		['unknown phase', s => Object.assign(s.current, { phase: 'sent' })],
		['attempt UUID', s => s.current.id = 'not-a-uuid'],
		['blank league', s => s.current.scope.leagueId = '  '],
		['oversized group', s => s.current.scope.groupId = 'g'.repeat(501)],
		['season lower bound', s => s.current.scope.season = 1919],
		['season upper bound', s => s.current.scope.season = 2101],
		['week lower bound', s => s.current.scope.week = 0],
		['week upper bound', s => s.current.scope.week = 23],
		['fractional week', s => s.current.scope.week = 1.5],
		['inverted window', s => s.current.window.startAtUtc = s.current.window.endAtUtc],
		['missing field', s => Reflect.deleteProperty(s.current, 'notifiedAtUtc')],
		['state extra', s => Object.assign(s, { secret: 'PRIVATE' })],
		['attempt extra', s => Object.assign(s.current, { token: 'PRIVATE' })],
		['scope extra', s => Object.assign(s.current.scope, { token: 'PRIVATE' })],
		['window extra', s => Object.assign(s.current.window, { token: 'PRIVATE' })],
		['counts extra', s => Object.assign(s.current.counts, { token: 'PRIVATE' })],
		['debug extra', s => Object.assign(s.debug[s.current.id], { token: 'PRIVATE' })],
		['unknown debug UUID', s => s.debug[id(90)] = { packetJson: null, outputs: [], notes: [] }],
		['bad debug key', s => s.debug.bad = { packetJson: null, outputs: [], notes: [] }],
		['unsafe reason', s => s.current.reasonCode = 'Error: PRIVATE quote'],
		['unsafe note', s => s.debug[s.current.id].notes.push('PRIVATE token')],
		['long code', s => s.current.reasonCode = 'a'.repeat(101)],
		['bad evidence ID', s => s.current.evidenceId = 'evidence-short'],
		['bad candidate ID', s => s.current.candidateId = digest('report')],
		['bad report ID', s => s.current.reportId = digest('candidate')],
	];
	for (const [name, mutate] of invalidShapes) {
		it(`rejects ${name} with only a safe error`, () => {
			const state = fresh();
			mutate(state);
			invalid(state);
		});
	}

	it('sanitizes primitive, getter and malformed JSON errors', () => {
		const hostile = { get version() {
			throw new Error('PRIVATE_SECRET');
		} };
		for (const value of [null, [], 'PRIVATE_SECRET', 1, undefined, hostile])
			invalid(value);
		const state = fresh();
		state.debug[state.current.id].packetJson = '{PRIVATE_SECRET';
		invalid(state);
	});

	it('accepts safe codes and all scope endpoints without silently trimming identity', () => {
		for (const season of [1920, 2100]) {
			for (const week of [1, 22]) {
				const state = initialGenerationState({ ...scope, leagueId: ` ${'l'.repeat(498)} `, season, week }, editorialFixtureWindow, id(1), now);
				state.current.reasonCode = 'source:unavailable.retry-1_ok';
				state.debug[id(1)].notes.push('a'.repeat(100));
				expect(parseGenerationState(state)).toEqual(state);
			}
		}
	});

	it('accepts nine bounded intents and checks counters, ordinals and global call identity', () => {
		const full = fresh();
		for (let i = 0; i < 3; i++) {
			for (const kind of ['nfl', 'writer', 'reviewer'] as const) addCall(full, kind);
		}
		expect(parseGenerationState(full).current.counts).toEqual({ nfl: 3, drafts: 3, reviews: 3 });
		const mutations: Mutation[] = [
			s => s.current.counts.nfl = 2,
			s => s.current.counts.drafts = -1,
			s => s.current.counts.reviews = 4,
			s => s.current.counts.nfl = 0.5,
			s => s.current.calls[0].ordinal = 2,
			s => s.current.calls[0].ordinal = 0,
			s => s.current.calls[0].ordinal = 4,
			s => s.current.calls[3].ordinal = 1,
			s => s.current.calls[0].id = s.current.calls[1].id,
			s => s.current.calls.push({ ...s.current.calls[0], id: id(700) }),
			s => Object.assign(s.current.calls[0], { rawError: 'PRIVATE' }),
			s => s.current.calls[0].code = 'PRIVATE MESSAGE',
			s => Object.assign(s.current.calls[0], { kind: 'fallback' }),
			s => Object.assign(s.current.calls[0], { state: 'unknown' }),
		];
		for (const mutate of mutations) {
			const state = structuredClone(full);
			mutate(state);
			invalid(state);
		}
		const crossAttempt = withCalls();
		crossAttempt.prior.push({ ...structuredClone(crossAttempt.current), id: id(2) });
		invalid(crossAttempt);
	});

	it('requires paid work and a persisted editorial deadline, with reviews bounded by drafts', () => {
		const mutations: Mutation[] = [
			s => s.current.paidWorkAtUtc = null,
			s => s.current.editorialDeadlineAtUtc = null,
			(s) => {
				s.current.calls.splice(1, 1);
				s.current.counts.drafts = 0;
			},
		];
		for (const mutate of mutations) {
			const state = withCalls();
			mutate(state);
			invalid(state);
		}
	});

	it('accepts only source-only retryable attempts, safe blocked reasons and complete approved identity', () => {
		const sourceOnly = fresh();
		sourceOnly.current.phase = 'source_retryable';
		expect(parseGenerationState(sourceOnly)).toEqual(sourceOnly);
		sourceOnly.current.paidWorkAtUtc = now;
		invalid(sourceOnly);
		const withPaidCalls = withCalls();
		withPaidCalls.current.phase = 'source_retryable';
		invalid(withPaidCalls);
		const blocked = fresh();
		blocked.current.phase = 'blocked';
		invalid(blocked);
		blocked.current.reasonCode = 'collector_unavailable';
		expect(parseGenerationState(blocked)).toEqual(blocked);
		const approved = withCalls();
		Object.assign(approved.current, { phase: 'approved', evidenceId: digest('evidence'), candidateId: digest('candidate'), reportId: digest('report') });
		expect(parseGenerationState(approved)).toEqual(approved);
		for (const key of ['evidenceId', 'candidateId', 'reportId'] as const) {
			const missing = structuredClone(approved);
			missing.current[key] = null;
			invalid(missing);
		}
		approved.current.calls = [];
		approved.current.counts = { nfl: 0, drafts: 0, reviews: 0 };
		invalid(approved);
	});

	it('validates relative time and fixed expiry, never the current wall clock', () => {
		const valid = withCalls();
		expect(parseGenerationState(valid)).toEqual(valid);
		const mutations: Mutation[] = [
			s => s.current.startedAtUtc = 'PRIVATE not an instant',
			s => s.current.workDeadlineAtUtc = now,
			s => s.current.workDeadlineAtUtc = at(2_400_001),
			s => s.current.debugExpiresAtUtc = at(GENERATION_LIMITS.debugMs - 1),
			s => s.current.debugExpiresAtUtc = at(GENERATION_LIMITS.debugMs + 1),
			s => s.current.paidWorkAtUtc = at(-1),
			s => s.current.calls[0].atUtc = at(-1),
			s => s.current.calls[0].deadlineAtUtc = at(2_400_001),
			s => s.current.calls[0].deadlineAtUtc = s.current.calls[0].atUtc,
			s => s.current.calls[0].settledAtUtc = at(-1),
			s => s.current.editorialDeadlineAtUtc = at(2_400_001),
			s => s.current.editorialDeadlineAtUtc = now,
			s => s.current.editorialDeadlineAtUtc = at(1_802_001),
			s => s.current.calls[1].deadlineAtUtc = at(1_800_001),
		];
		for (const mutate of mutations) {
			const state = structuredClone(valid);
			mutate(state);
			invalid(state);
		}
		valid.current.editorialDeadlineAtUtc = at(1_802_000);
		valid.current.calls[0].settledAtUtc = at(2_500_000);
		expect(parseGenerationState(valid)).toEqual(valid);
		const historical = initialGenerationState(scope, editorialFixtureWindow, id(1), '2000-01-01T00:00:00.000Z');
		expect(parseGenerationState(historical)).toEqual(historical);
	});

	it('requires unique attempts of one scope but permits different windows and unlimited prior metadata', () => {
		const state = fresh();
		for (let i = 2; i < 102; i++) {
			const previous = fresh().current;
			previous.id = id(i);
			previous.window.startAtUtc = '2026-08-31T00:00:00.000Z';
			state.prior.push(previous);
			state.debug[previous.id] = { packetJson: null, outputs: [], notes: [] };
		}
		expect(parseGenerationState(state).prior).toHaveLength(100);
		for (const key of ['leagueId', 'groupId', 'season', 'week'] as const) {
			const changed = structuredClone(state);
			Object.assign(changed.prior[0].scope, { [key]: typeof scope[key] === 'string' ? 'foreign' : Number(scope[key]) + 1 });
			invalid(changed);
		}
		state.prior[0].id = state.current.id;
		invalid(state);
	});
});

describe('private generation debug data', () => {
	it('preserves exact serialized packet bytes through JSONB-equivalent key ordering', async () => {
		const packet = await frozenEditorialFixture();
		const state = verified();
		state.current.evidenceId = packet.id;
		const packetJson = JSON.stringify(packet);
		state.debug[id(1)].packetJson = packetJson;
		const parsed = parseGenerationState(jsonbEquivalent(JSON.parse(JSON.stringify(state))));
		expect(parsed.debug[id(1)].packetJson).toBe(packetJson);
		const recovered = JSON.parse(parsed.debug[id(1)].packetJson!);
		recovered.id = '';
		expect(`evidence-${createHash('sha256').update(JSON.stringify(recovered)).digest('hex')}`).toBe(packet.id);
		expect(JSON.parse(parsed.debug[id(1)].packetJson!).chat.sources[0].text).toBe(editorialFixtureQuote);
		expect(Object.isFrozen(packet)).toBe(true);
		parsed.debug[id(1)].packetJson = JSON.stringify(jsonbEquivalent(packet));
		invalid(parsed);
		parsed.debug[id(1)].packetJson = packetJson.replace('PRIVATE_FOOTBALL_CHAT', 'TAMPERED_FOOTBALL_CHAT');
		invalid(parsed);
	});

	it('requires matching canonical packet/attempt proofs, or proof absence on both', async () => {
		const packet = await frozenEditorialFixture();
		for (const mismatch of ['attempt-absent', 'packet-absent', 'different-proof', 'invalid-proof', 'both-absent'] as const) {
			const state = verified();
			const changed = structuredClone(packet);
			if (mismatch === 'attempt-absent' || mismatch === 'both-absent')
				delete state.current.calendarProof;
			if (mismatch === 'packet-absent' || mismatch === 'both-absent')
				delete changed.scope.calendarProof;
			if (mismatch === 'different-proof')
				changed.scope.calendarProof!.retrievedAtUtc = at(1_000);
			if (mismatch === 'invalid-proof')
				changed.scope.calendarProof!.current.providerWeek++;
			changed.id = '';
			changed.id = `evidence-${createHash('sha256').update(JSON.stringify(changed)).digest('hex')}`;
			state.current.evidenceId = changed.id;
			state.debug[id(1)].packetJson = JSON.stringify(changed);
			if (mismatch === 'both-absent')
				expect(parseGenerationState(state)).toEqual(state);
			else invalid(state);
		}
	});

	it('checks packet identity, version, scope and the blocked unknown-season exception', async () => {
		const packet = await frozenEditorialFixture();
		const state = verified();
		state.current.evidenceId = packet.id;
		const mutations = [
			(p: typeof packet) => p.id = digest('evidence'),
			(p: typeof packet) => Object.assign(p, { version: 'future' }),
			(p: typeof packet) => p.scope.leagueId = 'foreign',
			(p: typeof packet) => p.scope.groupId = 'foreign',
			(p: typeof packet) => p.scope.week = 2,
			(p: typeof packet) => p.scope.season = '2025',
			(p: typeof packet) => p.scope.season = null,
			(p: typeof packet) => p.scope.chatWindow = null,
			(p: typeof packet) => p.scope.chatWindow!.startAtUtc = '2026-08-31T00:00:00.000Z',
			(p: typeof packet) => p.scope.chatWindow!.endAtUtc = '2026-09-07T00:00:00.000Z',
		];
		for (const mutate of mutations) {
			const changed = structuredClone(packet);
			mutate(changed);
			state.debug[id(1)].packetJson = JSON.stringify(changed);
			invalid(state);
			if (changed.id === packet.id) {
				changed.id = '';
				changed.id = `evidence-${createHash('sha256').update(JSON.stringify(changed)).digest('hex')}`;
				state.current.evidenceId = changed.id;
				state.debug[id(1)].packetJson = JSON.stringify(changed);
				invalid(state);
			}
			state.current.evidenceId = packet.id;
		}
		const blocked = structuredClone(packet);
		blocked.status = 'blocked';
		blocked.scope.season = null;
		state.debug[id(1)].packetJson = JSON.stringify(blocked);
		invalid(state);
		blocked.league = null;
		blocked.id = '';
		blocked.id = `evidence-${createHash('sha256').update(JSON.stringify(blocked)).digest('hex')}`;
		state.current.evidenceId = blocked.id;
		state.debug[id(1)].packetJson = JSON.stringify(blocked);
		expect(parseGenerationState(state)).toEqual(state);
		state.current.evidenceId = null;
		invalid(state);
	});

	it('retains typed partial/progress and rejected foreign-reference writer/reviewer values', async () => {
		const packet = await frozenEditorialFixture();
		const draft = validEditorialDraft(packet);
		draft.evidenceId = 'foreign-evidence';
		draft.manager.rosterIds = [999];
		const review = { evidenceId: 'foreign-evidence', candidateId: 'foreign-candidate', verdict: 'fail', issues: [{ path: 'quote.body', category: 'quote_privacy', message: 'PRIVATE rejected quote', supportIds: ['foreign-source'] }] };
		for (const contributionCase of ['completed', 'partial', 'needs_help', 'blocked', 'failed'] as const) {
			const state = withCalls();
			state.current.phase = 'blocked';
			state.current.reasonCode = 'rejected';
			addOutput(state, 1, draft, contributionCase);
			addOutput(state, 2, review, contributionCase);
			const parsed = parseGenerationState(state);
			expect(parsed.debug[id(1)].outputs).toEqual(state.debug[id(1)].outputs);
			expect(JSON.parse(parsed.debug[id(1)].outputs[0].valueJson!).evidenceId).toBe('foreign-evidence');
		}
	});

	it('rejects malformed model values and SDK envelopes without leaking their content', async () => {
		const packet = await frozenEditorialFixture();
		const draft = validEditorialDraft(packet);
		for (const value of [[], 'PRIVATE', { object: draft, headers: { Authorization: 'PRIVATE' } }, { ...draft, reasoning: 'PRIVATE' }, { evidenceId: packet.id }]) {
			const state = withCalls();
			addOutput(state, 1, value);
			invalid(state);
		}
		const state = withCalls();
		addOutput(state, 2, draft);
		invalid(state);
		state.debug[id(1)].outputs[0].valueJson = '{PRIVATE_BAD_JSON';
		invalid(state);
	});

	it('accepts normalized NFL JSON and rejects raw SDK/auth/charge fields at every structured level', () => {
		const state = withCalls();
		const output = addOutput(state, 0, nflResult());
		expect(parseGenerationState(state)).toEqual(state);
		for (const key of ['chargeId', 'headers', 'authorization', 'apiKey', 'requestContext', 'error', 'sdk', 'reasoning', 'prompt']) {
			output.valueJson = JSON.stringify({ ...nflResult(), [key]: 'PRIVATE' });
			invalid(state);
		}
		for (const modify of [
			(r: NflSourceResult) => Object.assign(r.source!, { auth: 'PRIVATE' }),
			(r: NflSourceResult) => Object.assign(r.source!.scope, { apiKey: 'PRIVATE' }),
			(r: NflSourceResult) => Object.assign(r.records[0], { chargeId: 'PRIVATE' }),
			(r: NflSourceResult) => r.gaps.push('Error: PRIVATE'),
			(r: NflSourceResult) => r.adminActionUrl = 'https://example.com/?token=PRIVATE',
		]) {
			const result = nflResult();
			modify(result);
			output.valueJson = JSON.stringify(result);
			invalid(state);
		}
		const result = nflResult();
		result.source = null;
		result.records = [];
		result.status = 'unknown_outcome';
		output.valueJson = JSON.stringify(result);
		expect(parseGenerationState(state)).toEqual(state);
	});

	it('binds one output to each intent and allows late capture only before the fixed expiry', () => {
		const state = withCalls();
		addOutput(state, 1);
		state.debug[id(1)].notes.push('writer:output_unavailable');
		expect(parseGenerationState(state)).toEqual(state);
		const mutations: Mutation[] = [
			s => s.debug[id(1)].outputs.push({ ...s.debug[id(1)].outputs[0] }),
			s => s.debug[id(1)].outputs[0].callId = id(800),
			s => s.debug[id(1)].outputs[0].kind = 'reviewer',
			s => s.debug[id(1)].outputs[0].ordinal = 2,
			s => s.debug[id(1)].outputs[0].atUtc = at(1_999),
			s => s.debug[id(1)].outputs[0].atUtc = at(GENERATION_LIMITS.debugMs),
			s => Object.assign(s.debug[id(1)].outputs[0], { contributionCase: 'progress' }),
			s => Object.assign(s.debug[id(1)].outputs[0], { error: 'PRIVATE' }),
		];
		for (const mutate of mutations) {
			const copy = structuredClone(state);
			mutate(copy);
			invalid(copy);
		}
		state.debug[id(1)].outputs[0].atUtc = at(GENERATION_LIMITS.debugMs - 1);
		expect(parseGenerationState(state)).toEqual(state);
	});

	it('keeps parsed values mutable and detached even when every input object is frozen', () => {
		const original = freeze(withCalls());
		const before = JSON.stringify(original);
		const copy = parseGenerationState(original);
		copy.current.counts.nfl = 0;
		copy.current.calls[0].code = 'changed';
		copy.current.scope.groupId = 'changed';
		copy.debug[id(1)].notes.push('changed');
		expect(Object.isFrozen(copy)).toBe(false);
		expect(JSON.stringify(original)).toBe(before);
	});

	it('purges only expired payloads and returns detached exact-attempt reads with exclusive expiry', () => {
		const prior = verified();
		const state = initialGenerationState(scope, editorialFixtureWindow, id(2), at(24 * 60 * 60_000), proof);
		state.prior.push(prior.current);
		state.debug[id(1)] = { packetJson: null, outputs: [], notes: ['prior_note'] };
		state.current.phase = 'blocked';
		state.current.reasonCode = 'held';
		const before = JSON.stringify(state);
		const expiry = prior.current.debugExpiresAtUtc;
		const live = retainedGenerationDebug(state, id(1), at(GENERATION_LIMITS.debugMs - 1));
		expect(live?.attempt.id).toBe(id(1));
		live!.attempt.scope.groupId = 'changed';
		live!.bundle.notes.push('changed');
		expect(retainedGenerationDebug(state, id(1), expiry)).toBeNull();
		expect(retainedGenerationDebug(state, id(99), now)).toBeNull();
		const purged = purgeExpiredGenerationDebug(freeze(state), expiry);
		expect(purged.current).toEqual(state.current);
		expect(purged.prior).toEqual(state.prior);
		expect(Object.keys(purged.debug)).toEqual([id(2)]);
		expect(retainedGenerationDebug(purged, id(1), now)).toBeNull();
		expect(purgeExpiredGenerationDebug(purged, expiry)).toEqual(purged);
		expect(purgeExpiredGenerationDebug(state, at(GENERATION_LIMITS.debugMs - 1))).toEqual(state);
		purged.debug[id(2)].notes.push('detached');
		expect(JSON.stringify(state)).toBe(before);
		const allExpired = purgeExpiredGenerationDebug(state, at(GENERATION_LIMITS.debugMs + 24 * 60 * 60_000));
		expect(allExpired.debug).toEqual({});
		expect(allExpired.prior).toHaveLength(1);
		expect(allExpired.current).toEqual(state.current);
	});

	it('returns only safe summary fields, excluding scope, group, calls, packet and quote', async () => {
		const packet = await frozenEditorialFixture();
		const state = withCalls(true);
		state.current.evidenceId = packet.id;
		state.debug[id(1)].packetJson = JSON.stringify(packet);
		const reference = generationReference(state);
		expect(reference).toEqual({ ...scope, attemptId: id(1) });
		reference.groupId = 'changed';
		const summary = generationSummary(state);
		expect(Object.keys(summary).sort()).toEqual([
			'attemptId',
			'generatorVersion',
			'phase',
			'counts',
			'startedAtUtc',
			'workDeadlineAtUtc',
			'debugExpiresAtUtc',
			'paidWorkAtUtc',
			'editorialDeadlineAtUtc',
			'notifiedAtUtc',
			'evidenceId',
			'candidateId',
			'reportId',
			'reasonCode',
		].sort());
		const serialized = JSON.stringify(summary);
		for (const secret of [scope.groupId, scope.leagueId, 'PRIVATE_FOOTBALL_CHAT', 'callId', 'packetJson', 'window'])
			expect(serialized).not.toContain(secret);
		summary.counts.drafts = 0;
		expect(state.current.counts.drafts).toBe(1);
		expect(state.current.scope.groupId).toBe(scope.groupId);
	});
});
