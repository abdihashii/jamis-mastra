import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';

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
