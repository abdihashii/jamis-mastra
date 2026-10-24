import type { z } from 'zod';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { SqlLike } from '../../../lib/operator-time-zone';

process.env.OPEN_WEATHER_API_KEY = 'test-weather-key';
process.env.OPERATOR_TIMEZONE = 'America/Chicago';

const { getCurrentWeather, getForecast, forecastTool } = await import('../weather-tool.js');

let originalFetch: typeof globalThis.fetch;

const operatorSql: SqlLike = async () => [];

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('weather operator-zone dates', () => {
	test('tomorrow follows the operator date while forecast buckets stay destination-local', async () => {
		const tokyoSep5 = Date.parse('2026-09-05T03:00:00.000Z') / 1000;
		const tokyoSep6 = Date.parse('2026-09-06T03:00:00.000Z') / 1000;
		globalThis.fetch = (async () => json({
			city: { timezone: 9 * 60 * 60, name: 'Tokyo' },
			list: [
				{ dt: tokyoSep5, main: { temp: 70, feels_like: 71, temp_min: 68, temp_max: 72, humidity: 50 }, weather: [{ description: 'clear' }], wind: { speed: 5 }, pop: 0 },
				{ dt: tokyoSep6, main: { temp: 80, feels_like: 81, temp_min: 78, temp_max: 82, humidity: 60 }, weather: [{ description: 'rain' }], wind: { speed: 10 }, pop: 0.8 },
			],
		})) as unknown as typeof globalThis.fetch;

		const result = await getForecast(
			{ lat: 35.68, lon: 139.76 },
			{ daysAhead: 1, nowMs: Date.parse('2026-09-05T02:00:00.000Z') },
			undefined,
			operatorSql,
		);

		expect(result.date).toBe('2026-09-05');
		expect(result.high).toBe(72);
		expect(result.condition).toBe('clear');
	});

	test('current destination-local clocks carry an explicit offset', async () => {
		globalThis.fetch = (async () => json({
			name: 'Tokyo',
			main: { temp: 70, feels_like: 69, humidity: 50 },
			weather: [{ description: 'clear', icon: '01d' }],
			visibility: 10_000,
			wind: { speed: 5 },
			dt: Date.parse('2026-09-05T03:00:00.000Z') / 1000,
			sys: {
				country: 'JP',
				sunrise: Date.parse('2026-09-04T20:00:00.000Z') / 1000,
				sunset: Date.parse('2026-09-05T09:00:00.000Z') / 1000,
			},
			timezone: 9 * 60 * 60,
		})) as unknown as typeof globalThis.fetch;

		const result = await getCurrentWeather({ lat: 35.68, lon: 139.76 });
		expect(result.localTime).toBe('12:00 PM +09:00');
		expect(result.sunrise).toBe('5:00 AM +09:00');
		expect(result.sunset).toBe('6:00 PM +09:00');
	});

	test('tool schema accepts day offsets and rejects mixed date selectors', () => {
		const schema = forecastTool.inputSchema as z.ZodTypeAny;
		expect(schema.safeParse({ location: 'Tokyo', daysAhead: 1 }).success).toBe(true);
		expect(schema.safeParse({ location: 'Tokyo', date: '2026-09-05', daysAhead: 1 }).success).toBe(false);
	});
});
