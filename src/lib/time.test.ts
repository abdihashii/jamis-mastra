import { expect, test } from 'bun:test';

import { dateTimeInstant, isIanaTimeZone, localDate, localTime, nextDayDate, zonedDate, zonedDateTime, zonedDayWindow } from './time';

test('localTime formats midnight and noon as 12-hour', () => {
	expect(localTime(0, 0)).toBe('12:00 AM +00:00');
	expect(localTime(43200, 0)).toBe('12:00 PM +00:00'); // noon UTC
	expect(localTime(46800, 0)).toBe('1:00 PM +00:00');
});

test('localTime applies a positive UTC offset', () => {
	expect(localTime(0, 7200)).toBe('2:00 AM +02:00'); // unix epoch in UTC+2
});

test('localDate applies a negative UTC offset across a year boundary', () => {
	expect(localDate(0, 0)).toBe('1970-01-01');
	expect(localDate(0, -21600)).toBe('1969-12-31'); // UTC-6
});

test('localTime/localDate on the Turin sample payload', () => {
	// OpenWeather sample: dt=1726660758, timezone=7200 → 2024-09-18 13:59 local
	expect(localDate(1726660758, 7200)).toBe('2024-09-18');
	expect(localTime(1726660758, 7200)).toBe('1:59 PM +02:00');
});

test('zonedDayWindow opens at local midnight and spans whole days', () => {
	// 2026-09-05T12:00:00Z is 07:00 in Chicago (UTC-5 in DST): the window
	// starts at local midnight, not on the UTC calendar date.
	const [from, to] = zonedDayWindow('America/Chicago', 1, Date.UTC(2026, 8, 5, 12));
	expect(from).toBe('2026-09-05T00:00:00-05:00');
	expect(to).toBe('2026-09-06T00:00:00-05:00');

	const [from2, to2] = zonedDayWindow('America/Chicago', 2, Date.UTC(2026, 0, 15, 6)); // UTC-6 in winter
	expect(from2).toBe('2026-01-15T00:00:00-06:00');
	expect(to2).toBe('2026-01-17T00:00:00-06:00');
});

test('zonedDayWindow follows civil days across DST', () => {
	const [from, to] = zonedDayWindow('America/Chicago', 1, Date.parse('2026-03-08T12:00:00.000Z'));
	expect(from).toBe('2026-03-08T00:00:00-06:00');
	expect(to).toBe('2026-03-09T00:00:00-05:00');
	expect(Date.parse(to) - Date.parse(from)).toBe(23 * 60 * 60 * 1000);

	const [yesterdayFrom, yesterdayTo] = zonedDayWindow('America/Chicago', 1, Date.parse('2026-03-08T12:00:00.000Z'), -1);
	expect(yesterdayFrom).toBe('2026-03-07T00:00:00-06:00');
	expect(yesterdayTo).toBe('2026-03-08T00:00:00-06:00');
});

test('zonedDate applies an operator-zone civil-day offset', () => {
	const nowMs = Date.parse('2026-09-05T02:00:00.000Z');
	expect(zonedDate('America/Chicago', 0, nowMs)).toBe('2026-09-04');
	expect(zonedDate('America/Chicago', 1, nowMs)).toBe('2026-09-05');
});

test('dateTimeInstant uses a sibling IANA zone for an offsetless provider value', () => {
	expect(new Date(dateTimeInstant('2026-09-05T20:00:00', 'Asia/Tokyo')).toISOString()).toBe('2026-09-05T11:00:00.000Z');
	expect(new Date(dateTimeInstant('2026-09-05T08:00:00-03:00')).toISOString()).toBe('2026-09-05T11:00:00.000Z');
	expect(dateTimeInstant('2026-09-05T08:00:00')).toBeNaN();
});

test('nextDayDate is inclusive of today when the day matches', () => {
	// 2024-09-21T12:00:00Z is a Saturday
	expect(nextDayDate('saturday', 'Etc/UTC', Date.UTC(2024, 8, 21, 12))).toBe('2024-09-21');
});

test('nextDayDate rolls over a month boundary', () => {
	// 2024-12-30T12:00:00Z is a Monday; the next Saturday is 2025-01-04
	expect(nextDayDate('saturday', 'Etc/UTC', Date.UTC(2024, 11, 30, 12))).toBe('2025-01-04');
});

test('nextDayDate uses the operator zone, not the UTC calendar date', () => {
	// 2024-09-19T04:30Z is Wednesday 23:30 in Chicago. Local Wednesday + 'wednesday' → that same local date,
	// even though the UTC calendar already reads Thursday.
	expect(nextDayDate('wednesday', 'America/Chicago', Date.UTC(2024, 8, 19, 4, 30))).toBe('2024-09-18');
});

test('nextDayDate rejects unknown day names', () => {
	expect(() => nextDayDate('sat', 'Etc/UTC', 0)).toThrow('Unknown day');
});

test('IANA time zone validation uses the platform database', () => {
	expect(isIanaTimeZone('America/Chicago')).toBe(true);
	expect(isIanaTimeZone('Asia/Kolkata')).toBe(true);
	expect(isIanaTimeZone('Etc/UTC')).toBe(true);
	expect(isIanaTimeZone('US/Central')).toBe(true);
	expect(isIanaTimeZone('UTC')).toBe(true);
	expect(isIanaTimeZone('+05:30')).toBe(false);
	expect(isIanaTimeZone('Mars/Olympus_Mons')).toBe(false);
});

test('zonedDateTime includes the DST-sensitive operator offset', () => {
	expect(zonedDateTime('America/Chicago', Date.parse('2026-03-08T07:30:00.000Z'))).toBe('2026-03-08T01:30:00-06:00');
	expect(zonedDateTime('America/Chicago', Date.parse('2026-03-08T08:30:00.000Z'))).toBe('2026-03-08T03:30:00-05:00');
});

test('zonedDateTime preserves the operator date across a UTC rollover', () => {
	expect(zonedDateTime('America/Chicago', Date.parse('2026-09-05T02:00:00.000Z'))).toBe('2026-09-04T21:00:00-05:00');
});
