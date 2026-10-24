import type { ChatWindow } from './chat-archive';
import type { NflSourceResult } from './nfl-sources.types';
import type { SavedReportScope } from './saved-report';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { chatWindowSchema } from './chat-archive';
import { editorialDraftSchema } from './editorial';
import { editorialReviewSchema } from './editorial-loop';
import { FANTASY_EDITORIAL_LIMITS } from './editorial-policy';
import { nflSourceInputSchema } from './nfl-sources.schema';

export const GENERATION_VERSION = 'fantasy-recap-v13';
export const GENERATION_STATE_VERSION = 'fantasy-generation-v1';
export const GENERATION_LIMITS = Object.freeze({
	leaseMs: 45 * 60_000,
	workMs: 40 * 60_000,
	debugMs: 30 * 24 * 60 * 60_000,
});
export type GenerationAttemptRef = SavedReportScope & { attemptId: string };
export type GenerationCallKind = 'nfl' | 'writer' | 'reviewer';
export type SafeCode = string;
export interface GenerationCall {
	id: string;
	kind: GenerationCallKind;
	ordinal: number;
	state: 'reserved' | 'completed' | 'failed';
	atUtc: string;
	deadlineAtUtc: string;
	settledAtUtc: string | null;
	code: SafeCode | null;
}
export interface GenerationAttempt {
	id: string;
	scope: SavedReportScope;
	window: ChatWindow;
	generatorVersion: typeof GENERATION_VERSION;
	phase: 'collecting' | 'editorial' | 'source_retryable' | 'blocked' | 'approved';
	startedAtUtc: string;
	workDeadlineAtUtc: string;
	debugExpiresAtUtc: string;
	paidWorkAtUtc: string | null;
	editorialDeadlineAtUtc: string | null;
	counts: { nfl: number; drafts: number; reviews: number };
	calls: GenerationCall[];
	reasonCode: SafeCode | null;
	evidenceId: string | null;
	candidateId: string | null;
	reportId: string | null;
	notifiedAtUtc: string | null;
}
export interface GenerationDebugOutput {
	callId: string;
	kind: GenerationCallKind;
	ordinal: number;
	contributionCase: 'completed' | 'partial' | 'needs_help' | 'blocked' | 'failed';
	valueJson: string | null;
	atUtc: string;
}
export interface GenerationDebugBundle {
	packetJson: string | null;
	outputs: GenerationDebugOutput[];
	notes: SafeCode[];
}
export interface GenerationState {
	version: typeof GENERATION_STATE_VERSION;
	current: GenerationAttempt;
	prior: GenerationAttempt[];
	debug: Record<string, GenerationDebugBundle>;
}

const uuid = z.string().uuid();
const instant = z.string().datetime({ offset: true });
const safeCode = z.string().regex(/^[a-z][a-z0-9_:.-]{0,99}$/);
const scopeId = z.string().max(500).refine(value => value.trim().length > 0);
const scopeSchema = z.object({
	leagueId: scopeId,
	groupId: scopeId,
	season: z.number().int().min(1920).max(2100),
	week: z.number().int().min(1).max(22),
}).strict();
const evidenceId = z.string().regex(/^evidence-[a-f0-9]{64}$/);
const kind = z.enum(['nfl', 'writer', 'reviewer']);
const ordinal = z.number().int().min(1).max(3);
const count = z.number().int().min(0).max(3);
const callSchema: z.ZodType<GenerationCall> = z.object({
	id: uuid,
	kind,
	ordinal,
	state: z.enum(['reserved', 'completed', 'failed']),
	atUtc: instant,
	deadlineAtUtc: instant,
	settledAtUtc: instant.nullable(),
	code: safeCode.nullable(),
}).strict();
const attemptSchema: z.ZodType<GenerationAttempt> = z.object({
	id: uuid,
	scope: scopeSchema,
	window: chatWindowSchema,
	generatorVersion: z.literal(GENERATION_VERSION),
	phase: z.enum(['collecting', 'editorial', 'source_retryable', 'blocked', 'approved']),
	startedAtUtc: instant,
	workDeadlineAtUtc: instant,
	debugExpiresAtUtc: instant,
	paidWorkAtUtc: instant.nullable(),
	editorialDeadlineAtUtc: instant.nullable(),
	counts: z.object({ nfl: count, drafts: count, reviews: count }).strict(),
	calls: z.array(callSchema).max(9),
	reasonCode: safeCode.nullable(),
	evidenceId: evidenceId.nullable(),
	candidateId: z.string().regex(/^candidate-[a-f0-9]{64}$/).nullable(),
	reportId: z.string().regex(/^report-[a-f0-9]{64}$/).nullable(),
	notifiedAtUtc: instant.nullable(),
}).strict();
const bundleSchema: z.ZodType<GenerationDebugBundle> = z.object({
	packetJson: z.string().nullable(),
	outputs: z.array(z.object({
		callId: uuid,
		kind,
		ordinal,
		contributionCase: z.enum(['completed', 'partial', 'needs_help', 'blocked', 'failed']),
		valueJson: z.string().nullable(),
		atUtc: instant,
	}).strict()).max(9),
	notes: z.array(safeCode),
}).strict();
const stateSchema: z.ZodType<GenerationState> = z.object({
	version: z.literal(GENERATION_STATE_VERSION),
	current: attemptSchema,
	prior: z.array(attemptSchema),
	debug: z.record(uuid, bundleSchema),
}).strict();

// The trusted collector owns the full packet contract; only identity and owner binding are checked here.
const packetBindingSchema = z.object({
	version: z.literal('fantasy-evidence-v1'),
	id: evidenceId,
	scope: z.object({
		leagueId: scopeId,
		groupId: scopeId,
		season: z.string().nullable(),
		week: z.number(),
		chatWindow: chatWindowSchema,
	}),
	status: z.enum(['ready', 'partial', 'blocked']),
	league: z.object({}).nullable(),
});
const text = z.string();
const nullableText = text.nullable();
const nullableInstant = instant.nullable();
const nullableNumber = z.number().finite().nullable();
const nflResultSchema: z.ZodType<NflSourceResult> = z.object({
	status: z.enum(['success', 'partial', 'empty', 'blocked', 'terms_required', 'access_denied', 'upstream_error', 'unknown_outcome', 'invalid_response']),
	trust: z.literal('untrusted-source-data'),
	requestId: nullableText,
	catalogueRequestId: nullableText,
	quotedCredits: z.number().int().nonnegative().nullable(),
	credits: z.number().int().nonnegative().nullable(),
	adminActionUrl: z.literal('https://www.firecrawl.dev/app/settings?tab=data-sources').nullable(),
	chargeIdPresent: z.boolean(),
	gaps: z.array(safeCode),
	source: z.object({
		provider: text,
		capability: text,
		scope: nflSourceInputSchema,
		url: text,
		retrievedAtUtc: instant,
		observedAtUtc: instant,
		sourceDate: z.string().date().nullable(),
		snapshotAsOfUtc: z.null(),
		licenseState: z.literal('unknown'),
		coverage: z.enum(['week-report', 'recent-headlines', 'current-season-week']),
		scoring: z.enum(['STD', 'HALF', 'PPR']).nullable(),
		truncated: z.boolean(),
	}).strict().nullable(),
	records: z.array(z.discriminatedUnion('kind', [
		z.object({
			kind: z.literal('injury'),
			sourceId: text,
			gsisId: nullableText,
			name: text,
			position: text,
			team: text,
			sourceDate: z.string().date().nullable(),
			designation: nullableText,
			injuries: z.array(text),
			practiceInjuries: z.array(text),
			practiceStatus: nullableText,
			practiceDays: z.array(z.object({ date: z.string().date(), status: text }).strict()),
		}).strict(),
		z.object({
			kind: z.literal('news-summary'),
			sourceId: text,
			title: text,
			description: nullableText,
			summary: nullableText,
			url: text,
			publishedAtUtc: nullableInstant,
			updatedAtUtc: nullableInstant,
		}).strict(),
		z.object({
			kind: z.literal('weekly-result'),
			sourceId: text,
			name: text,
			teamName: text,
			position: text,
			opponent: text,
			projectedPoints: nullableNumber,
			actualPoints: nullableNumber,
			actualStats: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.number().finite()),
			kickoffAtUtc: nullableInstant,
			status: text,
		}).strict(),
	])),
}).strict();

function check(condition: unknown): asserts condition {
	if (!condition)
		throw new Error('invalid_generation_state');
}

function checkAttempt(attempt: GenerationAttempt, callIds: Set<string>) {
	const start = Date.parse(attempt.startedAtUtc);
	const work = Date.parse(attempt.workDeadlineAtUtc);
	check(start < work && work <= start + GENERATION_LIMITS.workMs);
	check(Date.parse(attempt.debugExpiresAtUtc) === start + GENERATION_LIMITS.debugMs);
	check(attempt.paidWorkAtUtc === null || Date.parse(attempt.paidWorkAtUtc) >= start);
	const editorial = attempt.editorialDeadlineAtUtc === null ? null : Date.parse(attempt.editorialDeadlineAtUtc);
	check(editorial === null || (editorial > start && editorial <= work));
	check(attempt.counts.reviews <= attempt.counts.drafts);
	for (const [callKind, countKey] of [['nfl', 'nfl'], ['writer', 'drafts'], ['reviewer', 'reviews']] as const) {
		const calls = attempt.calls.filter(call => call.kind === callKind).sort((a, b) => a.ordinal - b.ordinal);
		check(calls.length === attempt.counts[countKey]);
		check(calls.every((call, index) => call.ordinal === index + 1));
	}
	for (const call of attempt.calls) {
		check(!callIds.has(call.id.toLowerCase()));
		callIds.add(call.id.toLowerCase());
		const at = Date.parse(call.atUtc);
		const deadline = Date.parse(call.deadlineAtUtc);
		check(attempt.paidWorkAtUtc !== null && at >= start);
		check(deadline > at && deadline <= work);
		check(call.settledAtUtc === null || Date.parse(call.settledAtUtc) >= at);
		if (call.kind !== 'nfl') {
			check(editorial !== null && deadline <= editorial);
			check(editorial <= at + FANTASY_EDITORIAL_LIMITS.totalMs);
		}
	}
	if (attempt.phase === 'source_retryable')
		check(attempt.paidWorkAtUtc === null && attempt.calls.length === 0);
	if (attempt.phase === 'blocked')
		check(attempt.reasonCode !== null);
	if (attempt.phase === 'approved') {
		check(attempt.evidenceId !== null && attempt.candidateId !== null && attempt.reportId !== null);
		check(attempt.counts.drafts >= 1 && attempt.counts.reviews >= 1);
	}
}

function checkBundle(attempt: GenerationAttempt, bundle: GenerationDebugBundle) {
	if (bundle.packetJson !== null) {
		const original = JSON.parse(bundle.packetJson);
		const packet = packetBindingSchema.parse(original);
		original.id = '';
		check(packet.id === `evidence-${createHash('sha256').update(JSON.stringify(original)).digest('hex')}`);
		check(packet.id === attempt.evidenceId);
		check(packet.scope.leagueId === attempt.scope.leagueId && packet.scope.groupId === attempt.scope.groupId
			&& packet.scope.week === attempt.scope.week);
		check(packet.scope.chatWindow.startAtUtc === attempt.window.startAtUtc
			&& packet.scope.chatWindow.endAtUtc === attempt.window.endAtUtc);
		check(packet.scope.season === String(attempt.scope.season)
			|| (packet.scope.season === null && packet.status === 'blocked' && packet.league === null));
	}
	const outputIds = new Set<string>();
	for (const output of bundle.outputs) {
		check(!outputIds.has(output.callId.toLowerCase()));
		outputIds.add(output.callId.toLowerCase());
		const call = attempt.calls.find(call => call.id === output.callId);
		check(call && call.kind === output.kind && call.ordinal === output.ordinal);
		const at = Date.parse(output.atUtc);
		check(at >= Date.parse(call.atUtc) && at < Date.parse(attempt.debugExpiresAtUtc));
		if (output.valueJson !== null) {
			const value: unknown = JSON.parse(output.valueJson);
			if (output.kind === 'writer')
				editorialDraftSchema.parse(value);
			else if (output.kind === 'reviewer')
				editorialReviewSchema.parse(value);
			else
				nflResultSchema.parse(value);
		}
	}
}

/** Checked data only, not a claim, transition, approval or permission to dispatch work. */
export function parseGenerationState(value: unknown): GenerationState {
	try {
		const state = stateSchema.parse(value);
		const attempts = new Map<string, GenerationAttempt>();
		const callIds = new Set<string>();
		for (const attempt of [state.current, ...state.prior]) {
			check(!attempts.has(attempt.id.toLowerCase()));
			attempts.set(attempt.id.toLowerCase(), attempt);
			check(attempt.scope.leagueId === state.current.scope.leagueId
				&& attempt.scope.groupId === state.current.scope.groupId
				&& attempt.scope.season === state.current.scope.season
				&& attempt.scope.week === state.current.scope.week);
			checkAttempt(attempt, callIds);
		}
		for (const [attemptId, bundle] of Object.entries(state.debug)) {
			const attempt = attempts.get(attemptId.toLowerCase());
			check(attempt && attempt.id === attemptId);
			checkBundle(attempt, bundle);
		}
		return state;
	} catch {
		throw new Error('invalid_generation_state');
	}
}

function nowMilliseconds(nowUtc: string): number {
	try {
		return Date.parse(instant.parse(nowUtc));
	} catch {
		throw new Error('invalid_generation_state');
	}
}

export function initialGenerationState(
	scope: SavedReportScope,
	window: ChatWindow,
	attemptId: string,
	nowUtc: string,
): GenerationState {
	const now = nowMilliseconds(nowUtc);
	return parseGenerationState({
		version: GENERATION_STATE_VERSION,
		current: {
			id: attemptId,
			scope,
			window,
			generatorVersion: GENERATION_VERSION,
			phase: 'collecting',
			startedAtUtc: new Date(now).toISOString(),
			workDeadlineAtUtc: new Date(now + GENERATION_LIMITS.workMs).toISOString(),
			debugExpiresAtUtc: new Date(now + GENERATION_LIMITS.debugMs).toISOString(),
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
		debug: { [attemptId]: { packetJson: null, outputs: [], notes: [] } },
	});
}

export function generationReference(state: GenerationState): GenerationAttemptRef {
	const { scope, id } = parseGenerationState(state).current;
	return { ...scope, attemptId: id };
}

export function generationSummary(state: GenerationState) {
	const {
		id,
		generatorVersion,
		phase,
		counts,
		startedAtUtc,
		workDeadlineAtUtc,
		debugExpiresAtUtc,
		paidWorkAtUtc,
		editorialDeadlineAtUtc,
		notifiedAtUtc,
		evidenceId,
		candidateId,
		reportId,
		reasonCode,
	} = parseGenerationState(state).current;
	return {
		attemptId: id,
		generatorVersion,
		phase,
		counts,
		startedAtUtc,
		workDeadlineAtUtc,
		debugExpiresAtUtc,
		paidWorkAtUtc,
		editorialDeadlineAtUtc,
		notifiedAtUtc,
		evidenceId,
		candidateId,
		reportId,
		reasonCode,
	};
}

export function purgeExpiredGenerationDebug(state: GenerationState, nowUtc: string): GenerationState {
	const copy = parseGenerationState(state);
	const now = nowMilliseconds(nowUtc);
	for (const attempt of [copy.current, ...copy.prior]) {
		if (Date.parse(attempt.debugExpiresAtUtc) <= now)
			delete copy.debug[attempt.id];
	}
	return copy;
}

export function retainedGenerationDebug(
	state: GenerationState,
	attemptId: string,
	nowUtc: string,
): { attempt: GenerationAttempt; bundle: GenerationDebugBundle } | null {
	const copy = parseGenerationState(state);
	const now = nowMilliseconds(nowUtc);
	const attempt = [copy.current, ...copy.prior].find(attempt => attempt.id === attemptId);
	const bundle = copy.debug[attemptId];
	return attempt && bundle && now < Date.parse(attempt.debugExpiresAtUtc) ? { attempt, bundle } : null;
}
