import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readNflReportingWindow } from '../nfl-calendar';
import { sleeperScheduleSchema } from '../sleeper';

const captured = JSON.parse(readFileSync(new URL('./fixtures/nfl-calendar.fixture.json', import.meta.url), 'utf8'));
const now = new Date('2026-10-22T12:00:00Z');
const fixture = (name = 'week6') => structuredClone(captured[name]);
let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => fetchSpy?.mockRestore());

function routes(value = fixture()) {
	const { season, phase } = value.sleeper;
	const type = phase === 'regular' ? 2 : 3;
	const week = phase === 'post' && value.week === 4 ? 5 : value.week;
	const transition = type === 2 && value.week === (Number(season) >= 2021 ? 18 : 17);
	const calendar = (t: number, w: number) => `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/${t}/weeks/${w}?lang=en&region=us`;
	return [calendar(type, week), calendar(transition ? 3 : type, transition ? 1 : week + 1), `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=${type}&week=${week}&limit=1000`];
}
function stub(value = fixture(), respond?: (url: string, index: number) => Response | Promise<Response>) {
	const urls = routes(value);
	fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const index = urls.indexOf(url);
		expect(index).toBeGreaterThanOrEqual(0);
		expect(init).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
		if (respond)
			return respond(url, index);
		const data = [value.current, value.next, value.scoreboard][index];
		return data === null ? Response.json({ error: { message: 'no instance found' } }, { status: 404 }) : Response.json(data);
	}, { preconnect: () => { throw new Error('Unexpected preconnect'); } }));
	return urls;
}
function read(value = fixture(), at = now, signal?: AbortSignal) {
	return readNflReportingWindow(sleeperScheduleSchema.parse(value.sleeper), value.week, at, signal);
}

// These are minimal public-response projections, not invented calendar boundaries.
describe('queried NFL calendar reader (off the production path)', () => {
	test.each(['week6', 'delayed', 'transition', 'wildcard'])('replays captured calendar, scoreboard and Sleeper membership: %s', async (name) => {
		const value = fixture(name);
		const urls = stub(value);
		const result = await read(value);
		expect(result.status).toBe('ready');
		if (result.status !== 'ready')
			throw new Error(result.reason);
		expect(result.window).toEqual({ startAtUtc: new Date(value.current.startDate).toISOString(), endAtUtc: new Date(value.next.startDate).toISOString() });
		expect(result.source.provider).toBe('espn');
		expect(result.source.current.url).toBe(urls[0]);
		expect(result.source.next.url).toBe(urls[1]);
		expect(result.source.games).toHaveLength(value.scoreboard.events.length);
		expect(result.source.games.every(game => game.final)).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	test('Week 6 bounds do not advance at a later collection time', async () => {
		stub();
		const early = await read(fixture(), new Date('2026-10-21T07:00:00Z'));
		const late = await read(fixture(), new Date('2026-10-30T18:00:00Z'));
		expect(early.status).toBe('ready');
		expect(late.status).toBe('ready');
		if (early.status === 'ready' && late.status === 'ready') {
			expect(early.window).toEqual({ startAtUtc: '2026-10-14T07:00:00.000Z', endAtUtc: '2026-10-21T07:00:00.000Z' });
			expect(late.window).toEqual(early.window);
		}
	});

	test('the real delayed Wednesday game fits the extended calendar, not a hardcoded Tuesday cutoff', async () => {
		const value = fixture('delayed');
		stub(value);
		const result = await read(value);
		expect(result.status).toBe('ready');
		if (result.status === 'ready') {
			expect(result.window.endAtUtc).toBe('2020-12-03T08:00:00.000Z');
			expect(result.source.games.find(game => game.id === '401220170')?.kickoffAtUtc).toBe('2020-12-02T20:40:00.000Z');
		}
	});

	test('an incomplete provider or Sleeper game blocks even after the calendar closes', async () => {
		const value = fixture();
		value.scoreboard.events[0].status.type.completed = false;
		stub(value);
		expect(await read(value)).toMatchObject({ status: 'blocked' });
		value.scoreboard.events[0].status.type.completed = true;
		value.sleeper.games[0].status = 'postponed';
		expect(await read(value)).toMatchObject({ status: 'blocked' });
	});

	test('does not admit a still-open calendar just because games are already final', async () => {
		stub();
		expect(await read(fixture(), new Date('2026-10-21T06:59:59.999Z')))
			.toEqual({ status: 'blocked', reason: 'calendar_period_unclosed' });
	});

	test.each([
		['wrong number', (v: ReturnType<typeof fixture>) => { v.current.number = 7; }],
		['foreign season ref', (v: ReturnType<typeof fixture>) => { v.current.$ref = v.current.$ref.replace('/2026/', '/2025/'); }],
		['foreign provider ref', (v: ReturnType<typeof fixture>) => { v.current.$ref = v.current.$ref.replace('sports.core.api.espn.com', 'example.invalid'); }],
		['bad date', (v: ReturnType<typeof fixture>) => { v.current.startDate = '2026-02-30T07:00Z'; }],
		['inverted dates', (v: ReturnType<typeof fixture>) => { v.current.startDate = v.next.startDate; }],
		['unverified precision', (v: ReturnType<typeof fixture>) => { v.current.endDate = '2026-10-21T06:59:59Z'; }],
		['overlap', (v: ReturnType<typeof fixture>) => { v.current.endDate = '2026-10-21T07:00Z'; }],
		['gap', (v: ReturnType<typeof fixture>) => { v.next.startDate = '2026-10-21T08:00Z'; }],
		['wrong scoreboard season', (v: ReturnType<typeof fixture>) => { v.scoreboard.season.year = 2025; }],
		['wrong event week', (v: ReturnType<typeof fixture>) => { v.scoreboard.events[0].week.number = 7; }],
		['foreign league', (v: ReturnType<typeof fixture>) => { v.scoreboard.leagues[0].slug = 'nba'; }],
		['duplicate event', (v: ReturnType<typeof fixture>) => { v.scoreboard.events.push(v.scoreboard.events[0]); }],
		['missing event', (v: ReturnType<typeof fixture>) => { v.scoreboard.events.pop(); }],
		['empty events', (v: ReturnType<typeof fixture>) => { v.scoreboard.events = []; }],
		['conflicting status', (v: ReturnType<typeof fixture>) => { v.scoreboard.events[0].competitions[0].status.type.state = 'pre'; }],
		['different opponents', (v: ReturnType<typeof fixture>) => { v.scoreboard.events[0].competitions[0].competitors[0].team.abbreviation = 'NE'; }],
		['rescheduled beyond calendar', (v: ReturnType<typeof fixture>) => {
			v.scoreboard.events[0].date = v.next.startDate;
			v.scoreboard.events[0].competitions[0].date = v.next.startDate;
		}],
		['conflicting kickoff', (v: ReturnType<typeof fixture>) => { v.scoreboard.events[0].competitions[0].date = '2026-10-17T00:15Z'; }],
	] as const)('blocks inconsistent source data: %s', async (_name, change) => {
		const value = fixture();
		change(value);
		stub(value);
		const result = await read(value);
		expect(result.status).toBe('blocked');
		expect(JSON.stringify(result)).not.toContain('example.invalid');
	});

	test('missing next Super Bowl period never falls back to now or Pro Bowl week four', async () => {
		const value = fixture('superbowl');
		const urls = stub(value);
		expect(await read(value)).toEqual({ status: 'blocked', reason: 'calendar_next_period_unavailable' });
		expect(urls[0]).toContain('/types/3/weeks/5?');
		expect(urls[1]).toContain('/types/3/weeks/6?');
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	test.each([0, 1.5, 23, Number.NaN])('invalid scope %s makes zero upstream calls', async (week) => {
		stub();
		const value = fixture();
		expect(await readNflReportingWindow(sleeperScheduleSchema.parse(value.sleeper), week, now)).toMatchObject({ status: 'blocked' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test.each([403, 429, 500])('HTTP %s fails closed without retry or raw errors', async (status) => {
		stub(fixture(), () => Response.json({ error: 'PRIVATE_PROVIDER_ERROR' }, { status }));
		const result = await read();
		expect(result.status).toBe('blocked');
		expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_ERROR');
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	test('rejects malformed and oversized bodies without exposing them', async () => {
		stub(fixture(), () => new Response('PRIVATE_BAD_JSON'));
		expect(await read()).toMatchObject({ status: 'blocked' });
		fetchSpy?.mockRestore();
		stub(fixture(), () => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
		expect(await read()).toMatchObject({ status: 'blocked' });
	});

	test('identifies anonymous API reads with the project User-Agent required by the live service', async () => {
		const value = fixture();
		const urls = routes(value);
		fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			if (headers.get('user-agent') !== 'jamis-mastra/1.0')
				return new Response('Anonymous client rejected', { status: 403 });
			expect(Object.fromEntries(headers.entries())).toEqual({ 'accept': 'application/json', 'user-agent': 'jamis-mastra/1.0' });
			const index = urls.indexOf(String(input));
			expect(index).toBeGreaterThanOrEqual(0);
			return Response.json([value.current, value.next, value.scoreboard][index]);
		}, { preconnect: () => {} }));
		expect((await read(value)).status).toBe('ready');
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	test('does not mutate source fixtures or export unrelated provider fields', async () => {
		const value = fixture();
		value.current.unrelated = 'PRIVATE_PROVIDER_SENTINEL';
		const before = structuredClone(value);
		stub(value);
		const result = await read(value);
		expect(result.status).toBe('ready');
		expect(value).toEqual(before);
		expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_SENTINEL');
	});

	test('an already-canceled caller makes no HTTP request', async () => {
		stub();
		const controller = new AbortController();
		controller.abort(new Error('PRIVATE_ABORT_REASON'));
		expect(await read(fixture(), now, controller.signal)).toEqual({ status: 'blocked', reason: 'calendar_read_canceled' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test('native redirects are rejected, never followed', async () => {
		const original = globalThis.fetch;
		let followed = 0;
		const server = Bun.serve({ port: 0, fetch(request) {
			if (new URL(request.url).pathname === '/redirected')
				followed++;
			return Response.redirect(new URL('/redirected', request.url));
		} });
		fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((_input: RequestInfo | URL, init?: RequestInit) => original(server.url, init), { preconnect: () => {} }));
		try {
			expect(await read()).toEqual({ status: 'blocked', reason: 'calendar_source_unavailable' });
			expect(followed).toBe(0);
		} finally {
			server.stop(true);
		}
	});

	test('the shared 20-second deadline aborts native stalled response bodies', async () => {
		const original = globalThis.fetch;
		const nativeTimeout = AbortSignal.timeout;
		const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(ms => nativeTimeout(ms === 20_000 ? 20 : ms));
		const server = Bun.serve({ port: 0, fetch: () => new Response(new ReadableStream({ start(controller) {
			controller.enqueue(new TextEncoder().encode('{'));
		} })) });
		fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((_input: RequestInfo | URL, init?: RequestInit) => original(server.url, init), { preconnect: () => {} }));
		try {
			expect(await read()).toEqual({ status: 'blocked', reason: 'calendar_source_unavailable' });
			expect(timeout).toHaveBeenCalledWith(20_000);
			expect(fetchSpy).toHaveBeenCalledTimes(3);
		} finally {
			timeout.mockRestore();
			server.stop(true);
		}
	});

	test('caller cancellation aborts actual streamed body consumption', async () => {
		const original = globalThis.fetch;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const server = Bun.serve({ port: 0, fetch() {
			return new Response(new ReadableStream({ start(controller) {
				controller.enqueue(new TextEncoder().encode('{'));
				entered();
			} }));
		} });
		fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((_input: RequestInfo | URL, init?: RequestInit) => original(server.url, init), { preconnect: () => {} }));
		const controller = new AbortController();
		try {
			const pending = read(fixture(), now, controller.signal);
			await started;
			controller.abort(new Error('PRIVATE_ABORT_REASON'));
			const result = await pending;
			expect(result).toEqual({ status: 'blocked', reason: 'calendar_read_canceled' });
		} finally {
			server.stop(true);
		}
	});
});
