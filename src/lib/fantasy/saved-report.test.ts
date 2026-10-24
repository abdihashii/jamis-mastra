import { describe, expect, it } from 'bun:test';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { EditorialDraft } from './editorial';
import type { EditorialOutcome } from './editorial-loop';
import type { RecapEvidencePacket } from './recap-evidence';
import type { SavedReport, SavedReportScope } from './saved-report';

import { buildEditorialCandidate, EDITORIAL_VERSION } from './editorial';
import { runEditorialLoop } from './editorial-loop';
import { FANTASY_EDITORIAL_MODEL } from './editorial-policy';
import { editorialFixtureQuote, frozenEditorialFixture, validEditorialDraft } from './editorial.fixture';
import { buildSavedReport, parseSavedReport, sameSavedReportScope, SAVED_REPORT_VERSION } from './saved-report';

type Approved = Extract<EditorialOutcome, { status: 'approved' }>;

function approved(packet: RecapEvidencePacket, draft: EditorialDraft = validEditorialDraft(packet)): Approved {
	const built = buildEditorialCandidate(packet, draft);
	if (built.status !== 'candidate')
		throw new Error('invalid_test_candidate');
	return {
		status: 'approved',
		evidenceId: packet.id,
		candidate: built.candidate,
		review: { evidenceId: packet.id, candidateId: built.candidate.id, verdict: 'pass', issues: [] },
		counts: { drafts: 1, reviews: 1 },
	};
}

function longDraft(packet: RecapEvidencePacket): EditorialDraft {
	const draft = validEditorialDraft(packet);
	draft.stories = ['First', 'Second', 'Third'].map(angle => ({
		headline: `${angle} perspective`,
		body: `${angle} story. `.repeat(900),
		supportIds: ['score:1:1'],
	}));
	return draft;
}

// Independent digest oracle pins the serialized field order, including every retained field except id.
function withDigest(report: SavedReport): SavedReport {
	const content = {
		version: report.version,
		scope: {
			leagueId: report.scope.leagueId,
			groupId: report.scope.groupId,
			season: report.scope.season,
			week: report.scope.week,
		},
		evidenceId: report.evidenceId,
		candidateId: report.candidateId,
		editorialVersion: report.editorialVersion,
		writer: { model: report.writer.model, effort: report.writer.effort },
		reviewer: { model: report.reviewer.model, effort: report.reviewer.effort },
		counts: { drafts: report.counts.drafts, reviews: report.counts.reviews },
		parts: report.parts,
	};
	return { ...report, id: `report-${createHash('sha256').update(JSON.stringify(content)).digest('hex')}` };
}

function freezeFixture<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value)) freezeFixture(child);
		Object.freeze(value);
	}
	return value;
}

function expectFrozen(value: unknown) {
	if (value && typeof value === 'object') {
		expect(Object.isFrozen(value)).toBe(true);
		for (const child of Object.values(value)) expectFrozen(child);
	}
}

function invalid(run: () => unknown) {
	let thrown: unknown;
	try {
		run();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(Error);
	expect(String(thrown)).toBe('Error: invalid_saved_report');
	expect(thrown).not.toHaveProperty('cause');
	expect(thrown).not.toHaveProperty('issues');
}

const reviewIssue = {
	path: 'quote.body',
	category: 'quote_privacy' as const,
	message: 'PRIVATE_REVIEW_PROSE',
	supportIds: ['chat:exact-source'],
};

describe('saved editorial reports (off live path)', () => {
	it('saves one exact part with whitespace, Unicode and Markdown quote bytes intact', async () => {
		const packet = await frozenEditorialFixture();
		const outcome = approved(packet);
		const report = buildSavedReport(packet, outcome);
		expect(report).toEqual({
			version: SAVED_REPORT_VERSION,
			id: withDigest(report).id,
			scope: { leagueId: packet.scope.leagueId, groupId: packet.scope.groupId, season: 2026, week: 1 },
			evidenceId: packet.id,
			candidateId: outcome.candidate.id,
			editorialVersion: EDITORIAL_VERSION,
			writer: { model: FANTASY_EDITORIAL_MODEL, effort: 'xhigh' },
			reviewer: { model: FANTASY_EDITORIAL_MODEL, effort: 'xhigh' },
			counts: { drafts: 1, reviews: 1 },
			parts: outcome.candidate.parts,
		});
		expect(report.parts).toHaveLength(1);
		expect(report.editorialVersion).toBe('fantasy-editorial-v2');
		expect(report.parts[0]).not.toContain('Basis:');
		const start = report.parts[0].indexOf(editorialFixtureQuote);
		expect(start).toBeGreaterThan(-1);
		expect(Buffer.from(report.parts[0].slice(start, start + editorialFixtureQuote.length)))
			.toEqual(Buffer.from(editorialFixtureQuote));
		expect(JSON.stringify(parseSavedReport(JSON.parse(JSON.stringify(report))))).toBe(JSON.stringify(report));
	});

	it('keeps historical editorial-v1 approved bytes and identity unchanged', async () => {
		const input = JSON.parse(await readFile(new URL('./saved-report-editorial-v1.fixture.json', import.meta.url), 'utf8'));
		const before = JSON.stringify(input);
		const parsed = parseSavedReport(input);
		expect(parsed.editorialVersion).toBe('fantasy-editorial-v1');
		expect(parsed.id).toBe('report-017dc2248a597e98b21092e50b7ac87adc2b282780c8b98f901e58faf0b8dd7c');
		expect(parsed.parts[0]).toContain('Basis: weekly performance.');
		expect(Buffer.from(parsed.parts[0])).toEqual(Buffer.from(input.parts[0]));
		expect(JSON.stringify(parsed)).toBe(before);
	});

	it('preserves three ordered complete parts and stable versioned digests', async () => {
		const packet = await frozenEditorialFixture();
		const outcome = approved(packet, longDraft(packet));
		const report = buildSavedReport(packet, outcome);
		expect(report.parts).toHaveLength(3);
		report.parts.forEach((part, index) => {
			expect(part.startsWith(`Week 1 Recap (${index + 1}/3)\n\n`)).toBe(true);
			expect(part.length).toBeLessThanOrEqual(18_000);
			expect(part).toBe(outcome.candidate.parts[index]);
		});
		expect(report.id).toBe(withDigest(report).id);
		expect(buildSavedReport(packet, outcome)).toEqual(report);
		expect(parseSavedReport(report)).toEqual(report);
	});

	it('uses schema key order, not input object insertion order, when checking the digest', async () => {
		const packet = await frozenEditorialFixture();
		const report = buildSavedReport(packet, approved(packet));
		const reverse = (value: object) => Object.fromEntries(Object.entries(value).reverse());
		const input = reverse({
			...report,
			scope: reverse(report.scope),
			writer: reverse(report.writer),
			reviewer: reverse(report.reviewer),
			counts: reverse(report.counts),
		});
		expect(JSON.stringify(parseSavedReport(input))).toBe(JSON.stringify(report));
	});

	it('deeply freezes detached build/parse results without freezing caller objects or aliases', async () => {
		const packet = await frozenEditorialFixture();
		const outcome = structuredClone(approved(packet));
		const report = buildSavedReport(packet, outcome);
		expectFrozen(report);
		expect(Object.isFrozen(outcome.candidate.parts)).toBe(false);
		expect(Object.isFrozen(outcome.counts)).toBe(false);
		expect(Object.isFrozen(outcome.candidate.draft.manager)).toBe(false);
		outcome.candidate.parts[0] = 'caller changed';
		outcome.counts.drafts = 3;
		outcome.candidate.draft.manager.body = 'caller changed';
		expect(report.parts[0]).not.toBe('caller changed');
		expect(report.counts.drafts).toBe(1);
		expect(() => report.parts.push('changed')).toThrow();
		expect(() => {
			report.scope.week = 2;
		}).toThrow();

		const input = structuredClone(report);
		input.reviewer = input.writer;
		const parsed = parseSavedReport(input);
		expectFrozen(parsed);
		for (const key of ['scope', 'writer', 'reviewer', 'counts', 'parts'] as const) {
			expect(parsed[key]).not.toBe(input[key]);
			expect(Object.isFrozen(input[key])).toBe(false);
		}
		expect(parsed.writer).not.toBe(parsed.reviewer);
		input.scope.groupId = 'changed';
		input.counts.reviews = 3;
		input.parts[0] = 'changed';
		expect(parsed).toEqual(report);
	});

	it('retains only binding metadata and selected publishable text, not source or prompt material', async () => {
		const packet = structuredClone(await frozenEditorialFixture());
		packet.chat!.sources.push({ ...packet.chat!.sources[0], id: 'unselected', text: 'PRIVATE_UNSELECTED_CHAT' });
		packet.limitations.push('PRIVATE_EVIDENCE_CONTEXT');
		packet.id = `evidence-${createHash('sha256').update(JSON.stringify({ ...packet, id: '' })).digest('hex')}`;
		freezeFixture(packet);
		const outcome = approved(packet);
		const report = buildSavedReport(packet, outcome);
		const json = JSON.stringify(report);
		for (const value of [
			'PRIVATE_UNSELECTED_CHAT',
			'PRIVATE_EVIDENCE_CONTEXT',
			'PRIVATE_REVIEW_PROSE',
			outcome.candidate.draft.manager.body,
			'exact-source',
			'score:1:1',
			'frozenAtUtc',
			'collectionStartedAtUtc',
			'supportIds',
			'prompt',
			'draft',
			'review',
			'sources',
			'packet',
		]) {
			expect(json).not.toContain(JSON.stringify(value));
		}
		expect(json).toContain(JSON.stringify(editorialFixtureQuote).slice(1, -1));
		expect(report.scope.groupId).toBe(packet.scope.groupId);
		expect(report).not.toHaveProperty('approved');
		expect(report).not.toHaveProperty('authority');
	});

	const tamperCases: Array<[string, (report: SavedReport) => void]> = [
		['league', (report) => { report.scope.leagueId += '-other'; }],
		['group', (report) => { report.scope.groupId += '-other'; }],
		['season', (report) => { report.scope.season++; }],
		['week', (report) => { report.scope.week++; }],
		['evidence id', (report) => { report.evidenceId = `evidence-${'a'.repeat(64)}`; }],
		['candidate id', (report) => { report.candidateId = `candidate-${'b'.repeat(64)}`; }],
		['draft count', (report) => { report.counts.drafts = 2; }],
		['review count', (report) => { report.counts.reviews = 2; }],
		['part bytes', (report) => { report.parts[0] += ' '; }],
		['Unicode normalization', (report) => { report.parts[0] = report.parts[0].normalize('NFC'); }],
		['part order', (report) => { report.parts.reverse(); }],
		['part deletion', (report) => { report.parts.pop(); }],
	];
	it.each(tamperCases)('rejects %s mutation without a matching digest', async (_label, tamper) => {
		const packet = await frozenEditorialFixture();
		const outcome = approved(packet, longDraft(packet));
		outcome.counts.drafts = 3;
		const report = structuredClone(buildSavedReport(packet, outcome));
		tamper(report);
		invalid(() => parseSavedReport(report));
	});

	const shapeCases: Array<[string, (report: SavedReport) => void]> = [
		['version', (report) => { Object.assign(report, { version: 'fantasy-saved-report-v2' }); }],
		['editorial version', (report) => { Object.assign(report, { editorialVersion: 'fantasy-editorial-v3' }); }],
		['writer model alias', (report) => { Object.assign(report.writer, { model: 'gpt-6-astra' }); }],
		['reviewer model', (report) => { Object.assign(report.reviewer, { model: 'openai-codex/gpt-6-sol' }); }],
		['writer effort', (report) => { Object.assign(report.writer, { effort: 'high' }); }],
		['reviewer effort', (report) => { Object.assign(report.reviewer, { effort: 'high' }); }],
		['evidence prefix', (report) => { report.evidenceId = `candidate-${'a'.repeat(64)}`; }],
		['candidate length', (report) => { report.candidateId = `candidate-${'a'.repeat(63)}`; }],
		['candidate nonhex', (report) => { report.candidateId = `candidate-${'g'.repeat(64)}`; }],
		['uppercase id alias', (report) => { report.evidenceId = `evidence-${'A'.repeat(64)}`; }],
		['evidence newline suffix', (report) => { report.evidenceId += '\n'; }],
		['candidate newline suffix', (report) => { report.candidateId += '\n'; }],
		['root extra', (report) => { Object.assign(report, { privateSource: 'PRIVATE_SOURCE_STRING' }); }],
		['text alias', (report) => { Object.assign(report, { text: report.parts.join('\n') }); }],
		['scope extra', (report) => { Object.assign(report.scope, { group: 'PRIVATE_GROUP_ALIAS' }); }],
		['writer extra', (report) => { Object.assign(report.writer, { prompt: 'PRIVATE_PROMPT' }); }],
		['reviewer extra', (report) => { Object.assign(report.reviewer, { review: 'PRIVATE_REVIEW_PROSE' }); }],
		['counts extra', (report) => { Object.assign(report.counts, { calls: 2 }); }],
		['no parts', (report) => { report.parts = []; }],
		['too many parts', (report) => { report.parts = ['one', 'two', 'three', 'four']; }],
		['blank part', (report) => { report.parts = [' \n\t']; }],
		['empty part', (report) => { report.parts = ['']; }],
		['oversize part', (report) => { report.parts = ['a'.repeat(18_001)]; }],
		['UTF16 overflow', (report) => { report.parts = ['🏈'.repeat(9_001)]; }],
		['nonstring part', (report) => { Object.assign(report, { parts: [123] }); }],
	];
	it.each(shapeCases)('rejects %s even with a recomputed digest', async (_label, mutate) => {
		const packet = await frozenEditorialFixture();
		const report = structuredClone(buildSavedReport(packet, approved(packet)));
		mutate(report);
		invalid(() => parseSavedReport(withDigest(report)));
	});

	it('rejects malformed roots, missing fields and report IDs with only the constant error', async () => {
		const packet = await frozenEditorialFixture();
		const report = buildSavedReport(packet, approved(packet));
		for (const input of [null, undefined, [], 'PRIVATE_SOURCE_STRING', {}, JSON.stringify(report)])
			invalid(() => parseSavedReport(input));
		for (const key of Object.keys(report)) {
			const input: Record<string, unknown> = { ...report };
			delete input[key];
			invalid(() => parseSavedReport(input));
		}
		for (const id of ['alias', `evidence-${'a'.repeat(64)}`, `report-${'z'.repeat(64)}`, `report-${'a'.repeat(63)}`, `report-${'a'.repeat(64)}`])
			invalid(() => parseSavedReport({ ...report, id }));
		invalid(() => parseSavedReport({
			...report,
			get parts() { throw new Error('PRIVATE_GETTER_ERROR'); },
		}));
	});

	it('enforces exact scope types and bounds, without trimming or accepting numeric aliases', async () => {
		const packet = await frozenEditorialFixture();
		const report = buildSavedReport(packet, approved(packet));
		const cases: Array<[keyof SavedReportScope, unknown[]]> = [
			['leagueId', ['', ' \n', 'x'.repeat(501), 123, null]],
			['groupId', ['', '\t', 'x'.repeat(501), 123, null]],
			['season', [1919, 2101, 2026.5, '2026', Number.NaN, Number.POSITIVE_INFINITY]],
			['week', [0, 23, 1.5, '1', Number.NaN, Number.POSITIVE_INFINITY]],
		];
		for (const [key, values] of cases) {
			for (const value of values) {
				const input = structuredClone(report);
				Object.assign(input.scope, { [key]: value });
				invalid(() => parseSavedReport(withDigest(input)));
			}
		}
		for (const [season, week] of [[1920, 1], [2100, 22]]) {
			const input = structuredClone(report);
			input.scope = { leagueId: 'x'.repeat(500), groupId: ' private-group ', season, week };
			input.parts = ['🏈'.repeat(9_000)];
			expect(parseSavedReport(withDigest(input))).toEqual(withDigest(input));
		}
	});

	it('accepts only feasible positive draft/review counts up to three in both entrypoints', async () => {
		const packet = await frozenEditorialFixture();
		const outcome = approved(packet);
		for (let drafts = 1; drafts <= 3; drafts++) {
			for (let reviews = 1; reviews <= drafts; reviews++) {
				outcome.counts = { drafts, reviews };
				const report = buildSavedReport(packet, outcome);
				expect(parseSavedReport(report).counts).toEqual(outcome.counts);
			}
		}
		for (const key of ['drafts', 'reviews'] as const) {
			for (const value of [0, -1, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
				const invalidOutcome = { ...outcome, counts: { drafts: 1, reviews: 1, [key]: value } };
				invalid(() => buildSavedReport(packet, invalidOutcome as EditorialOutcome));
				const report = structuredClone(buildSavedReport(packet, outcome));
				Object.assign(report.counts, { [key]: value });
				invalid(() => parseSavedReport(withDigest(report)));
			}
		}
		outcome.counts = { drafts: 1, reviews: 2 };
		invalid(() => buildSavedReport(packet, outcome));
		const report = structuredClone(buildSavedReport(packet, approved(packet)));
		report.counts = outcome.counts;
		invalid(() => parseSavedReport(withDigest(report)));
	});

	it('accepts a scripted final pass after three drafts and three reviews without retaining prior prose', async () => {
		const packet = await frozenEditorialFixture();
		let drafts = 0;
		let reviews = 0;
		const outcome = await runEditorialLoop(packet, {
			write: async () => {
				const draft = validEditorialDraft(packet);
				draft.manager.body = ++drafts < 3 ? 'PRIVATE_REJECTED_DRAFT' : 'The final supported interpretation.';
				return draft;
			},
			review: async (assignment) => {
				const { candidate } = JSON.parse(assignment);
				return {
					evidenceId: packet.id,
					candidateId: candidate.id,
					verdict: ++reviews < 3 ? 'fail' : 'pass',
					issues: reviews < 3 ? [reviewIssue] : [],
				};
			},
		});
		const report = buildSavedReport(packet, outcome);
		expect(report.counts).toEqual({ drafts: 3, reviews: 3 });
		expect(JSON.stringify(report)).not.toContain('PRIVATE_REJECTED_DRAFT');
		expect(JSON.stringify(report)).not.toContain('PRIVATE_REVIEW_PROSE');
	});

	const outcomeCases: Array<[string, (outcome: Approved) => void]> = [
		['outcome evidence', (outcome) => { outcome.evidenceId = `evidence-${'a'.repeat(64)}`; }],
		['candidate evidence', (outcome) => { outcome.candidate.evidenceId = `evidence-${'a'.repeat(64)}`; }],
		['candidate version', (outcome) => { Object.assign(outcome.candidate, { version: 'fantasy-editorial-v3' }); }],
		['candidate id', (outcome) => {
			outcome.candidate.id = `candidate-${'a'.repeat(64)}`;
			outcome.review.candidateId = outcome.candidate.id;
		}],
		['changed part bytes', (outcome) => { outcome.candidate.parts[0] += ' '; }],
		['changed part order', (outcome) => { outcome.candidate.parts.reverse(); }],
		['changed raw draft', (outcome) => { outcome.candidate.draft.manager.body = 'Changed after review.'; }],
		['nonrendering draft change', (outcome) => { outcome.candidate.draft.manager.supportIds.push('scope'); }],
		['invalid draft', (outcome) => { outcome.candidate.draft.manager.body = 'Invented 999 points.'; }],
		['failed review', (outcome) => {
			outcome.review.verdict = 'fail';
			outcome.review.issues = [reviewIssue];
		}],
		['pass with issues', (outcome) => { outcome.review.issues = [reviewIssue]; }],
		['stale review', (outcome) => { outcome.review.candidateId = `candidate-${'b'.repeat(64)}`; }],
		['foreign review evidence', (outcome) => { outcome.review.evidenceId = `evidence-${'b'.repeat(64)}`; }],
		['malformed review', (outcome) => { Object.assign(outcome.review, { issues: null }); }],
		['review prose alias', (outcome) => { Object.assign(outcome.review, { replacement: 'PRIVATE_REVIEW_PROSE' }); }],
		['model-supplied scope', (outcome) => { Object.assign(outcome, { scope: { groupId: 'wrong-group' } }); }],
	];
	it.each(outcomeCases)('rejects %s rather than saving an unreviewed artifact', async (_label, mutate) => {
		const packet = await frozenEditorialFixture();
		const outcome = structuredClone(approved(packet, longDraft(packet)));
		mutate(outcome);
		invalid(() => buildSavedReport(packet, outcome));
	});

	it('rejects blocked outcomes and mutable or only shallow-frozen evidence', async () => {
		const packet = await frozenEditorialFixture();
		const outcome = approved(packet);
		invalid(() => buildSavedReport(packet, {
			status: 'blocked',
			evidenceId: packet.id,
			reason: 'PRIVATE_BLOCK_REASON',
			candidateId: null,
			counts: { drafts: 0, reviews: 0 },
			issues: [],
		}));
		invalid(() => buildSavedReport(structuredClone(packet), outcome));
		invalid(() => buildSavedReport(Object.freeze(structuredClone(packet)), outcome));
	});

	const packetCases: Array<[string, (packet: RecapEvidencePacket) => void]> = [
		['blocked', (packet) => { packet.status = 'blocked'; }],
		['not admitted', (packet) => { packet.admission.canDraft = false; }],
		['admission blockers', (packet) => { packet.admission.blockers.push('scope:invalid'); }],
		['blocking gap', (packet) => { packet.gaps.push({ source: 'scope', code: 'invalid', blocking: true }); }],
		['missing facts', (packet) => { packet.facts = null; }],
		['missing chat', (packet) => { packet.chat = null; }],
		['incomplete archive', (packet) => { packet.chat!.status = 'unavailable'; }],
		['blank group', (packet) => { packet.scope.groupId = ' \t'; }],
		['oversize group', (packet) => { packet.scope.groupId = 'x'.repeat(501); }],
		['wrong league', (packet) => { packet.scope.leagueId = 'wrong-league'; }],
		['wrong season', (packet) => { packet.scope.season = '2027'; }],
		['season alias', (packet) => { packet.scope.season = '2.026e3'; }],
		['absent season', (packet) => { packet.scope.season = null; }],
		['wrong week', (packet) => { packet.scope.week = 2; }],
		['wrong facts scope', (packet) => { packet.facts!.leagueId = 'wrong-league'; }],
	];
	it.each(packetCases)('rejects %s evidence with the same private-safe error', async (_label, mutate) => {
		const source = await frozenEditorialFixture();
		const packet = structuredClone(source);
		mutate(packet);
		invalid(() => buildSavedReport(freezeFixture(packet), approved(source)));
	});

	it('compares every scope field exactly and takes no scope from model-owned output', async () => {
		const packet = await frozenEditorialFixture();
		const report = buildSavedReport(packet, approved(packet));
		expect(sameSavedReportScope(report, { ...report.scope })).toBe(true);
		for (const field of ['leagueId', 'groupId', 'season', 'week'] as const) {
			const scope = { ...report.scope };
			const value = scope[field];
			Object.assign(scope, { [field]: typeof value === 'number' ? value + 1 : `${value} ` });
			expect(sameSavedReportScope(report, scope)).toBe(false);
		}
		expect(sameSavedReportScope(report, { ...report.scope, season: '2026' } as unknown as SavedReportScope)).toBe(false);
	});
});
