import { TZDate } from '@date-fns/tz';
import { addDays, format } from 'date-fns';

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

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * @param weekday - Lowercase day name, e.g. `"saturday"`
 * @param offsetSec - Seconds from UTC, e.g. OpenWeather's `timezone` field
 * @param nowSec - Unix time in seconds; injectable for tests
 * @returns Date of the nearest upcoming `weekday` in that offset, inclusive of today, e.g. `"2025-01-04"`
 */
export function nextWeekdayDate(weekday: string, offsetSec: number, nowSec = Math.floor(Date.now() / 1000)): string {
	const target = WEEKDAYS.indexOf(weekday);
	if (target < 0) {
		throw new Error(`Unknown weekday "${weekday}". Use one of: ${WEEKDAYS.join(', ')}.`);
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
