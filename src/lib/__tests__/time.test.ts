import { expect, test } from 'bun:test';

import { localDate, localTime, nextWeekdayDate } from '../time';

test('localTime formats midnight and noon as 12-hour', () => {
	expect(localTime(0, 0)).toBe('12:00 AM');
	expect(localTime(43200, 0)).toBe('12:00 PM'); // noon UTC
	expect(localTime(46800, 0)).toBe('1:00 PM');
});

test('localTime applies a positive UTC offset', () => {
	expect(localTime(0, 7200)).toBe('2:00 AM'); // unix epoch in UTC+2
});

test('localDate applies a negative UTC offset across a year boundary', () => {
	expect(localDate(0, 0)).toBe('1970-01-01');
	expect(localDate(0, -21600)).toBe('1969-12-31'); // UTC-6
});

test('localTime/localDate on the Turin sample payload', () => {
	// OpenWeather sample: dt=1726660758, timezone=7200 → 2024-09-18 13:59 local
	expect(localDate(1726660758, 7200)).toBe('2024-09-18');
	expect(localTime(1726660758, 7200)).toBe('1:59 PM');
});

test('nextWeekdayDate is inclusive of today when the day matches', () => {
	// 2024-09-21T12:00:00Z is a Saturday
	expect(nextWeekdayDate('saturday', 0, Date.UTC(2024, 8, 21, 12) / 1000)).toBe('2024-09-21');
});

test('nextWeekdayDate rolls over a month boundary', () => {
	// 2024-12-30T12:00:00Z is a Monday; the next Saturday is 2025-01-04
	expect(nextWeekdayDate('saturday', 0, Date.UTC(2024, 11, 30, 12) / 1000)).toBe('2025-01-04');
});

test('nextWeekdayDate uses the offset zone, not the UTC calendar date', () => {
	// 2024-09-19T04:30Z is Wednesday 23:30 at UTC-5. Local Wednesday + 'wednesday' → that same local date,
	// even though the UTC calendar already reads Thursday.
	expect(nextWeekdayDate('wednesday', -18000, Date.UTC(2024, 8, 19, 4, 30) / 1000)).toBe('2024-09-18');
});

test('nextWeekdayDate rejects unknown weekday names', () => {
	expect(() => nextWeekdayDate('sat', 0, 0)).toThrow('Unknown weekday');
});
