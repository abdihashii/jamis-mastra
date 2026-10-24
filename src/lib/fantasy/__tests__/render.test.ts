import type { MatchupResult } from '../week-facts';
import { describe, expect, it } from 'bun:test';
import { renderResult } from '../render';

const a = { rosterId: 1, userId: 'u1', displayName: 'alpha' };
const b = { rosterId: 2, userId: 'u2', displayName: 'bravo' };
const result: MatchupResult = {
	a,
	b,
	aPoints: 124.5,
	bPoints: 113.44,
	margin: 11.06,
	winner: a,
	loser: b,
};

describe('inspection result formatting', () => {
	it('keeps the first-listed winner and its score first', () => {
		expect(renderResult(result)).toBe('alpha def. bravo (124.5–113.44, margin 11.06)');
	});

	it('moves the second-listed winner score alongside its displayed name', () => {
		expect(renderResult({
			...result,
			aPoints: 99.94,
			bPoints: 146.14,
			margin: 46.2,
			winner: { ...b },
			loser: { ...a },
		})).toBe('bravo def. alpha (146.14–99.94, margin 46.2)');
	});

	it('preserves the original team order for tied scores', () => {
		expect(renderResult({ ...result, aPoints: 100, bPoints: 100, margin: 0, winner: null, loser: null }))
			.toBe('alpha ties bravo (100–100)');
	});
});
