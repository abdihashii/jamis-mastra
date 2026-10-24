import type { EditorialDraft, EditorialIssue } from '../editorial';
import type { RecapEvidencePacket } from '../recap-evidence';
import type { SleeperLeague, SleeperManager, SleeperScore } from '../sleeper';
import { describe, expect, it } from 'bun:test';
import { Buffer } from 'node:buffer';
import {
	buildEditorialCandidate,
	buildEditorialCatalog,
	EDITORIAL_MAX_PARTS,
	EDITORIAL_PART_MAX_LENGTH,
	editorialDraftSchema,
} from '../editorial';
import { buildWeekFacts } from '../week-facts';

const now = '2026-09-23T12:00:00.000Z';
const quoteText = '  Watch this. 🏈 e\u0301 **exact**\r\n\n{fact:scope:week} stays literal.  ';
const matchId = 'match:2026:2:1:2';

function fixture(): RecapEvidencePacket {
	const league: SleeperLeague = {
		id: 'private-league-id',
		name: 'League',
		season: '2026',
		status: 'in_season',
		totalRosters: 4,
		playoffWeekStart: 15,
		playoffRounds: 3,
		rosterPositions: ['RB', 'BN'],
		scoringSettings: { rec: 0.5 },
	};
	const managers: SleeperManager[] = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((displayName, index) => ({
		rosterId: index + 1,
		userId: `private-user-${index}`,
		displayName,
	}));
	const rows: SleeperScore[] = [120, 80, 130, 129].map((points, index) => ({
		rosterId: index + 1,
		points,
		matchupId: index < 2 ? 10 : 20,
		starters: [`p${index + 1}`],
		players: [`p${index + 1}`, `b${index + 1}`],
		playerPoints: { [`p${index + 1}`]: 30 - index, [`b${index + 1}`]: 20 },
	}));
	const scoresByWeek = new Map([[1, structuredClone(rows)], [2, rows]]);
	return {
		id: `evidence-${'a'.repeat(64)}`,
		version: 'fantasy-evidence-v1',
		collectionStartedAtUtc: now,
		frozenAtUtc: now,
		scope: { leagueId: league.id, groupId: 'private-group-id', season: '2026', week: 2, chatWindow: { startAtUtc: '2026-09-15T00:00:00.000Z', endAtUtc: '2026-09-22T00:00:00.000Z' } },
		status: 'ready',
		admission: { canDraft: true, blockers: [] },
		league,
		state: { season: '2026', week: 3, seasonType: 'regular' },
		bracket: [],
		managers,
		facts: buildWeekFacts({ league, week: 2, managers, bracket: [], scoresByWeek }),
		scores: [...scoresByWeek].map(([week, rows]) => ({ week, retrievedAtUtc: now, rows })),
		players: { retrievedAtUtc: now, missingIds: [], details: [
			{ id: 'p1', name: 'Runner One', position: 'RB', team: 'KC', fantasyPositions: ['RB'], gsisId: null },
			{ id: 'b1', name: 'Bench One', position: 'RB', team: 'KC', fantasyPositions: ['RB'], gsisId: null },
		] },
		transactions: { retrievedAtUtc: now, excludedNonComplete: 0, completed: [{
			id: 'tx1',
			type: 'trade',
			status: 'complete',
			week: 2,
			rosterIds: [1, 2],
			createdAtUtc: '2026-09-16T02:00:00.000Z',
			statusUpdatedAtUtc: '2026-09-16T08:00:00.000Z',
			adds: [{ playerId: 'p1', rosterId: 1 }],
			drops: [{ playerId: 'old', rosterId: 1 }],
			waiverBid: 4,
			draftPicks: [{ season: '2027', round: 3, rosterId: 1, previousOwnerId: 1, ownerId: 2 }],
			faabTransfers: [{ sender: 1, receiver: 2, amount: 10 }],
		}] },
		chat: {
			status: 'complete',
			window: { startAtUtc: '2026-09-15T00:00:00.000Z', endAtUtc: '2026-09-22T00:00:00.000Z' },
			windowBasis: 'caller-supplied',
			coverage: 'archived-window-only',
			readCount: 1,
			excluded: { unmapped: 0, privateContact: 0, recap: 0, reaction: 0, nonText: 0 },
			gaps: [],
			sources: [{ id: 'message1', rosterId: 1, sender: 'Alpha', createdAtUtc: '2026-09-18T01:00:00.000Z', text: quoteText, trust: 'untrusted-source-data', quoteReview: 'required' }],
		},
		nfl: [{
			trust: 'untrusted-source-data',
			input: { operation: 'weekly-results', season: 2026, week: 2, position: 'RB', scoring: 'HALF' },
			status: 'success',
			requestId: 'request',
			catalogueRequestId: 'catalogue',
			credits: 5,
			quotedCredits: 5,
			chargeIdPresent: false,
			adminActionUrl: null,
			gaps: [],
			excludedRecords: 0,
			source: { provider: 'startwho-com', capability: 'fantasy-sports-rankings/weekly_results', scope: { operation: 'weekly-results', season: 2026, week: 2, position: 'RB', scoring: 'HALF' }, url: 'https://startwho.com/api/week-results?week=2&format=Half-PPR&position=RB', retrievedAtUtc: now, observedAtUtc: now, sourceDate: null, snapshotAsOfUtc: null, licenseState: 'unknown', coverage: 'current-season-week', scoring: 'HALF', truncated: false },
			findings: [{ playerId: 'p1', mapping: 'current-name-team-position', record: {
				kind: 'weekly-result',
				sourceId: 'runner-one',
				name: 'Runner One',
				position: 'RB',
				teamName: 'Kansas City Chiefs',
				opponent: 'BUF',
				projectedPoints: 12.5,
				actualPoints: 25,
				actualStats: { rush_yds: 100 },
				kickoffAtUtc: '2026-09-20T17:00:00.000Z',
				status: 'final',
			} }],
		}],
		lineups: [{ rosterId: 1, playerId: 'p1', slot: 'RB', points: 30, kickoffAtUtc: '2026-09-20T17:00:00.000Z', positionCompatibleBenchIds: ['b1'], availabilityBeforeKickoff: 'unknown' }],
		acquisitions: [{ transactionId: 'tx1', rosterId: 1, playerId: 'p1', started: true, leaguePoints: 30, statusUpdatedAtUtc: '2026-09-16T08:00:00.000Z', kickoffAtUtc: '2026-09-20T17:00:00.000Z', knownCompleteBeforeKickoff: true, decisionQuality: 'not-established' }],
		observations: [{ source: 'scores-2', retrievedAtUtc: now, available: true }],
		gaps: [],
		limitations: ['No immutable pre-kickoff snapshot exists.'],
	};
}

function draft(packet: RecapEvidencePacket): EditorialDraft {
	return {
		evidenceId: packet.id,
		manager: { rosterIds: [1], basis: 'performance', supportIds: [matchId, 'score:2:1', 'player-score:2:1:p1'], body: '{manager:1} made a convincing case with {fact:score:2:1:points} points, including {player:p1} at {fact:player-score:2:1:p1:points}.' },
		loser: { rosterIds: [4], basis: 'performance', supportIds: ['score:2:4'], body: 'A big total with nothing to show for it.' },
		match: { matchupIds: [matchId], supportIds: [matchId], body: 'The loudest result was not the closest contest.' },
		quote: { messageId: 'message1', supportIds: ['chat:message1', matchId], body: 'Confidence acquired a very comfortable seat.' },
		stories: [{ headline: 'Help that arrived on time', supportIds: ['transaction:0', 'acquisition:0'], body: 'The recent addition delivered immediate value.' }],
	};
}
function candidate(packet = fixture(), input = draft(packet)) {
	const result = buildEditorialCandidate(packet, input);
	if (result.status !== 'candidate')
		throw new Error(JSON.stringify(result.issues));
	return result.candidate;
}
function issues(packet: RecapEvidencePacket, input: unknown): EditorialIssue[] {
	const result = buildEditorialCandidate(packet, input);
	expect(result.status).toBe('invalid');
	return result.status === 'invalid' ? result.issues : [];
}
function codes(packet: RecapEvidencePacket, input: unknown): string[] {
	return issues(packet, input).map(issue => issue.code);
}

describe('deterministic editorial candidates (off live path)', () => {
	it('renders the complete report with Pundit-selected awards, not high/low/closest defaults', () => {
		const packet = fixture();
		const out = candidate(packet);
		const text = out.parts.join('\n\n');
		expect(text).toContain('Manager of the Week: Alpha\nBasis: weekly performance.');
		expect(text).toContain('Loser of the Week: Delta');
		expect(text).toContain('Match of the Week: Alpha 120 vs. Bravo 80 (margin 40)');
		expect(text).toContain('Alpha made a convincing case with 120 points, including Runner One at 30.');
		expect(text).toContain(`Quote of the Week: Alpha\n\n${quoteText}`);
		expect(text).toContain('Stories of the Week\n\nHelp that arrived on time');
		expect(packet.facts!.high!.teams[0].rosterId).toBe(3);
		expect(packet.facts!.low!.teams[0].rosterId).toBe(2);
		expect(packet.facts!.closest!.a.rosterId).toBe(3);
		expect(out.parts.length).toBe(1);
		expect(out).not.toHaveProperty('approved');
	});

	it('exposes a closed object-root schema with every field required for native structured output', () => {
		const schema = editorialDraftSchema.toJSONSchema();
		expect(schema.type).toBe('object');
		expect(schema.additionalProperties).toBe(false);
		expect(schema.required).toEqual(['evidenceId', 'manager', 'loser', 'match', 'quote', 'stories']);
	});

	it('preserves exact multiline Unicode quote bytes and never interprets references inside source text', () => {
		const out = candidate();
		const start = out.parts[0].indexOf(quoteText);
		expect(start).toBeGreaterThan(-1);
		expect(Buffer.from(out.parts[0].slice(start, start + quoteText.length))).toEqual(Buffer.from(quoteText));
		expect(out.parts[0]).toContain('{fact:scope:week} stays literal.');
	});

	it('does not recursively interpret untrusted subject labels', () => {
		const packet = fixture();
		packet.managers[0].displayName = 'Alpha {fact:scope:week}';
		packet.chat!.sources[0].sender = packet.managers[0].displayName;
		expect(candidate(packet).parts[0]).toContain('Alpha {fact:scope:week} made a convincing case');
	});

	it('keeps all usable player/history/transaction references and provider points separate', () => {
		const packet = fixture();
		const catalog = buildEditorialCatalog(packet);
		const numbers = new Map(catalog.facts.map(fact => [fact.id, fact.value]));
		expect(numbers.get('score:1:1:points')).toBe(120);
		expect(numbers.get('player-score:2:1:b1:points')).toBe(20);
		expect(numbers.get('player-score:2:1:p1:points')).toBe(30);
		expect(numbers.get('nfl:0:0:actualPoints')).toBe(25);
		expect(numbers.get('nfl:0:0:actualStats.rush_yds')).toBe(100);
		expect(numbers.get('transaction:0:waiverBid')).toBe(4);
		expect(numbers.get('transaction:0:pick.0.round')).toBe(3);
		expect(numbers.get('transaction:0:pick.0.season')).toBe(2027);
		expect(numbers.get('transaction:0:faab.0.amount')).toBe(10);
		expect(catalog.sources.find(source => source.id === 'transaction:0')!.data).toMatchObject({ drops: [{ playerId: 'old' }] });
		expect(catalog.sources.find(source => source.id === 'nfl:0:0')!.data).toMatchObject({ source: { scoring: 'HALF', snapshotAsOfUtc: null } });
		expect(JSON.stringify(catalog)).not.toContain('private-group-id');
		expect(JSON.stringify(catalog)).not.toContain('private-user-');
		expect(JSON.stringify(catalog)).not.toContain('private-league-id');
	});

	it('resolves every admitted numeric reference, including zero and negative values, from its cited source', () => {
		const packet = fixture();
		packet.scores[1].rows[0].playerPoints.p1 = 0;
		packet.scores[1].rows[0].playerPoints.b1 = -2.5;
		for (const fact of buildEditorialCatalog(packet).facts) {
			const input = draft(packet);
			input.manager.supportIds = [...new Set([...input.manager.supportIds, fact.sourceId])];
			input.manager.body = `An observed value of {fact:${fact.id}}.`;
			expect(candidate(packet, input).parts.join('\n')).toContain(`An observed value of ${fact.value}.`);
		}
	});

	it('withholds raw historical rows when the evidence owner could not validate that history', () => {
		const packet = fixture();
		packet.facts!.standings = null;
		packet.facts!.movement = [];
		packet.scores[0].rows[0].points = 999;
		packet.gaps.push({ source: 'league', code: 'standings_history_invalid', blocking: false });
		const catalog = buildEditorialCatalog(packet);
		expect(catalog.facts.find(fact => fact.id === 'score:1:1:points')).toBeUndefined();
		expect(catalog.facts.find(fact => fact.id === 'score:2:1:points')!.value).toBe(120);
		expect(candidate(packet).parts[0]).toContain('Manager of the Week: Alpha');
	});

	it('allows shared editorial honors without demanding equal point totals', () => {
		const packet = fixture();
		const input = draft(packet);
		input.manager.rosterIds = [1, 3];
		input.manager.supportIds.push('score:2:3');
		input.match.matchupIds.push('match:2026:2:3:4');
		input.match.supportIds.push('match:2026:2:3:4');
		expect(candidate(packet, input).parts[0]).toContain('Manager of the Week: Alpha & Charlie');
		expect(candidate(packet, input).parts[0]).toContain('Charlie 130 vs. Delta 129 (margin 1)');
	});

	it('preserves factual matchup ties without inventing winners', () => {
		const packet = fixture();
		Object.assign(packet.facts!.results[0], { aPoints: 100, bPoints: 100, margin: 0, winner: null, loser: null });
		expect(candidate(packet).parts[0]).toContain('Alpha 100 vs. Bravo 100 (tie)');
	});

	it('allows no suitable quote and zero stories without claiming nobody spoke', () => {
		const packet = fixture();
		const input = draft(packet);
		input.quote = null;
		input.stories = [];
		const text = candidate(packet, input).parts[0];
		expect(text).toContain('No suitable quote earned the award this week.');
		expect(text).toContain('No additional stories warranted a write-up.');
		expect(text).not.toContain('nobody');
	});

	it('has no inherited four-story, sentence or short-report quota', () => {
		const packet = fixture();
		const input = draft(packet);
		input.stories = ['first', 'second', 'third', 'fourth', 'fifth'].map(angle => ({
			headline: `The ${angle} angle`,
			body: `A distinct ${angle} observation. Context follows. Consequences follow. No forced balance.`,
			supportIds: [matchId],
		}));
		const text = candidate(packet, input).parts.join('\n\n');
		expect(text).toContain('The fifth angle');
		expect(input.stories.every(story => text.includes(story.body))).toBe(true);
	});

	it('requires an actual completed matchup rather than inventing a Match award for bye-only evidence', () => {
		const packet = fixture();
		packet.facts!.results = [];
		expect(codes(packet, draft(packet))).toContain('unsupported_matchup');
	});

	it('allows a genuinely empty archive and optional history/player/NFL gaps', () => {
		const packet = fixture();
		packet.chat!.status = 'empty';
		packet.chat!.sources = [];
		packet.chat!.readCount = 0;
		packet.players.details = [];
		packet.nfl = [];
		packet.scores = packet.scores.filter(row => row.week === 2);
		packet.facts!.standings = null;
		packet.facts!.movement = [];
		packet.status = 'partial';
		packet.gaps.push({ source: 'history', code: 'unavailable', blocking: false });
		const input = draft(packet);
		input.quote = null;
		input.manager.body = 'A weekly performance with substance.';
		expect(candidate(packet, input).parts[0]).toContain('Manager of the Week: Alpha');
		expect(buildEditorialCatalog(packet).sources.some(source => source.kind === 'standing')).toBe(false);
		expect(codes(packet, draft(packet))).toContain('unknown_reference');
	});

	it.each(['blocked', 'unavailable', 'partial', 'truncated', 'missing'])('rejects %s evidence/archive before considering an empty quote', (fault) => {
		const packet = fixture();
		const input = draft(packet);
		input.quote = null;
		if (fault === 'blocked')
			packet.admission.canDraft = false;
		else if (fault === 'missing')
			packet.chat = null;
		else packet.chat!.status = fault as 'unavailable' | 'partial' | 'truncated';
		expect(codes(packet, input)).toEqual(['evidence_not_admitted']);
	});

	it.each(['manager', 'loser'] as const)('withholds %s management judgments despite valid acquisition chronology', (section) => {
		const packet = fixture();
		const input = draft(packet);
		input[section].basis = 'management';
		input[section].supportIds.push('acquisition:0');
		expect(packet.acquisitions[0].knownCompleteBeforeKickoff).toBe(true);
		expect(codes(packet, input)).toContain('management_evidence_unavailable');
	});

	it('rejects foreign evidence and never exposes raw shape errors/private extra fields', () => {
		const packet = fixture();
		const input = draft(packet);
		input.evidenceId = 'foreign';
		expect(codes(packet, input)).toContain('evidence_mismatch');
		const unsafe = { ...draft(packet), PRIVATE_EXTRA_SENTINEL: 'PRIVATE_BODY_SENTINEL' };
		expect(JSON.stringify(issues(packet, unsafe))).toBe('[{"path":"","code":"invalid_draft_shape"}]');
		expect(codes(packet, { ...draft(packet), quote: { ...draft(packet).quote, text: 'invented' } })).toContain('invalid_draft_shape');
		expect(codes(packet, { ...draft(packet), quote: { ...draft(packet).quote, start: 0, end: 5 } })).toContain('invalid_draft_shape');
		expect(editorialDraftSchema.safeParse({ ...draft(packet), manager: { ...input.manager, rosterIds: [] } }).success).toBe(false);
	});

	it.each([
		['unknown_reference', 'The total was {fact:score:2:1:fake}.'],
		['unknown_reference', 'The total belonged to {manager:999}.'],
		['unknown_reference', 'A performance from {player:unknown}.'],
		['malformed_reference', 'The total was {arbitrary:score}.'],
		['malformed_reference', 'An unfinished {fact:scope:week.'],
		['unreferenced_number', 'A fabricated total of 999.'],
		['unreferenced_number', 'A fabricated total of ١٢.'],
		['uncited_numeric_source', 'The provider total was {fact:nfl:0:0:actualPoints}.'],
	])('rejects %s in model-authored prose', (expected, body) => {
		const packet = fixture();
		const input = draft(packet);
		input.manager.body = body;
		expect(codes(packet, input)).toContain(expected);
	});

	it('requires subject-support agreement, not merely existing source IDs', () => {
		const packet = fixture();
		const input = draft(packet);
		input.manager.rosterIds = [3];
		expect(codes(packet, input)).toContain('unsupported_award_subject');
		input.manager.rosterIds = [999];
		expect(codes(packet, input)).toContain('unknown_manager');
		input.manager.rosterIds = [1];
		input.manager.supportIds = ['chat:message1'];
		input.manager.body = 'The trash talk was very confident.';
		expect(codes(packet, input)).toContain('unsupported_award_subject');
	});

	it('does not use a null-scored bye as evidence of a weekly award performance', () => {
		const packet = fixture();
		packet.facts!.results = [packet.facts!.results[0]];
		for (const row of packet.scores[1].rows.slice(2)) {
			row.matchupId = null;
			row.points = null;
			row.starters = [];
			row.playerPoints = {};
		}
		const input = draft(packet);
		expect(codes(packet, input)).toContain('unsupported_award_subject');
		packet.scores[1].rows[3].points = 0;
		expect(candidate(packet, input).parts[0]).toContain('Loser of the Week: Delta');
	});

	it('retains historical matchup identity so equal scores can be distinguished as wins or losses', () => {
		const packet = fixture();
		const source = buildEditorialCatalog(packet).sources.find(row => row.id === 'score:1:1')!;
		expect(source.data).toMatchObject({ week: 1, matchupId: 10, points: 120 });
	});

	it.each([
		'{fact:score:2:1:points}{fact:score:2:1:points}',
		'-{fact:score:2:1:points}',
		'−{fact:score:2:1:points}',
		'.{fact:score:2:1:points}',
		'{fact:score:2:1:points}.{fact:score:2:1:points}',
		'{fact:score:2:1:points},{fact:score:2:1:points}',
		'{fact:score:2:1:points}e{fact:score:2:1:points}',
		'{fact:score:2:1:points}k',
		'{fact:score:2:1:points}\u200D{fact:score:2:1:points}',
		'-\u200D{fact:score:2:1:points}',
	])('does not manufacture a different numeric value by modifying reference %s', (expression) => {
		const packet = fixture();
		const input = draft(packet);
		input.manager.body = `The total was ${expression}.`;
		expect(codes(packet, input)).toContain('modified_numeric_reference');
	});

	it('preserves natural numeric punctuation, score separators and source-native negative values', () => {
		const packet = fixture();
		const input = draft(packet);
		packet.scores[1].rows[0].playerPoints.b1 = -2.5;
		input.manager.supportIds.push('player-score:2:1:b1');
		input.manager.body = 'Totals ({fact:score:2:1:points}), {fact:score:2:1:points}–{fact:score:2:1:points}; bench: {fact:player-score:2:1:b1:points}.';
		expect(candidate(packet, input).parts[0]).toContain('Totals (120), 120–120; bench: -2.5.');
	});

	it('rejects duplicate selections/support and non-match references in match selection', () => {
		const packet = fixture();
		const input = draft(packet);
		input.manager.rosterIds.push(1);
		input.match.matchupIds.push(matchId);
		input.match.supportIds.push(matchId);
		expect(codes(packet, input)).toContain('duplicate_selection');
		expect(codes(packet, input)).toContain('duplicate_support');
		input.match.matchupIds = ['score:2:1'];
		expect(codes(packet, input)).toContain('unsupported_matchup');
	});

	it.each(['foreign', 'attribution', 'uncited'])('rejects a %s quote instead of substituting its text', (fault) => {
		const packet = fixture();
		const input = draft(packet);
		if (fault === 'foreign')
			input.quote!.messageId = 'unknown';
		if (fault === 'attribution')
			packet.chat!.sources[0].sender = 'Someone else';
		if (fault === 'uncited')
			input.quote!.supportIds = [matchId];
		expect(codes(packet, input)).toContain('unsupported_quote');
	});

	it('rejects unknown supports, repeated prose and multiline headlines', () => {
		const packet = fixture();
		const input = draft(packet);
		input.stories.push({ ...input.stories[0], supportIds: ['not-a-source'] });
		input.stories[1].headline = 'Unexpected\nheading';
		const found = codes(packet, input);
		expect(found).toContain('unknown_support');
		expect(found).toContain('repeated_content');
		expect(found).toContain('multiline_headline');
	});

	it('keeps a report at the exact single-part ceiling in one message, accounting for the shorter header', () => {
		const packet = fixture();
		const input = draft(packet);
		const baseline = candidate(packet, input).parts[0].length;
		input.manager.body += 'x'.repeat(EDITORIAL_PART_MAX_LENGTH - baseline);
		const out = candidate(packet, input);
		expect(out.parts).toHaveLength(1);
		expect(out.parts[0]).toHaveLength(EDITORIAL_PART_MAX_LENGTH);
	});

	it('packs three complete ordered parts without cutting quotes/stories or silently dropping material', () => {
		const packet = fixture();
		const input = draft(packet);
		input.manager.body = `Opening ${'a'.repeat(10_000)}`;
		input.loser.body = `Middle ${'b'.repeat(10_000)}`;
		input.match.body = `Closing ${'c'.repeat(10_000)}`;
		const out = candidate(packet, input);
		expect(out.parts).toHaveLength(3);
		out.parts.forEach((part, index) => {
			expect(part.startsWith(`Week 2 Recap (${index + 1}/3)`)).toBe(true);
			expect(part.length).toBeLessThanOrEqual(EDITORIAL_PART_MAX_LENGTH);
		});
		expect(out.parts[0]).toContain(input.manager.body);
		expect(out.parts[1]).toContain(input.loser.body);
		expect(out.parts[2]).toContain(input.match.body);
		expect(out.parts[2]).toContain(quoteText);
		expect(out.parts[2]).toContain(input.stories[0].body);
	});

	it('rejects a fourth part and oversized indivisible Unicode quotes, retaining every source byte', () => {
		const packet = fixture();
		const input = draft(packet);
		input.manager.body = `Opening ${'a'.repeat(10_000)}`;
		input.loser.body = `Middle ${'b'.repeat(10_000)}`;
		input.match.body = `Closing ${'c'.repeat(10_000)}`;
		input.stories[0].body = `Another ${'d'.repeat(10_000)}`;
		expect(codes(packet, input)).toEqual(['report_parts_overflow']);
		packet.chat!.sources[0].text = '🏈'.repeat(EDITORIAL_PART_MAX_LENGTH / 2);
		const original = packet.chat!.sources[0].text;
		expect(codes(packet, draft(packet))).toEqual(['indivisible_block_overflow']);
		expect(packet.chat!.sources[0].text).toBe(original);
		expect(EDITORIAL_MAX_PARTS).toBe(3);
	});

	it('isolates caller mutations and binds draft, evidence and exact quote/part bytes into the candidate identity', () => {
		const packet = fixture();
		const input = draft(packet);
		const out = candidate(packet, input);
		expect(candidate(packet, input).id).toBe(out.id);
		expect(Object.isFrozen(out.draft.manager.rosterIds)).toBe(true);
		expect(Object.isFrozen(out.parts)).toBe(true);
		input.manager.body = 'Changed externally.';
		expect(out.draft.manager.body).not.toBe(input.manager.body);
		expect(candidate(packet, input).id).not.toBe(out.id);
		packet.chat!.sources[0].text += '\n';
		expect(candidate(packet).id).not.toBe(out.id);
		packet.id = `evidence-${'b'.repeat(64)}`;
		expect(candidate(packet).id).not.toBe(out.id);
		const catalog = buildEditorialCatalog(packet);
		(catalog.sources.find(source => source.id === 'transaction:0')!.data as { id: string }).id = 'changed';
		expect(packet.transactions.completed[0].id).toBe('tx1');
	});
});
