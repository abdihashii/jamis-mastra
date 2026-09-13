import { TZDate } from '@date-fns/tz';
import { addDays, format, startOfDay } from 'date-fns';

/**
 * @param offsetSec - OpenWeather `timezone` (seconds from UTC)
 * @returns Fixed-offset string like `"+05:30"`
 */
function offsetString(offsetSec: number): string {
	const sign = offsetSec < 0 ? '-' : '+';
	const abs = Math.abs(offsetSec);
	const h = String(Math.floor(abs / 3600)).padStart(2, '0');
	const m = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
	return `${sign}${h}:${m}`;
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * @param day - Lowercase day name, e.g. `"saturday"`
 * @param offsetSec - Seconds from UTC, e.g. OpenWeather's `timezone` field
 * @param nowSec - Unix time in seconds; injectable for tests
 * @returns Date of the nearest upcoming `day` in that offset, inclusive of today, e.g. `"2025-01-04"`
 */
export function nextDayDate(day: string, offsetSec: number, nowSec = Math.floor(Date.now() / 1000)): string {
	const target = DAYS.indexOf(day);
	if (target < 0) {
		throw new Error(`Unknown day "${day}". Use one of: ${DAYS.join(', ')}.`);
	}
	const now = new TZDate(nowSec * 1000, offsetString(offsetSec));
	const delta = (target - now.getDay() + 7) % 7;
	return format(addDays(now, delta), 'yyyy-MM-dd');
}

/**
 * @param unixSec - Unix time in seconds
 * @param offsetSec - Seconds from UTC, e.g. OpenWeather's `timezone` field
 * @returns Local wall-clock time, e.g. `"7:42 PM"`
 */
export function localTime(unixSec: number, offsetSec: number): string {
	return format(new TZDate(unixSec * 1000, offsetString(offsetSec)), 'h:mm a');
}

/**
 * @param unixSec - Unix time in seconds
 * @param offsetSec - Seconds from UTC, e.g. OpenWeather's `timezone` field
 * @returns Local calendar date, e.g. `"2024-09-18"`
 */
export function localDate(unixSec: number, offsetSec: number): string {
	return format(new TZDate(unixSec * 1000, offsetString(offsetSec)), 'yyyy-MM-dd');
}

/**
 * @param timeZone - IANA zone name, e.g. `"America/Chicago"`
 * @param daysAhead - Window size in whole days
 * @param nowMs - Epoch ms; injectable for tests
 * @returns [start of today, start of today + daysAhead] in that zone, RFC3339 with zone offset
 */
export function zonedDayWindow(timeZone: string, daysAhead: number, nowMs = Date.now()): [string, string] {
	const start = startOfDay(new TZDate(nowMs, timeZone));
	return [format(start, 'yyyy-MM-dd\'T\'HH:mm:ssxxx'), format(addDays(start, daysAhead), 'yyyy-MM-dd\'T\'HH:mm:ssxxx')];
}

export function isIanaTimeZone(value: string): boolean {
	if (/^[+-]/.test(value))
		return false;

	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions();
		return true;
	}
	catch {
		return false;
	}
}

export function zonedDateTime(timeZone: string, nowMs = Date.now()): string {
	return format(new TZDate(nowMs, timeZone), 'yyyy-MM-dd\'T\'HH:mm:ssxxx');
}
