import type { RecapEvidencePacket } from './recap-evidence';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolveChatSource } from './recap-evidence';

export const EDITORIAL_VERSION = 'fantasy-editorial-v1';
// Sendblue documents a less-than-18,996-character limit; count UTF-16 units conservatively.
export const EDITORIAL_PART_MAX_LENGTH = 18_000;
export const EDITORIAL_MAX_PARTS = 3;

const prose = z.string().refine(value => value.trim().length > 0);
const ids = z.array(z.string().min(1));
const rosterIds = z.array(z.number().int().positive()).min(1);
const award = z.object({
	rosterIds,
	basis: z.enum(['performance', 'management']),
	supportIds: ids.min(1),
	body: prose,
}).strict();
export const editorialDraftSchema = z.object({
	evidenceId: z.string().min(1),
	manager: award,
	loser: award,
	match: z.object({ matchupIds: ids.min(1), supportIds: ids.min(1), body: prose }).strict(),
	quote: z.object({ messageId: z.string().min(1), supportIds: ids.min(1), body: prose }).strict().nullable(),
	stories: z.array(z.object({ headline: prose, body: prose, supportIds: ids.min(1) }).strict()),
}).strict();
export type EditorialDraft = z.infer<typeof editorialDraftSchema>;

export interface EditorialSource {
	id: string;
	kind: 'scope' | 'matchup' | 'score' | 'player-score' | 'standing' | 'movement' | 'lineup' | 'transaction' | 'acquisition' | 'chat' | 'nfl';
	rosterIds: number[];
	path: string;
	retrievedAtUtc: string | null;
	data: unknown;
}
export interface EditorialCatalog {
	evidenceId: string;
	managers: Array<{ rosterId: number; displayName: string }>;
	players: Array<{ id: string; name: string; position: string; team: string | null }>;
	sources: EditorialSource[];
	facts: Array<{ id: string; sourceId: string; value: number }>;
	gaps: RecapEvidencePacket['gaps'];
	limitations: string[];
}
export interface EditorialIssue { path: string; code: string }
export interface EditorialCandidate {
	version: typeof EDITORIAL_VERSION;
	evidenceId: string;
	id: string;
	draft: EditorialDraft;
	parts: string[];
}
export type EditorialCandidateResult
	= | { status: 'candidate'; candidate: EditorialCandidate }
		| { status: 'invalid'; issues: EditorialIssue[] };

/** Packet-local IDs never grant authority. NFL values stay in their own source/scoring namespace. */
export function buildEditorialCatalog(packet: RecapEvidencePacket): EditorialCatalog {
	const catalog: EditorialCatalog = {
		evidenceId: packet.id,
		managers: packet.managers.map(({ rosterId, displayName }) => ({ rosterId, displayName })),
		players: packet.players.details.map(({ id, name, position, team }) => ({ id, name, position, team })),
		sources: [],
		facts: [],
		gaps: structuredClone(packet.gaps),
		limitations: [...packet.limitations],
	};
	function add(source: EditorialSource, numbers: Record<string, number | null | undefined> = {}) {
		catalog.sources.push(structuredClone(source));
		for (const [field, value] of Object.entries(numbers)) {
			if (typeof value === 'number' && Number.isFinite(value))
				catalog.facts.push({ id: `${source.id}:${field}`, sourceId: source.id, value });
		}
	}
	const observed = (source: string) => packet.observations.find(row => row.source === source)?.retrievedAtUtc ?? null;
	add({
		id: 'scope',
		kind: 'scope',
		rosterIds: [],
		path: 'scope',
		retrievedAtUtc: packet.frozenAtUtc,
		data: { season: packet.scope.season, week: packet.scope.week, chatWindow: packet.scope.chatWindow },
	}, { week: packet.scope.week });
	packet.facts?.results.forEach((result, index) => {
		const pair = [result.a.rosterId, result.b.rosterId].sort((a, b) => a - b);
		add({
			id: `match:${packet.scope.season}:${packet.scope.week}:${pair.join(':')}`,
			kind: 'matchup',
			rosterIds: pair,
			path: `facts.results.${index}`,
			retrievedAtUtc: observed(`scores-${packet.scope.week}`),
			data: {
				a: result.a.rosterId,
				b: result.b.rosterId,
				aPoints: result.aPoints,
				bPoints: result.bPoints,
				margin: result.margin,
				winner: result.winner?.rosterId ?? null,
			},
		}, { aPoints: result.aPoints, bPoints: result.bPoints, margin: result.margin });
	});
	packet.scores.forEach((snapshot, weekIndex) => {
		// A failed historical calculation does not admit its raw rows as verified history.
		if (snapshot.week !== packet.scope.week && packet.facts?.standings == null)
			return;
		snapshot.rows.forEach((row, rowIndex) => {
			const path = `scores.${weekIndex}.rows.${rowIndex}`;
			add({
				id: `score:${snapshot.week}:${row.rosterId}`,
				kind: 'score',
				rosterIds: [row.rosterId],
				path,
				retrievedAtUtc: snapshot.retrievedAtUtc,
				data: { week: snapshot.week, matchupId: row.matchupId, points: row.points, unit: 'Sleeper points' },
			}, { points: row.points });
			for (const [playerId, points] of Object.entries(row.playerPoints)) {
				add({
					id: `player-score:${snapshot.week}:${row.rosterId}:${playerId}`,
					kind: 'player-score',
					rosterIds: [row.rosterId],
					path: `${path}.playerPoints`,
					retrievedAtUtc: snapshot.retrievedAtUtc,
					data: {
						week: snapshot.week,
						playerId,
						started: row.starters.length ? row.starters.includes(playerId) : null,
						unit: 'Sleeper points',
					},
				}, { points });
			}
		});
	});
	packet.facts?.standings?.forEach((row, index) => {
		const numbers = { rank: row.rank, wins: row.wins, losses: row.losses, ties: row.ties, pointsFor: row.pointsFor };
		add({
			id: `standing:${row.team.rosterId}`,
			kind: 'standing',
			rosterIds: [row.team.rosterId],
			path: `facts.standings.${index}`,
			retrievedAtUtc: null,
			data: { ...numbers, pointsUnit: 'Sleeper points' },
		}, numbers);
	});
	packet.facts?.movement.forEach((row, index) => add({
		id: `movement:${row.team.rosterId}`,
		kind: 'movement',
		rosterIds: [row.team.rosterId],
		path: `facts.movement.${index}`,
		retrievedAtUtc: null,
		data: { fromRank: row.fromRank, toRank: row.toRank },
	}, { fromRank: row.fromRank, toRank: row.toRank }));
	packet.lineups.forEach((row, index) => add({
		id: `lineup:${index}`,
		kind: 'lineup',
		rosterIds: [row.rosterId],
		path: `lineups.${index}`,
		retrievedAtUtc: observed(`scores-${packet.scope.week}`),
		data: row,
	}, { points: row.points }));
	packet.transactions.completed.forEach((row, index) => {
		const numbers: Record<string, number | null> = { waiverBid: row.waiverBid };
		row.draftPicks.forEach((pick, i) => {
			numbers[`pick.${i}.round`] = pick.round;
			numbers[`pick.${i}.season`] = Number(pick.season);
		});
		row.faabTransfers.forEach((transfer, i) => {
			numbers[`faab.${i}.amount`] = transfer.amount;
		});
		add({
			id: `transaction:${index}`,
			kind: 'transaction',
			rosterIds: row.rosterIds,
			path: `transactions.completed.${index}`,
			retrievedAtUtc: packet.transactions.retrievedAtUtc,
			data: row,
		}, numbers);
	});
	packet.acquisitions.forEach((row, index) => add({
		id: `acquisition:${index}`,
		kind: 'acquisition',
		rosterIds: [row.rosterId],
		path: `acquisitions.${index}`,
		retrievedAtUtc: packet.transactions.retrievedAtUtc,
		data: row,
	}, { leaguePoints: row.leaguePoints }));
	packet.chat?.sources.forEach((row, index) => add({
		id: `chat:${row.id}`,
		kind: 'chat',
		rosterIds: [row.rosterId],
		path: `chat.sources.${index}`,
		retrievedAtUtc: observed('chat'),
		data: row,
	}));
	packet.nfl.forEach((source, i) => source.findings.forEach((finding, j) => {
		const record = finding.record;
		const subjects = packet.scores.find(snapshot => snapshot.week === packet.scope.week)?.rows.filter(row => finding.playerId !== null && row.players.includes(finding.playerId)).map(row => row.rosterId) ?? [];
		const numbers = record.kind === 'weekly-result'
			? {
					projectedPoints: record.projectedPoints,
					actualPoints: record.actualPoints,
					...Object.fromEntries(Object.entries(record.actualStats).map(([key, value]) => [`actualStats.${key}`, value])),
				}
			: {};
		add({
			id: `nfl:${i}:${j}`,
			kind: 'nfl',
			rosterIds: subjects,
			path: `nfl.${i}.findings.${j}`,
			retrievedAtUtc: source.source?.retrievedAtUtc ?? null,
			data: { input: source.input, status: source.status, source: source.source, gaps: source.gaps, ...finding },
		}, numbers);
	}));
	return catalog;
}

function freeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Deterministic gate only: a candidate still requires grounding, fairness and privacy review. */
export function buildEditorialCandidate(packet: RecapEvidencePacket, raw: unknown): EditorialCandidateResult {
	const issues: EditorialIssue[] = [];
	const issue = (path: string, code: string) => issues.push({ path, code });
	if (!packet.admission.canDraft || packet.status === 'blocked' || !packet.facts
		|| !packet.chat || !['complete', 'empty'].includes(packet.chat.status)) {
		return { status: 'invalid', issues: [{ path: '', code: 'evidence_not_admitted' }] };
	}
	const parsed = editorialDraftSchema.safeParse(raw);
	if (!parsed.success)
		return { status: 'invalid', issues: [{ path: '', code: 'invalid_draft_shape' }] };
	const draft = parsed.data;
	if (draft.evidenceId !== packet.id)
		issue('evidenceId', 'evidence_mismatch');
	const catalog = buildEditorialCatalog(packet);
	const sources = new Map(catalog.sources.map(source => [source.id, source]));
	const facts = new Map(catalog.facts.map(fact => [fact.id, fact]));
	const managers = new Map(catalog.managers.map(manager => [String(manager.rosterId), manager.displayName]));
	const players = new Map(catalog.players.map(player => [player.id, player.name]));
	const authored = new Set<string>();

	function supports(ids: string[], path: string): EditorialSource[] {
		if (new Set(ids).size !== ids.length)
			issue(path, 'duplicate_support');
		return ids.flatMap((id) => {
			const source = sources.get(id);
			if (!source)
				issue(path, 'unknown_support');
			return source ? [source] : [];
		});
	}
	function text(value: string, supportIds: string[], path: string): string {
		let cursor = 0;
		let rendered = '';
		const plain = (part: string) => {
			if (/[{}]/u.test(part))
				issue(path, 'malformed_reference');
			if (/\p{N}/u.test(part))
				issue(path, 'unreferenced_number');
			return part;
		};
		for (const match of value.matchAll(/\{(manager|player|fact):([^{}\n]+)\}/gu)) {
			rendered += plain(value.slice(cursor, match.index));
			const [, kind, id] = match;
			const fact = kind === 'fact' ? facts.get(id) : undefined;
			const replacement = kind === 'manager' ? managers.get(id) : kind === 'player' ? players.get(id) : fact?.value.toString();
			if (replacement === undefined)
				issue(path, 'unknown_reference');
			if (fact && !supportIds.includes(fact.sourceId))
				issue(path, 'uncited_numeric_source');
			const end = match.index! + match[0].length;
			const before = value.slice(Math.max(0, match.index! - 2), match.index).normalize('NFKC');
			const after = value.slice(end, end + 2);
			// A fact is one value, not digits the writer can concatenate, scale or negate.
			if (fact && (/[\p{L}\p{N}\p{M}\p{Default_Ignorable_Code_Point}_.,+\-−}]$/u.test(before)
				|| /^[\p{L}\p{N}\p{M}\p{Default_Ignorable_Code_Point}_{]/u.test(after))) {
				issue(path, 'modified_numeric_reference');
			}
			rendered += replacement ?? '';
			cursor = end;
		}
		rendered += plain(value.slice(cursor));
		const key = rendered.replace(/\s+/gu, ' ').trim().toLowerCase();
		if (authored.has(key))
			issue(path, 'repeated_content');
		authored.add(key);
		return rendered;
	}
	function awardBlock(selection: EditorialDraft['manager'], path: 'manager' | 'loser', heading: string): string {
		const support = supports(selection.supportIds, `${path}.supportIds`);
		if (new Set(selection.rosterIds).size !== selection.rosterIds.length)
			issue(`${path}.rosterIds`, 'duplicate_selection');
		for (const id of selection.rosterIds) {
			if (!managers.has(String(id)))
				issue(`${path}.rosterIds`, 'unknown_manager');
			const performance = support.some(source => source.rosterIds.includes(id)
				&& (source.kind === 'matchup' || (source.kind === 'score'
					&& source.id === `score:${packet.scope.week}:${id}` && facts.has(`${source.id}:points`))));
			if (!performance)
				issue(`${path}.supportIds`, 'unsupported_award_subject');
		}
		// Evidence v1 has transaction chronology, not verified pregame decision quality.
		if (selection.basis === 'management')
			issue(`${path}.basis`, 'management_evidence_unavailable');
		const names = selection.rosterIds.map(id => managers.get(String(id))).join(' & ');
		return `${heading}: ${names}\nBasis: weekly performance.\n\n${text(selection.body, selection.supportIds, `${path}.body`)}`;
	}
	const blocks = new Map([
		['manager', `Awards\n\n${awardBlock(draft.manager, 'manager', 'Manager of the Week')}`],
		['loser', awardBlock(draft.loser, 'loser', 'Loser of the Week')],
	]);
	const matchSupport = supports(draft.match.supportIds, 'match.supportIds');
	if (new Set(draft.match.matchupIds).size !== draft.match.matchupIds.length)
		issue('match.matchupIds', 'duplicate_selection');
	const matches = draft.match.matchupIds.flatMap((id) => {
		const source = sources.get(id);
		if (source?.kind !== 'matchup' || !matchSupport.some(support => support.id === id)) {
			issue('match.matchupIds', 'unsupported_matchup');
			return [];
		}
		const result = packet.facts!.results.find(row => source.rosterIds.includes(row.a.rosterId)
			&& source.rosterIds.includes(row.b.rosterId))!;
		const score = `${result.a.displayName} ${result.aPoints} vs. ${result.b.displayName} ${result.bPoints}`;
		return [`${score} (${result.winner ? `margin ${result.margin}` : 'tie'})`];
	});
	blocks.set('match', `Match of the Week: ${matches.join('; ')}\n\n${text(draft.match.body, draft.match.supportIds, 'match.body')}`);
	if (draft.quote) {
		const source = resolveChatSource(packet, draft.quote.messageId);
		const support = supports(draft.quote.supportIds, 'quote.supportIds');
		if (!source || !managers.has(String(source.rosterId)) || managers.get(String(source.rosterId)) !== source.sender
			|| !support.some(item => item.id === `chat:${source.id}`)) {
			issue('quote.messageId', 'unsupported_quote');
		}
		blocks.set('quote', `Quote of the Week: ${source?.sender ?? ''}\n\n${source?.text ?? ''}\n\n${text(draft.quote.body, draft.quote.supportIds, 'quote.body')}`);
	} else {
		blocks.set('quote', 'Quote of the Week\n\nNo suitable quote earned the award this week.');
	}
	draft.stories.forEach((story, index) => {
		const path = `stories.${index}`;
		supports(story.supportIds, `${path}.supportIds`);
		if (/[\r\n]/u.test(story.headline))
			issue(`${path}.headline`, 'multiline_headline');
		blocks.set(path, `${index === 0 ? 'Stories of the Week\n\n' : ''}${text(story.headline, story.supportIds, `${path}.headline`)}\n\n${text(story.body, story.supportIds, `${path}.body`)}`);
	});
	if (draft.stories.length === 0)
		blocks.set('stories', 'Stories of the Week\n\nNo additional stories warranted a write-up.');
	if (issues.length)
		return { status: 'invalid', issues };

	const header = (part: number, total: number) => `Week ${packet.scope.week} Recap${total > 1 ? ` (${part}/${total})` : ''}\n\n`;
	const capacity = EDITORIAL_PART_MAX_LENGTH - header(EDITORIAL_MAX_PARTS, EDITORIAL_MAX_PARTS).length;
	const whole = [...blocks.values()].join('\n\n');
	let groups = [whole];
	if (header(1, 1).length + whole.length > EDITORIAL_PART_MAX_LENGTH) {
		groups = [];
		let current = '';
		for (const [path, block] of blocks) {
			if (block.length > capacity)
				return { status: 'invalid', issues: [{ path, code: 'indivisible_block_overflow' }] };
			if (current && current.length + 2 + block.length > capacity) {
				groups.push(current);
				current = '';
			}
			current = current ? `${current}\n\n${block}` : block;
		}
		groups.push(current);
	}
	if (groups.length > EDITORIAL_MAX_PARTS)
		return { status: 'invalid', issues: [{ path: '', code: 'report_parts_overflow' }] };
	const parts = groups.map((group, index) => `${header(index + 1, groups.length)}${group}`);
	const artifact: Omit<EditorialCandidate, 'id'> = { version: EDITORIAL_VERSION, evidenceId: packet.id, draft, parts };
	const id = `candidate-${createHash('sha256').update(JSON.stringify(artifact)).digest('hex')}`;
	return { status: 'candidate', candidate: freeze({ ...artifact, id }) };
}
