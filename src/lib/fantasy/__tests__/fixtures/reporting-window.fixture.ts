import type { ChatWindow } from '../../chat-archive';
import type { NflCalendarProof, NflReportingWindow } from '../../nfl-calendar';

/** Synthetic calendar proof for owner/preview fixtures, not a replay of an actual NFL schedule. */
export function reportingWindowFixture(window: ChatWindow, season = 2026, week = 1): Extract<NflReportingWindow, { status: 'ready' }> {
	const regular = season >= 2021 ? 18 : 17;
	const type = week <= regular ? 2 : 3;
	const local = type === 2 ? week : week - regular;
	const currentWeek = type === 3 && local === 4 ? 5 : local;
	const nextType = type === 2 && week === regular ? 3 : type;
	const nextWeek = nextType !== type ? 1 : currentWeek + 1;
	const label = (phase: number, value: number) => phase === 2 ? `Week ${value}` : ({ 1: 'Wild Card', 2: 'Divisional Round', 3: 'Conference Championship', 4: 'Pro Bowl', 5: 'Super Bowl' } as Record<number, string>)[value];
	const url = (phase: number, value: number) => `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/${phase}/weeks/${value}?lang=en&region=us`;
	const current: NflCalendarProof['current'] = {
		url: url(type, currentWeek),
		providerWeek: currentWeek,
		label: label(type, currentWeek),
		startAtUtc: window.startAtUtc,
		lastMinuteAtUtc: new Date(Date.parse(window.endAtUtc) - 60_000).toISOString(),
	};
	const next = {
		url: url(nextType, nextWeek),
		providerWeek: nextWeek,
		label: label(nextType, nextWeek),
		startAtUtc: window.endAtUtc,
		lastMinuteAtUtc: new Date(Date.parse(window.endAtUtc) + 7 * 86_400_000 - 60_000).toISOString(),
	};
	return {
		status: 'ready',
		window: structuredClone(window),
		source: { provider: 'espn', retrievedAtUtc: new Date(Date.parse(window.endAtUtc) + 86_400_000).toISOString(), current, next, games: [{ id: '401000001', kickoffAtUtc: new Date(Date.parse(window.startAtUtc) + 86_400_000).toISOString(), home: 'NE', away: 'BUF', final: true }] },
	};
}
