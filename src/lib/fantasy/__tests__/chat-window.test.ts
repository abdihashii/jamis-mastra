import type { SleeperScheduleSnapshot } from '../sleeper';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readReportingWindow } from '../chat-window';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/nfl-calendar.fixture.json', import.meta.url), 'utf8'));
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => fetchSpy?.mockRestore());

describe('shared queried reporting-window loader', () => {
	test.each(['week6', 'delayed', 'transition', 'wildcard'])('loads the requested Sleeper phase and queried calendar: %s', async (name) => {
		const fixture = fixtures[name];
		const type = fixture.sleeper.phase === 'regular' ? 2 : 3;
		const regular = Number(fixture.sleeper.season) >= 2021 ? 18 : 17;
		const week = type === 2 ? fixture.week : regular + fixture.week;
		const calls: unknown[] = [];
		const schedule = async (season: string, phase: 'regular' | 'post', signal?: AbortSignal): Promise<SleeperScheduleSnapshot> => {
			calls.push({ season, phase });
			expect(signal).toBeInstanceOf(AbortSignal);
			return structuredClone(fixture.sleeper);
		};
		fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (url: RequestInfo | URL) => {
			const value = String(url);
			return Response.json(value.includes('/scoreboard?') ? fixture.scoreboard : value.includes(`/types/${fixture.current.$ref.includes('/types/2/') ? 2 : 3}/weeks/${fixture.current.number}?`) ? fixture.current : fixture.next);
		}, { preconnect: () => {} }));
		const first = await readReportingWindow(fixture.sleeper.season, week, new Date('2026-10-22T12:00:00Z'), undefined, schedule);
		const later = await readReportingWindow(fixture.sleeper.season, week, new Date('2026-10-24T18:00:00Z'), undefined, schedule);
		expect(first.status).toBe('ready');
		expect(later.status).toBe('ready');
		if (first.status !== 'ready' || later.status !== 'ready')
			throw new Error('Queried fixture required');
		expect(first.window).toEqual(later.window);
		expect(first.window).toEqual({ startAtUtc: new Date(fixture.current.startDate).toISOString(), endAtUtc: new Date(fixture.next.startDate).toISOString() });
		expect(calls).toEqual([{ season: fixture.sleeper.season, phase: fixture.sleeper.phase }, { season: fixture.sleeper.season, phase: fixture.sleeper.phase }]);
		expect(fetchSpy).toHaveBeenCalledTimes(6);
	});
	test('invalid or canceled scope never reads a schedule or falls back to collection time', async () => {
		let calls = 0;
		const source = async () => {
			calls++;
			throw new Error('PRIVATE_SOURCE');
		};
		const controller = new AbortController();
		controller.abort();
		expect(await readReportingWindow('2026', 6, new Date(), controller.signal, source)).toEqual({ status: 'blocked', reason: 'calendar_read_canceled' });
		for (const week of [0, 23, Number.NaN, 1.5])
			expect(await readReportingWindow('2026', week, new Date(), undefined, source)).toEqual({ status: 'blocked', reason: 'calendar_scope_invalid' });
		expect(calls).toBe(0);
	});
	test('source failures and wrong schedule scope stay safe and blocked', async () => {
		expect(await readReportingWindow('2026', 6, new Date(), undefined, async () => {
			throw new Error('PRIVATE_SOURCE');
		})).toEqual({ status: 'blocked', reason: 'calendar_source_unavailable' });
		expect(await readReportingWindow('2026', 6, new Date(), undefined, async () => ({ ...fixtures.week6.sleeper, season: '2025' }))).toEqual({ status: 'blocked', reason: 'calendar_scope_invalid' });
	});
});
