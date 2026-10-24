import type { SleeperGame, SleeperScheduleSnapshot } from '../sleeper';
import { describe, expect, it } from 'bun:test';
import { resolveSleeperChatWindow } from '../chat-window';

const collected = new Date('2026-10-21T12:30:00.000Z');
function game(patch: Partial<SleeperGame> = {}): SleeperGame {
	return { id: '202610601', week: 6, date: '2026-10-15', status: 'complete', home: 'AZ', away: 'SEA', ...patch };
}
function schedule(games: SleeperGame[] = [game()], phase: 'regular' | 'post' = 'regular'): SleeperScheduleSnapshot {
	return { season: '2026', phase, retrievedAtUtc: collected.toISOString(), games };
}
function blocked(reason: string) {
	return { status: 'blocked' as const, reason };
}

describe('schedule calendar-date archive coverage, not kickoff or final-whistle timestamps', () => {
	it.each(['2026-10-20', '2026-10-21'])('includes completed delayed Tuesday/Wednesday games through collection: %s', (date) => {
		const snapshot = schedule([
			game({ id: '202610602', date }),
			game(),
			game({ id: '202610701', week: 7, date: '2026-10-22', status: 'pre_game' }),
		]);
		expect(resolveSleeperChatWindow(snapshot, 6, collected)).toEqual({
			status: 'ready',
			window: { startAtUtc: '2026-10-15T00:00:00.000Z', endAtUtc: collected.toISOString() },
		});
	});

	it('uses the earliest actual target game even when it begins on Wednesday, never a fixed weekday offset', () => {
		expect(resolveSleeperChatWindow(schedule([game({ date: '2026-10-14' })]), 6, collected)).toEqual({
			status: 'ready',
			window: { startAtUtc: '2026-10-14T00:00:00.000Z', endAtUtc: collected.toISOString() },
		});
	});

	it('caps at the earliest next-week game day and preserves the two-day conservative gap boundary', () => {
		const snapshot = schedule([
			game({ id: '202610702', week: 7, date: '2026-10-25', status: 'pre_game' }),
			game({ id: '202610602', date: '2026-10-20' }),
			game(),
			game({ id: '202610701', week: 7, date: '2026-10-22', status: 'pre_game' }),
		]);
		const before = structuredClone(snapshot);
		expect(resolveSleeperChatWindow(snapshot, 6, new Date('2026-10-26T05:00:00Z'))).toEqual({
			status: 'ready',
			window: { startAtUtc: '2026-10-15T00:00:00.000Z', endAtUtc: '2026-10-22T00:00:00.000Z' },
		});
		expect(snapshot).toEqual(before);
	});

	it.each(['2026-10-21', '2026-10-22', '2026-10-23'])('blocks adjacent, overlapping and inverted final game dates: %s', (date) => {
		const snapshot = schedule([
			game(),
			game({ id: '202610602', date }),
			game({ id: '202610701', week: 7, date: '2026-10-22', status: 'pre_game' }),
		]);
		expect(resolveSleeperChatWindow(snapshot, 6, new Date('2026-10-26T05:00:00Z')))
			.toEqual(blocked('schedule_window_ambiguous'));
	});

	it('applies the overlap guard when collection equals the next-week boundary', () => {
		const snapshot = schedule([
			game({ date: '2026-10-21' }),
			game({ id: '202610701', week: 7, date: '2026-10-22' }),
		]);
		expect(resolveSleeperChatWindow(snapshot, 6, new Date('2026-10-22T00:00:00Z')))
			.toEqual(blocked('schedule_window_ambiguous'));
	});

	it.each(['unknown', 'pre_game', 'in_game', 'postponed', 'suspended', 'canceled'])('blocks every actual game not exactly complete: %s', (status) => {
		const snapshot = schedule([game(), game({ id: '202610602', date: '2026-10-20', status })]);
		expect(resolveSleeperChatWindow(snapshot, 6, collected)).toEqual(blocked('schedule_week_unclosed'));
	});

	it('excludes only canceled TBD placeholders from target dates and next-week cap', () => {
		const snapshot = schedule([
			game({ id: '202610600', date: '2026-10-01', status: 'canceled', home: 'TBD' }),
			game(),
			game({ id: '202610603', date: '2026-12-01', status: 'canceled', away: 'TBD' }),
			game({ id: '202610700', week: 7, date: '2026-10-16', status: 'canceled', home: 'TBD', away: 'TBD' }),
			game({ id: '202610701', week: 7, date: '2026-10-22', status: 'canceled' }),
		]);
		expect(resolveSleeperChatWindow(snapshot, 6, new Date('2026-10-26T05:00:00Z'))).toEqual({
			status: 'ready',
			window: { startAtUtc: '2026-10-15T00:00:00.000Z', endAtUtc: '2026-10-22T00:00:00.000Z' },
		});
	});

	it.each(['complete', 'pre_game'])('does not silently drop unresolved noncanceled TBD participants: %s', (status) => {
		expect(resolveSleeperChatWindow(schedule([game({ home: 'TBD', status })]), 6, collected).status).toBe('blocked');
	});

	it.each([
		{ games: [] },
		{ games: [game({ week: 5 })] },
		{ games: [game({ status: 'canceled', home: 'TBD' })] },
	])('requires at least one actual target game: %#', ({ games }) => {
		expect(resolveSleeperChatWindow(schedule([...games]), 6, collected)).toEqual(blocked('schedule_week_missing'));
	});

	it('uses collection when no next-week actual date is available, without manufacturing a weekly end', () => {
		const snapshot = schedule([game({ date: '2026-10-20' }), game({ week: 7, id: '202610700', status: 'canceled', home: 'TBD' })]);
		expect(resolveSleeperChatWindow(snapshot, 6, collected)).toEqual({
			status: 'ready',
			window: { startAtUtc: '2026-10-20T00:00:00.000Z', endAtUtc: collected.toISOString() },
		});
	});

	it('converts fantasy week 19 to postseason week 1, and allows the last postseason week without a next week', () => {
		const first = game({ week: 1, date: '2027-01-16' });
		const next = game({ week: 2, id: '202630201', date: '2027-01-23' });
		const last = game({ week: 4, id: '202630401', date: '2027-02-14' });
		const snapshot = schedule([first, next, last], 'post');
		const now = new Date('2027-02-16T13:00:00Z');
		expect(resolveSleeperChatWindow(snapshot, 19, now)).toEqual({
			status: 'ready',
			window: { startAtUtc: '2027-01-16T00:00:00.000Z', endAtUtc: '2027-01-23T00:00:00.000Z' },
		});
		expect(resolveSleeperChatWindow(snapshot, 22, now)).toEqual({
			status: 'ready',
			window: { startAtUtc: '2027-02-14T00:00:00.000Z', endAtUtc: now.toISOString() },
		});
	});

	it('rejects wrong-phase snapshots', () => {
		expect(resolveSleeperChatWindow(schedule([game({ week: 1 })], 'post'), 18, collected))
			.toEqual(blocked('schedule_phase_mismatch'));
		expect(resolveSleeperChatWindow(schedule(), 19, collected)).toEqual(blocked('schedule_phase_mismatch'));
		expect(resolveSleeperChatWindow(schedule([game({ week: 1 })], 'post'), 1, collected))
			.toEqual(blocked('schedule_phase_mismatch'));
	});

	describe('regular week 18 requires the same-season postseason boundary', () => {
		const regular = schedule([game({ week: 18, date: '2027-01-03' })]);
		const post = schedule([
			game({ id: '202630102', week: 1, date: '2027-01-11' }),
			game({ id: '202630100', week: 1, date: '2027-01-04', status: 'canceled', home: 'TBD' }),
			game({ id: '202630101', week: 1, date: '2027-01-10' }),
		], 'post');
		const delayedCollection = new Date('2027-01-20T12:30:00.000Z');

		it('caps a delayed January 20 collection before January 10 postseason chat, ignoring canceled placeholders', () => {
			const before = structuredClone([regular, post]);
			expect(resolveSleeperChatWindow(regular, 18, delayedCollection, post)).toEqual({
				status: 'ready',
				window: { startAtUtc: '2027-01-03T00:00:00.000Z', endAtUtc: '2027-01-10T00:00:00.000Z' },
			});
			expect([regular, post]).toEqual(before);
		});

		it('caps at now when collection precedes postseason week 1', () => {
			const now = new Date('2027-01-05T12:30:00.000Z');
			expect(resolveSleeperChatWindow(regular, 18, now, post)).toEqual({
				status: 'ready',
				window: { startAtUtc: '2027-01-03T00:00:00.000Z', endAtUtc: now.toISOString() },
			});
		});

		it.each(['pre_game', 'canceled'])('retains an actual postseason game as the boundary regardless of status: %s', (status) => {
			const next = schedule([game({ week: 1, date: '2027-01-10', status })], 'post');
			expect(resolveSleeperChatWindow(regular, 18, delayedCollection, next)).toEqual({
				status: 'ready',
				window: { startAtUtc: '2027-01-03T00:00:00.000Z', endAtUtc: '2027-01-10T00:00:00.000Z' },
			});
		});

		it.each([
			[undefined, 'schedule_source_invalid'],
			[null, 'schedule_source_invalid'],
			[{}, 'schedule_source_invalid'],
			[{ ...post, retrievedAtUtc: 'private 雪' }, 'schedule_source_invalid'],
			[schedule([game({ week: 1, date: '2027-02-30' })], 'post'), 'schedule_source_invalid'],
			[{ ...schedule([game({ id: '202530101', week: 1, date: '2026-01-10' })], 'post'), season: '2025' }, 'schedule_scope_invalid'],
			[schedule([game({ week: 1, date: '2027-01-10' })]), 'schedule_phase_mismatch'],
			[schedule([], 'post'), 'schedule_week_missing'],
			[schedule([game({ week: 2, date: '2027-01-17' })], 'post'), 'schedule_week_missing'],
			[schedule([game({ week: 1, status: 'canceled', home: 'TBD' })], 'post'), 'schedule_week_missing'],
			[schedule([game({ week: 1, status: 'canceled', away: 'TBD' })], 'post'), 'schedule_week_missing'],
		] as const)('blocks missing, invalid, wrong-scope and placeholder-only postseason evidence: %#', (next, reason) => {
			expect(resolveSleeperChatWindow(regular, 18, delayedCollection, next as SleeperScheduleSnapshot))
				.toEqual(blocked(reason));
		});

		it.each(['complete', 'pre_game'])('blocks unresolved noncanceled postseason participants even beside actual games: %s', (status) => {
			const next = schedule([...post.games, game({ id: '202630103', week: 1, date: '2027-01-12', status, away: 'TBD' })], 'post');
			expect(resolveSleeperChatWindow(regular, 18, delayedCollection, next)).toEqual(blocked('schedule_window_ambiguous'));
		});

		it('allows the exact two-day calendar gap across phases', () => {
			expect(resolveSleeperChatWindow(schedule([game({ week: 18, date: '2027-01-08' })]), 18, delayedCollection, post)).toEqual({
				status: 'ready',
				window: { startAtUtc: '2027-01-08T00:00:00.000Z', endAtUtc: '2027-01-10T00:00:00.000Z' },
			});
		});

		it.each(['2027-01-09', '2027-01-10', '2027-01-11'])('blocks adjacent, overlapping and inverted cross-phase dates: %s', (date) => {
			expect(resolveSleeperChatWindow(schedule([game({ week: 18, date })]), 18, delayedCollection, post))
				.toEqual(blocked('schedule_window_ambiguous'));
		});

		it('applies the cross-phase ambiguity guard when now equals the boundary', () => {
			expect(resolveSleeperChatWindow(schedule([game({ week: 18, date: '2027-01-09' })]), 18, new Date('2027-01-10T00:00:00Z'), post))
				.toEqual(blocked('schedule_window_ambiguous'));
		});
	});

	it.each([6, 19, 20, 21, 22])('ignores an unrelated next-phase snapshot outside week 18: %s', (week) => {
		const snapshot = schedule([game({ week: week <= 18 ? week : week - 18 })], week <= 18 ? 'regular' : 'post');
		expect(resolveSleeperChatWindow(snapshot, week, collected, {} as SleeperScheduleSnapshot))
			.toEqual(resolveSleeperChatWindow(snapshot, week, collected));
	});

	it.each([0, -1, 1.5, 23, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid fantasy week %s', (week) => {
		expect(resolveSleeperChatWindow(schedule(), week, collected)).toEqual(blocked('schedule_scope_invalid'));
	});

	it('rejects future target dates even when source status says complete', () => {
		expect(resolveSleeperChatWindow(schedule([game({ date: '2026-10-22' })]), 6, collected))
			.toEqual(blocked('schedule_week_unclosed'));
	});

	it('rejects start equal to end and invalid now without throwing', () => {
		expect(resolveSleeperChatWindow(schedule([game({ date: '2026-10-21' })]), 6, new Date('2026-10-21T00:00:00Z')))
			.toEqual(blocked('schedule_window_ambiguous'));
		expect(resolveSleeperChatWindow(schedule(), 6, new Date(Number.NaN)))
			.toEqual(blocked('schedule_scope_invalid'));
	});

	it('uses UTC calendar dates even when the caller supplied an offset time', () => {
		expect(resolveSleeperChatWindow(schedule([game({ date: '2026-10-22' })]), 6, new Date('2026-10-21T23:00:00-04:00')))
			.toEqual({ status: 'ready', window: { startAtUtc: '2026-10-22T00:00:00.000Z', endAtUtc: '2026-10-22T03:00:00.000Z' } });
	});

	it.each([
		null,
		{},
		{ ...schedule(), phase: 'private 雪' },
		{ ...schedule(), season: '２０２６' },
		{ ...schedule(), retrievedAtUtc: 'private 雪' },
		schedule([game({ date: '2026-02-30' })]),
		schedule([game({ id: '202510601' })]),
		schedule([game(), game()]),
		schedule([game({ week: 19 })]),
		schedule([game({ home: 'private 雪' })]),
		schedule([game({ status: 'private 雪' })]),
		schedule(Array.from({ length: 401 }, (_, i) => game({ id: `2026${i}` }))),
	])('rejects invalid source snapshots without leaking raw values: %#', (snapshot) => {
		expect(resolveSleeperChatWindow(snapshot as SleeperScheduleSnapshot, 6, collected))
			.toEqual(blocked('schedule_source_invalid'));
	});
});
