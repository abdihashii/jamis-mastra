import type { NflReportingWindow } from './nfl-calendar';

import { parseNflCalendarProof, readNflReportingWindow } from './nfl-calendar';
import { getNflSchedule } from './sleeper';

/** One public-source loader for schedule/CLI previews. Neither collection time nor caller dates choose its bounds. */
export async function readReportingWindow(
	season: string,
	fantasyWeek: number,
	now: Date,
	signal?: AbortSignal,
	getSchedule: typeof getNflSchedule = getNflSchedule,
): Promise<NflReportingWindow> {
	const year = Number(season);
	const regular = year >= 2021 ? 18 : 17;
	if (!/^\d{4}$/.test(season) || year < 1920 || year > 2100 || !Number.isSafeInteger(fantasyWeek)
		|| fantasyWeek < 1 || fantasyWeek > regular + 4 || !Number.isFinite(now.getTime())) {
		return { status: 'blocked', reason: 'calendar_scope_invalid' };
	}
	if (signal?.aborted)
		return { status: 'blocked', reason: 'calendar_read_canceled' };
	const phase = fantasyWeek <= regular ? 'regular' : 'post';
	const week = phase === 'regular' ? fantasyWeek : fantasyWeek - regular;
	const deadline = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
	try {
		const snapshot = await getSchedule(season, phase, deadline);
		if (snapshot.season !== season || snapshot.phase !== phase)
			return { status: 'blocked', reason: 'calendar_scope_invalid' };
		const result = await readNflReportingWindow(snapshot, week, now, deadline);
		if (result.status === 'blocked')
			return result;
		return { ...result, source: parseNflCalendarProof(result.source, year, fantasyWeek, result.window) };
	} catch {
		return { status: 'blocked', reason: signal?.aborted ? 'calendar_read_canceled' : 'calendar_source_unavailable' };
	}
}
