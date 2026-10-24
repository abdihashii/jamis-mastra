import type { MemoryStorage } from '@mastra/core/storage';
import type { EditorialDraft } from './editorial';
import type { EvidenceOptions, RecapEvidencePacket } from './recap-evidence';
import type { SleeperScore } from './sleeper';
import { buildEditorialCatalog } from './editorial';
import { collectRecapEvidence } from './recap-evidence';
import { reportingWindowFixture } from './reporting-window.fixture';

export const editorialFixtureConfig = {
	sendblueGroupId: 'fixture-group',
	sleeperLeagueId: 'fixture-league',
	recapTimezone: 'UTC',
	managerMap: { '+15550000001': 'u1', '+15550000002': 'u2' },
};
export const editorialFixtureWindow = { startAtUtc: '2026-09-01T00:00:00.000Z', endAtUtc: '2026-09-08T00:00:00.000Z' };
export const editorialFixtureNow = () => new Date('2026-09-09T00:00:00.000Z');
export const editorialFixtureQuote = '  PRIVATE_FOOTBALL_CHAT\n\nWatch this. 🏈 e\u0301 **exact**  ';
export const editorialFixtureSleeper: NonNullable<EvidenceOptions['sleeper']> = {
	getNflState: async () => ({ season: '2026', week: 2, seasonType: 'regular' }),
	getLeague: async () => ({ id: editorialFixtureConfig.sleeperLeagueId, name: 'League', season: '2026', status: 'in_season', totalRosters: 2, playoffWeekStart: 15, playoffRounds: 1, rosterPositions: ['QB', 'BN'], scoringSettings: { rec: 0.5 } }),
	getManagers: async () => [{ rosterId: 1, userId: 'u1', displayName: 'Alpha' }, { rosterId: 2, userId: 'u2', displayName: 'Bravo' }],
	getWinnersBracket: async () => [{ matchupId: 1, round: 1, placement: 1, team1: 1, team2: 2, winner: null, loser: null, team1From: null, team2From: null }],
	getScores: async (): Promise<SleeperScore[]> => [
		{ rosterId: 1, matchupId: 1, points: 20, players: ['p1'], starters: ['p1'], playerPoints: { p1: 20 } },
		{ rosterId: 2, matchupId: 1, points: 10, players: ['p2'], starters: ['p2'], playerPoints: { p2: 10 } },
	],
	getPlayerSnapshot: async () => ({ retrievedAtUtc: editorialFixtureNow().toISOString(), missingIds: [], players: ['p1', 'p2'].map(id => ({ id, name: id, position: 'QB', team: 'NE', fantasyPositions: ['QB'], gsisId: null })) }),
	getTransactions: async () => ({ transactions: [], malformedCount: 0, retrievedAtUtc: editorialFixtureNow().toISOString() }),
};
export async function frozenEditorialFixture() {
	const threadId = `fantasy-group-${editorialFixtureConfig.sendblueGroupId}`;
	const now = editorialFixtureNow();
	const memory: Pick<MemoryStorage, 'getThreadById' | 'listMessages'> = {
		getThreadById: async () => ({ id: threadId, resourceId: threadId, createdAt: now, updatedAt: now }),
		listMessages: async () => ({ total: 1, page: 0, perPage: 1000, hasMore: false, messages: [{
			id: 'exact-source',
			threadId,
			resourceId: threadId,
			role: 'user',
			createdAt: new Date('2026-09-02T01:00:00Z'),
			content: { format: 2, parts: [{ type: 'text', text: editorialFixtureQuote }], metadata: { channel: 'sendblue', groupId: editorialFixtureConfig.sendblueGroupId, senderNumber: '+15550000001', sentAt: '2026-09-02T01:00:00Z' } },
		}] }),
	};
	return collectRecapEvidence({ config: editorialFixtureConfig, week: 1, window: editorialFixtureWindow, calendarProof: reportingWindowFixture(editorialFixtureWindow).source }, { memory, sleeper: editorialFixtureSleeper, now: editorialFixtureNow });
}
export function validEditorialDraft(packet: RecapEvidencePacket): EditorialDraft {
	const match = buildEditorialCatalog(packet).sources.find(source => source.kind === 'matchup')!.id;
	return {
		evidenceId: packet.id,
		manager: { rosterIds: [1], basis: 'performance', supportIds: ['score:1:1'], body: '{manager:1} delivered {fact:score:1:1:points} points without needing a miracle.' },
		loser: { rosterIds: [2], basis: 'performance', supportIds: ['score:1:2'], body: 'The result left little room for an argument.' },
		match: { matchupIds: [match], supportIds: [match], body: 'The contrast made the contest worth remembering.' },
		quote: { messageId: 'exact-source', supportIds: ['chat:exact-source', match], body: 'Confidence met a receptive scoreboard.' },
		stories: [],
	};
}
