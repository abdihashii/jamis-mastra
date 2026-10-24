import type { MemoryStorage } from '@mastra/core/storage';
import type { ArchivedChatEvidence, ChatSource, ChatWindow } from './chat-archive';
import type { FantasyConfig } from './config';
import type { NflSourceInput } from './nfl-sources.schema';
import type { NflSourceRecord, NflSourceResult } from './nfl-sources.types';
import type { BracketGame, SleeperLeague, SleeperManager, SleeperPlayerDetails, SleeperScore, SleeperState, SleeperTransaction } from './sleeper';
import type { WeekFacts, WeekFactsInput } from './week-facts';
import { createHash } from 'node:crypto';
import { chatWindowSchema, readArchivedChat } from './chat-archive';
import { nflTeamCode } from './nfl-sources';
import {
	getLeague,
	getManagers,
	getNflState,
	getPlayerSnapshot,
	getScores,
	getTransactions,
	getWinnersBracket,
	isWeekComplete,
	withBracketRounds,
} from './sleeper';
import { buildUpcomingMatchups, buildWeekHistory, buildWeekSnapshot } from './week-facts';

const sleeperReads = {
	getLeague,
	getManagers,
	getNflState,
	getPlayerSnapshot,
	getScores,
	getTransactions,
	getWinnersBracket,
};
export interface EvidenceOptions {
	memory: Pick<MemoryStorage, 'getThreadById' | 'listMessages'> | null;
	readNfl?: (input: NflSourceInput, currentSeason: number) => Promise<NflSourceResult>;
	now?: () => Date;
	sleeper?: typeof sleeperReads;
}
export interface EvidenceGap { source: string; code: string; blocking: boolean }
export interface NflFinding {
	record: NflSourceRecord;
	playerId: string | null;
	mapping: 'gsis' | 'current-name-team-position' | 'team-context-only';
}
export interface NflEvidence {
	trust: 'untrusted-source-data';
	input: NflSourceInput;
	status: NflSourceResult['status'] | 'unavailable';
	requestId: string | null;
	catalogueRequestId: string | null;
	credits: number | null;
	quotedCredits: number | null;
	chargeIdPresent: boolean;
	adminActionUrl: string | null;
	source: NflSourceResult['source'];
	gaps: string[];
	findings: NflFinding[];
	excludedRecords: number;
}
export interface LineupEvidence {
	rosterId: number;
	playerId: string;
	slot: string | null;
	points: number | null;
	kickoffAtUtc: string | null;
	/** Current catalog eligibility is not proof that a swap was available before kickoff. */
	positionCompatibleBenchIds: string[];
	availabilityBeforeKickoff: 'unknown';
}
export interface AcquisitionEvidence {
	transactionId: string;
	rosterId: number;
	playerId: string;
	started: boolean | null;
	leaguePoints: number | null;
	statusUpdatedAtUtc: string | null;
	kickoffAtUtc: string | null;
	/** A later status update does not prove that completion itself happened after kickoff. */
	knownCompleteBeforeKickoff: true | null;
	decisionQuality: 'not-established';
}
export interface RecapEvidencePacket {
	id: string;
	version: 'fantasy-evidence-v1';
	collectionStartedAtUtc: string;
	frozenAtUtc: string;
	scope: { leagueId: string; groupId: string; season: string | null; week: number; chatWindow: ChatWindow | null };
	status: 'ready' | 'partial' | 'blocked';
	/** Evidence admission only, never publication authority or editorial/privacy approval. */
	admission: { canDraft: boolean; blockers: string[] };
	league: SleeperLeague | null;
	state: SleeperState | null;
	bracket: BracketGame[];
	managers: SleeperManager[];
	facts: WeekFacts | null;
	scores: Array<{ week: number; retrievedAtUtc: string; rows: SleeperScore[] }>;
	players: { retrievedAtUtc: string | null; details: SleeperPlayerDetails[]; missingIds: string[] };
	transactions: { retrievedAtUtc: string | null; completed: SleeperTransaction[]; excludedNonComplete: number };
	chat: ArchivedChatEvidence | null;
	nfl: NflEvidence[];
	lineups: LineupEvidence[];
	acquisitions: AcquisitionEvidence[];
	observations: Array<{ source: string; retrievedAtUtc: string; available: boolean }>;
	gaps: EvidenceGap[];
	limitations: string[];
}

function freeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

function freezePacket(packet: RecapEvidencePacket): RecapEvidencePacket {
	packet.admission.blockers = [...new Set(packet.gaps.filter(gap => gap.blocking).map(gap => `${gap.source}:${gap.code}`))];
	packet.admission.canDraft = packet.facts !== null && packet.admission.blockers.length === 0;
	packet.status = !packet.admission.canDraft ? 'blocked' : packet.gaps.length > 0 ? 'partial' : 'ready';
	// Clone before freezing so neither caller-owned fixtures nor cached source records become frozen.
	const copy = structuredClone(packet);
	copy.id = `evidence-${createHash('sha256').update(JSON.stringify(copy)).digest('hex')}`;
	return freeze(copy);
}

function sameName(a: string, b: string): boolean {
	return a.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
		=== b.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function mapFinding(record: NflSourceRecord, players: SleeperPlayerDetails[]): NflFinding | null {
	if (record.kind === 'news-summary')
		return { record, playerId: null, mapping: 'team-context-only' };
	if (record.kind === 'injury' && record.gsisId) {
		const matches = players.filter(player => player.gsisId === record.gsisId);
		if (matches.length === 1)
			return { record, playerId: matches[0].id, mapping: 'gsis' };
		if (matches.length > 1)
			return null;
	}
	const team = nflTeamCode(record.kind === 'injury' ? record.team : record.teamName);
	if (!team)
		return null;
	const matches = players.filter(player => sameName(player.name, record.name)
		&& nflTeamCode(player.team) === team && (player.position === 'DEF' ? 'DST' : player.position) === record.position
		&& !(record.kind === 'injury' && record.gsisId && player.gsisId && record.gsisId !== player.gsisId));
	return matches.length === 1 ? { record, playerId: matches[0].id, mapping: 'current-name-team-position' } : null;
}

function nflSourceInputs(facts: WeekFacts, players: SleeperPlayerDetails[], league: SleeperLeague): NflSourceInput[] {
	const candidateIds = facts.playerStoryCandidates.flatMap(candidate => candidate.kind === 'top-starter'
		? [candidate.player.id]
		: [candidate.startedPlayer.id, candidate.benchedPlayer.id]);
	const player = candidateIds.map(id => players.find(p => p.id === id)).find(p => p && nflTeamCode(p.team));
	const team = player ? nflTeamCode(player.team) : null;
	if (!team || !player)
		return [];
	const inputs: NflSourceInput[] = [
		{ operation: 'injuries', season: Number(league.season), week: facts.week, team },
		{ operation: 'news', team },
	];
	const rec = league.scoringSettings?.rec;
	const scoring = rec === 1 ? 'PPR' : rec === 0.5 ? 'HALF' : rec === 0 ? 'STD' : null;
	const position = player.position === 'DEF' ? 'DST' : player.position;
	if (scoring && ['QB', 'RB', 'WR', 'TE', 'K', 'DST'].includes(position)) {
		inputs.splice(1, 0, {
			operation: 'weekly-results',
			season: Number(league.season),
			week: facts.week,
			position: position as 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DST',
			scoring,
		});
	}
	return inputs;
}

const flexPositions: Record<string, string[]> = {
	FLEX: ['RB', 'WR', 'TE'],
	SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
	REC_FLEX: ['WR', 'TE'],
	WRRB_FLEX: ['WR', 'RB'],
	IDP_FLEX: ['DL', 'LB', 'DB'],
};
function lineupsFor(packet: RecapEvidencePacket, scores: SleeperScore[]): LineupEvidence[] {
	const slots = packet.league!.rosterPositions.filter(slot => !['BN', 'IR', 'TAXI'].includes(slot));
	const players = new Map(packet.players.details.map(player => [player.id, player]));
	return scores.flatMap(score => score.starters.flatMap((id, index): LineupEvidence[] => {
		if (id === '0')
			return [];
		const slot = slots.length === score.starters.length ? slots[index] : null;
		const positions = slot ? flexPositions[slot] ?? [slot] : [];
		const compatible = score.players.filter(benchId => !score.starters.includes(benchId)
			&& players.get(benchId)?.fantasyPositions.some(position => positions.includes(position)));
		const result = packet.nfl.flatMap(source => source.findings).find(finding => finding.playerId === id
			&& finding.record.kind === 'weekly-result');
		const record = result?.record.kind === 'weekly-result' ? result.record : null;
		const window = packet.scope.chatWindow;
		const kickoff = record?.status === 'final' && record.kickoffAtUtc && window
			&& record.kickoffAtUtc >= window.startAtUtc && record.kickoffAtUtc < window.endAtUtc
			&& record.kickoffAtUtc <= packet.frozenAtUtc
			? record.kickoffAtUtc
			: null;
		if (record && !kickoff)
			packet.gaps.push({ source: 'nfl', code: 'kickoff_unverified', blocking: false });
		return [{
			rosterId: score.rosterId,
			playerId: id,
			slot,
			points: score.playerPoints[id] ?? null,
			kickoffAtUtc: kickoff,
			positionCompatibleBenchIds: compatible,
			availabilityBeforeKickoff: 'unknown',
		}];
	}));
}

function acquisitionsFor(packet: RecapEvidencePacket, scores: SleeperScore[]): AcquisitionEvidence[] {
	return packet.transactions.completed.flatMap(transaction => transaction.adds.map((add) => {
		const score = scores.find(row => row.rosterId === add.rosterId);
		const lineup = packet.lineups.find(row => row.rosterId === add.rosterId && row.playerId === add.playerId);
		const completed = transaction.statusUpdatedAtUtc;
		const created = transaction.createdAtUtc;
		const validTime = completed !== null && (created === null || created <= completed)
			&& completed <= packet.frozenAtUtc && Number(completed.slice(0, 4)) >= Number(packet.scope.season) - 1;
		return {
			transactionId: transaction.id,
			...add,
			// Empty arrays may represent a null upstream lineup, not a verified bench decision.
			started: score && score.starters.length > 0 ? score.starters.includes(add.playerId) : null,
			leaguePoints: score?.playerPoints[add.playerId] ?? null,
			statusUpdatedAtUtc: completed,
			kickoffAtUtc: lineup?.kickoffAtUtc ?? null,
			knownCompleteBeforeKickoff: validTime && lineup?.kickoffAtUtc && completed! < lineup.kickoffAtUtc ? true : null,
			decisionQuality: 'not-established' as const,
		};
	}));
}

/** One collector for candidate previews and the future claimed scheduled path. No persistence, models or sends. */
export async function collectRecapEvidence(
	request: { config: FantasyConfig; week: number; window: ChatWindow | null },
	options: EvidenceOptions,
): Promise<RecapEvidencePacket> {
	const config = structuredClone(request.config);
	const { week } = request;
	const now = options.now ?? (() => new Date());
	const startedAt = now().toISOString();
	const packet: RecapEvidencePacket = {
		id: '',
		version: 'fantasy-evidence-v1',
		collectionStartedAtUtc: startedAt,
		frozenAtUtc: startedAt,
		scope: { leagueId: config.sleeperLeagueId, groupId: config.sendblueGroupId, season: null, week, chatWindow: null },
		status: 'blocked',
		admission: { canDraft: false, blockers: [] },
		league: null,
		state: null,
		bracket: [],
		managers: [],
		facts: null,
		scores: [],
		players: { retrievedAtUtc: null, details: [], missingIds: [] },
		transactions: { retrievedAtUtc: null, completed: [], excludedNonComplete: 0 },
		chat: null,
		nfl: [],
		lineups: [],
		acquisitions: [],
		observations: [],
		gaps: [],
		limitations: [
			'Archive coverage describes stored messages within the caller-supplied UTC window, not the entire iMessage conversation.',
			'All chat sources require contextual privacy/relevance review before any quote can be published.',
			'Lineups and bench comparisons are retrospective; current catalog eligibility does not establish pre-kickoff availability.',
			'No immutable pre-kickoff projection/injury or lineup snapshot is available; withhold claims that require it.',
			'Provider-preset projections/actuals are not Sleeper league points; source licensing remains unknown.',
		],
	};
	function finish(value: RecapEvidencePacket) {
		value.frozenAtUtc = now().toISOString();
		return freezePacket(value);
	}
	const gap = (source: string, code: string, blocking = false) => packet.gaps.push({ source, code, blocking });
	const window = chatWindowSchema.safeParse(request.window);
	if (!Number.isSafeInteger(week) || week < 1 || week > 22 || !window.success || window.data.endAtUtc > startedAt) {
		gap('scope', 'invalid_or_unclosed_evidence_window', true);
		return finish(packet);
	}
	packet.scope.chatWindow = window.data;
	const source = options.sleeper ?? sleeperReads;
	const deadline = () => AbortSignal.timeout(20_000);
	async function read<T>(name: string, operation: () => Promise<T>): Promise<T | null> {
		try {
			const data = structuredClone(await operation());
			packet.observations.push({ source: name, retrievedAtUtc: now().toISOString(), available: true });
			return data;
		} catch {
			packet.observations.push({ source: name, retrievedAtUtc: now().toISOString(), available: false });
			return null;
		}
	}
	const [state, rawLeague, managers, bracket] = await Promise.all([
		read('state', () => source.getNflState(deadline())),
		read('league', () => source.getLeague(config.sleeperLeagueId, deadline())),
		read('managers', () => source.getManagers(config.sleeperLeagueId, deadline())),
		read('bracket', () => source.getWinnersBracket(config.sleeperLeagueId, deadline())),
	]);
	if (!state || !rawLeague || !managers || !bracket) {
		gap('league', 'essential_sources_unavailable', true);
		return finish(packet);
	}
	if (rawLeague.id !== config.sleeperLeagueId || !/^\d{4}$/.test(rawLeague.season) || !/^\d{4}$/.test(state.season)
		|| !Number.isSafeInteger(state.week) || managers.length !== rawLeague.totalRosters
		|| new Set(managers.map(manager => manager.rosterId)).size !== managers.length
		|| new Set(managers.map(manager => manager.userId)).size !== managers.length
		|| Number(window.data.startAtUtc.slice(0, 4)) < Number(rawLeague.season)
		|| Number(window.data.endAtUtc.slice(0, 4)) > Number(rawLeague.season) + 1) {
		gap('league', 'scope_or_identity_invalid', true);
		return finish(packet);
	}
	const league = withBracketRounds(rawLeague, bracket);
	packet.league = league;
	packet.state = state;
	packet.bracket = bracket;
	packet.managers = managers;
	packet.scope.season = league.season;
	if ((state.season === league.season && !['regular', 'post'].includes(state.seasonType))
		|| !isWeekComplete(week, state, league, bracket)) {
		gap('league', 'week_not_complete', true);
		return finish(packet);
	}
	const historyWeeks = week < league.playoffWeekStart ? Array.from({ length: week }, (_, index) => index + 1) : [week];
	const scoresByWeek = new Map<number, SleeperScore[]>();
	await Promise.all(historyWeeks.map(async (w) => {
		const rows = await read(`scores-${w}`, () => source.getScores(league.id, w, deadline()));
		if (rows) {
			scoresByWeek.set(w, rows);
			packet.scores.push({
				week: w,
				rows,
				retrievedAtUtc: packet.observations.find(item => item.source === `scores-${w}`)!.retrievedAtUtc,
			});
		}
	}));
	packet.scores.sort((a, b) => a.week - b.week);
	const current = scoresByWeek.get(week);
	const knownRosters = new Set(managers.map(manager => manager.rosterId));
	if (!current || new Set(current.map(row => row.rosterId)).size !== current.length
		|| current.some(row => !knownRosters.has(row.rosterId)
			|| (row.points !== null && !Number.isFinite(row.points))
			|| Object.values(row.playerPoints).some(points => !Number.isFinite(points)))
		|| (week < league.playoffWeekStart && current.length !== managers.length)) {
		gap('league', 'current_results_unavailable_or_invalid', true);
		return finish(packet);
	}
	const next = week + 1 < league.playoffWeekStart
		? await read('upcoming', () => source.getScores(league.id, week + 1, deadline()))
		: undefined;
	if (next === null)
		gap('league', 'upcoming_unavailable');
	const transactions = await read('transactions', () => source.getTransactions(league.id, week, deadline()));
	if (transactions) {
		packet.transactions.retrievedAtUtc = transactions.retrievedAtUtc;
		packet.transactions.excludedNonComplete = transactions.transactions.filter(t => t.status !== 'complete').length;
		packet.transactions.completed = transactions.transactions.filter(t => t.status === 'complete' && t.week === week
			&& [...t.rosterIds, ...t.draftPicks.flatMap(pick => [pick.rosterId, pick.previousOwnerId, pick.ownerId]), ...t.faabTransfers.flatMap(transfer => [transfer.sender, transfer.receiver])].every(id => knownRosters.has(id)));
		if (transactions.malformedCount
			|| packet.transactions.completed.length + packet.transactions.excludedNonComplete !== transactions.transactions.length) {
			gap('transactions', 'partial_transaction_history');
		}
		if (packet.transactions.completed.some(t => !t.createdAtUtc || !t.statusUpdatedAtUtc
			|| t.createdAtUtc > t.statusUpdatedAtUtc || t.statusUpdatedAtUtc > now().toISOString()
			|| Number(t.statusUpdatedAtUtc.slice(0, 4)) < Number(league.season) - 1)) {
			gap('transactions', 'transaction_time_unverified');
		}
	} else {
		gap('transactions', 'transaction_history_unavailable');
	}
	const playerIds = [...new Set([
		...current.flatMap(row => [...row.players, ...row.starters]),
		...packet.transactions.completed.flatMap(t => [...t.adds, ...t.drops].map(item => item.playerId)),
	])].filter(id => id !== '0');
	const players = await read('players', () => source.getPlayerSnapshot(playerIds, deadline()));
	if (players) {
		packet.players = {
			retrievedAtUtc: players.retrievedAtUtc,
			details: players.players,
			missingIds: players.missingIds,
		};
		if (players.missingIds.length)
			gap('players', 'player_details_missing');
	} else {
		gap('players', 'player_catalogue_unavailable');
	}
	const input: WeekFactsInput = {
		league,
		week,
		managers,
		bracket,
		scoresByWeek,
		nextWeekScores: next ?? undefined,
		players: packet.players.details.map(({ id, name, position }) => ({ id, name, position })),
	};
	try {
		const snapshot = buildWeekSnapshot(input);
		packet.facts = { ...snapshot, standings: null, movement: [], upcoming: snapshot.isChampionshipWeek ? null : [] };
	} catch {
		gap('league', 'current_results_invalid', true);
		return finish(packet);
	}
	try {
		packet.facts.upcoming = buildUpcomingMatchups(input);
	} catch {
		gap('league', 'upcoming_invalid');
	}
	if (week < league.playoffWeekStart) {
		const completeHistory = historyWeeks.every((w) => {
			const rows = scoresByWeek.get(w);
			return rows && rows.length === managers.length && new Set(rows.map(row => row.rosterId)).size === rows.length
				&& rows.every(row => knownRosters.has(row.rosterId) && row.points !== null && Number.isFinite(row.points));
		});
		if (completeHistory) {
			try {
				Object.assign(packet.facts, buildWeekHistory(input));
			} catch {
				gap('league', 'standings_history_invalid');
			}
		} else {
			gap('league', 'standings_history_unavailable');
		}
	}
	packet.chat = await readArchivedChat(options.memory, config, managers, window.data, now());
	if (!['complete', 'empty'].includes(packet.chat.status))
		gap('chat', `archive_${packet.chat.status}`, true);
	if (!packet.gaps.some(item => item.blocking)) {
		if (!options.readNfl) {
			gap('nfl', 'research_not_requested');
		} else if (state.season !== league.season) {
			gap('nfl', 'historical_context_unavailable');
		} else {
			const inputs = nflSourceInputs(packet.facts, packet.players.details, league);
			if (inputs.length === 0)
				gap('nfl', 'public_player_mapping_unavailable');
			else if (!inputs.some(item => item.operation === 'weekly-results'))
				gap('nfl', 'projection_preset_unavailable');
			const rosterIds = new Set(current.flatMap(row => row.players));
			const rosteredPlayers = packet.players.details.filter(player => rosterIds.has(player.id));
			for (const query of inputs) {
				const result = await read(`nfl-${query.operation}`, () => options.readNfl!(query, Number(state.season)));
				const mapped = result?.records.flatMap((record) => {
					const finding = mapFinding(record, rosteredPlayers);
					return finding ? [finding] : [];
				}) ?? [];
				const findings = mapped.filter(finding => finding.playerId === null
					|| mapped.filter(other => other.playerId === finding.playerId).length === 1);
				if (findings.length !== mapped.length)
					gap('nfl', 'ambiguous_player_mapping');
				if (query.operation !== 'news' && result?.records.length && findings.length === 0)
					gap('nfl', 'source_player_mapping_unavailable');
				packet.nfl.push({
					trust: 'untrusted-source-data',
					input: query,
					status: result?.status ?? 'unavailable',
					requestId: result?.requestId ?? null,
					catalogueRequestId: result?.catalogueRequestId ?? null,
					credits: result?.credits ?? null,
					quotedCredits: result?.quotedCredits ?? null,
					chargeIdPresent: result?.chargeIdPresent ?? false,
					adminActionUrl: result?.adminActionUrl ?? null,
					source: result?.source ?? null,
					gaps: result?.gaps ?? [],
					findings,
					excludedRecords: (result?.records.length ?? 0) - findings.length,
				});
				if (!result || !['success', 'empty'].includes(result.status))
					gap('nfl', `source_${result?.status ?? 'unavailable'}`);
				if (!result || (result.chargeIdPresent && result.credits === null)
					|| ['unknown_outcome', 'invalid_response', 'terms_required', 'access_denied'].includes(result.status)) {
					break;
				}
			}
		}
	}
	packet.frozenAtUtc = now().toISOString();
	packet.lineups = lineupsFor(packet, current);
	packet.acquisitions = acquisitionsFor(packet, current);
	if (packet.acquisitions.some(acquisition => acquisition.started === null))
		gap('lineups', 'acquisition_lineup_unavailable');
	return finish(packet);
}

/** Exact source resolution only; callers still need both publication validation gates. */
export function resolveChatSource(packet: RecapEvidencePacket, id: string): ChatSource | null {
	return packet.chat?.sources.find(source => source.id === id) ?? null;
}
