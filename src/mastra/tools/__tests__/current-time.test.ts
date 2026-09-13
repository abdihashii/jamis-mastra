import type { SqlLike } from '../../../lib/operator-time-zone';

import { describe, expect, it } from 'bun:test';

import { ensureOperatorTimeZoneTable, resolveOperatorTimeZone, setOperatorTimeZoneOverride } from '../../../lib/operator-time-zone';
import { requireOperatorTimeZone } from '../../env';
import { readCurrentTime } from '../current-time';

function memorySql(initialOverride?: string | null) {
	let override = initialOverride;
	const sql: SqlLike = async (strings, ...values) => {
		const query = strings.join('?');
		if (query.includes('SELECT override_time_zone')) {
			return override === undefined ? [] : [{ override_time_zone: override }];
		}
		if (query.includes('INSERT INTO operator_time_zone')) {
			override = values[0] as string | null;
		}
		return [];
	};
	return { sql, override: () => override };
}

describe('operator time zone', () => {
	it('requires a valid deployment default', () => {
		expect(() => requireOperatorTimeZone({})).toThrow('Set OPERATOR_TIMEZONE');
		expect(() => requireOperatorTimeZone({ OPERATOR_TIMEZONE: 'Mars/Olympus_Mons' })).toThrow('Invalid OPERATOR_TIMEZONE');
		expect(requireOperatorTimeZone({ OPERATOR_TIMEZONE: ' America/Chicago ' })).toBe('America/Chicago');
	});

	it('resolves the persisted override before the deployment default', async () => {
		const fixture = memorySql();
		expect(await resolveOperatorTimeZone('America/Chicago', fixture.sql)).toEqual({
			timeZone: 'America/Chicago',
			source: 'default',
		});

		await setOperatorTimeZoneOverride('Asia/Tokyo', fixture.sql);
		expect(fixture.override()).toBe('Asia/Tokyo');
		expect(await resolveOperatorTimeZone('America/Chicago', fixture.sql)).toEqual({
			timeZone: 'Asia/Tokyo',
			source: 'override',
		});

		await setOperatorTimeZoneOverride(null, fixture.sql);
		expect(await resolveOperatorTimeZone('America/Chicago', fixture.sql)).toEqual({
			timeZone: 'America/Chicago',
			source: 'default',
		});
	});

	it('rejects an invalid persisted override before writing', async () => {
		const fixture = memorySql();
		await expect(setOperatorTimeZoneOverride('Mars/Olympus_Mons', fixture.sql)).rejects.toThrow('Invalid operator time zone');
		expect(fixture.override()).toBeUndefined();
	});

	it('shares concurrent table initialization and retries a failure', async () => {
		let calls = 0;
		let fail = true;
		const sql: SqlLike = async () => {
			calls += 1;
			if (fail) {
				fail = false;
				throw new Error('database unavailable');
			}
			return [];
		};

		await expect(ensureOperatorTimeZoneTable(sql)).rejects.toThrow('database unavailable');
		await Promise.all([ensureOperatorTimeZoneTable(sql), ensureOperatorTimeZoneTable(sql)]);
		expect(calls).toBe(2);
	});

	it('represents one UTC instant in the effective operator zone', async () => {
		const nowMs = Date.parse('2026-09-05T02:00:00.000Z');
		const fixture = memorySql();
		expect(await readCurrentTime('America/Chicago', nowMs, fixture.sql)).toEqual({
			nowUtc: '2026-09-05T02:00:00.000Z',
			timeZone: 'America/Chicago',
			source: 'default',
			operatorLocal: '2026-09-04T21:00:00-05:00',
		});

		await setOperatorTimeZoneOverride('Asia/Tokyo', fixture.sql);
		expect(await readCurrentTime('America/Chicago', nowMs, fixture.sql)).toEqual({
			nowUtc: '2026-09-05T02:00:00.000Z',
			timeZone: 'Asia/Tokyo',
			source: 'override',
			operatorLocal: '2026-09-05T11:00:00+09:00',
		});
	});
});
