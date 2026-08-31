import { expect, test } from 'bun:test';

import { localDate, localTime } from '../time';

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
