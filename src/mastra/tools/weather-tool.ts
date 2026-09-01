import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { fetchJson } from '../../lib/fetch';
import { localDate, localTime, nextDayDate } from '../../lib/time';
import { requireEnv } from '../env';

const openWeatherApiKey = requireEnv('OPEN_WEATHER_API_KEY');
const openWeatherBaseUrl = 'https://api.openweathermap.org';

interface GeoResult {
	name: string;
	state?: string;
	country: string;
	lat: number;
	lon: number;
}

interface Weather {
	main: string;
	description: string;
	icon: string;
}

interface CurrentWeatherConditions {
	location: string;
	country: string;
	localTime: string;
	temperature: number;
	feelsLike: number;
	condition: string;
	isDay: boolean;
	precipitationMmPerHour?: number;
	windMph: number;
	gustMph?: number;
	visibilityMiles?: number;
	humidityPercent: number;
	sunrise: string;
	sunset: string;
}

interface CurrentWeatherResult {
	main: {
		temp: number;
		feels_like: number;
		humidity: number;
	};
	weather: Weather[];
	visibility: number;
	wind: {
		speed: number;
		gust?: number;
	};
	rain?: { '1h': number };
	snow?: { '1h': number };
	dt: number;
	sys: {
		country: string;
		sunrise: number;
		sunset: number;
	};
	timezone: number;
}

interface ForecastEntry {
	dt: number;
	main: {
		temp: number;
		feels_like: number;
		temp_min: number;
		temp_max: number;
		humidity: number;
	};
	weather: Weather[];
	wind: { speed: number };
	pop: number;
	rain?: { '3h': number };
	snow?: { '3h': number };
}

interface ForecastResult {
	list: ForecastEntry[];
	city: { timezone: number };
}

interface ForecastSummary {
	location: string;
	date: string;
	high: number;
	low: number;
	feelsLike: number;
	condition: string;
	precipChancePercent: number;
	precipitationMm?: number;
	windMph: number;
	humidityPercent: number;
}

function serviceError(action: string, status: number): Error {
	console.error(`[weather-tool] ${action} failed with status ${status}`);
	if (status === 401)
		return new Error('Weather service authentication failed.');
	if (status === 429)
		return new Error('Weather service is rate-limited. Try again later.');
	return new Error('Weather service request failed.');
}

function unusableData(action: string): Error {
	console.error(`[weather-tool] ${action} returned unusable data`);
	return new Error('Weather service returned unusable data.');
}

async function geocode(location: string, signal?: AbortSignal): Promise<GeoResult> {
	const url = `${openWeatherBaseUrl}/geo/1.0/direct?q=${encodeURIComponent(location)}&limit=1&appid=${openWeatherApiKey}`;
	const res = await fetchJson(url, signal);

	if (!res.ok) {
		throw serviceError(`geocoding for "${location}"`, res.status);
	}
	if (!Array.isArray(res.json) || res.json.length === 0) {
		throw new Error(`Location "${location}" not found. Try "City" or "City, CC".`);
	}

	const { name, state, country, lat, lon } = res.json[0];
	return { name, state, country, lat, lon };
}

export async function getCurrentWeather(location: string, signal?: AbortSignal): Promise<CurrentWeatherConditions> {
	const geo = await geocode(location, signal);
	const url = `${openWeatherBaseUrl}/data/2.5/weather?lat=${geo.lat}&lon=${geo.lon}&units=imperial&appid=${openWeatherApiKey}`;
	const res = await fetchJson(url, signal);

	if (!res.ok) {
		throw serviceError(`current weather for "${location}"`, res.status);
	}

	const w = res.json as CurrentWeatherResult | null;
	if (!w?.main) {
		throw unusableData(`current weather for "${location}"`);
	}

	const rain1h = w.rain?.['1h'] ?? 0;
	const snow1h = w.snow?.['1h'] ?? 0;

	return {
		location: geo.state ? `${geo.name}, ${geo.state}` : geo.name,
		country: geo.country,
		localTime: localTime(w.dt, w.timezone),
		temperature: Math.round(w.main.temp),
		feelsLike: Math.round(w.main.feels_like),
		condition: w.weather[0]?.description ?? 'unknown',
		isDay: (w.weather[0]?.icon ?? '').endsWith('d'),
		precipitationMmPerHour: rain1h + snow1h > 0 ? rain1h + snow1h : undefined,
		windMph: Math.round(w.wind.speed),
		gustMph: w.wind.gust !== undefined ? Math.round(w.wind.gust) : undefined,
		visibilityMiles: w.visibility !== undefined ? Math.round(w.visibility / 1609) : undefined,
		humidityPercent: w.main.humidity,
		sunrise: localTime(w.sys.sunrise, w.timezone),
		sunset: localTime(w.sys.sunset, w.timezone),
	};
}

export async function getForecast(
	location: string,
	ref: { date?: string; day?: string },
	signal?: AbortSignal,
): Promise<ForecastSummary> {
	if ((ref.date === undefined) === (ref.day === undefined)) {
		throw new Error('Pass exactly one of date ("YYYY-MM-DD") or day ("saturday").');
	}
	if (ref.date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(ref.date) || Number.isNaN(Date.parse(ref.date)))) {
		throw new Error(`Invalid date "${ref.date}". Use a real calendar date as YYYY-MM-DD.`);
	}

	const geo = await geocode(location, signal);
	const url = `${openWeatherBaseUrl}/data/2.5/forecast?lat=${geo.lat}&lon=${geo.lon}&units=imperial&appid=${openWeatherApiKey}`;
	const res = await fetchJson(url, signal);

	if (!res.ok) {
		throw serviceError(`forecast for "${location}"`, res.status);
	}

	const data = res.json as ForecastResult | null;
	if (!Array.isArray(data?.list) || typeof (data as ForecastResult).city?.timezone !== 'number') {
		throw unusableData(`forecast for "${location}"`);
	}

	const { list } = data as ForecastResult;
	const tz = (data as ForecastResult).city.timezone;
	const date = ref.date ?? nextDayDate(ref.day!, tz);
	const entries = list.filter(e => localDate(e.dt, tz) === date);

	if (entries.length === 0) {
		throw new Error(`No forecast for ${date}. The forecast only covers the next 5 days.`);
	}

	const midday = entries.reduce((best, e) =>
		Math.abs((new Date((e.dt + tz) * 1000).getUTCHours()) - 12)
		< Math.abs((new Date((best.dt + tz) * 1000).getUTCHours()) - 12)
			? e
			: best,
	);
	const precipitationMm = entries.reduce((sum, e) => sum + (e.rain?.['3h'] ?? 0) + (e.snow?.['3h'] ?? 0), 0);

	return {
		location: geo.state ? `${geo.name}, ${geo.state}` : geo.name,
		date,
		high: Math.round(Math.max(...entries.map(e => e.main.temp_max))),
		low: Math.round(Math.min(...entries.map(e => e.main.temp_min))),
		feelsLike: Math.round(midday.main.feels_like),
		condition: midday.weather[0]?.description ?? 'unknown',
		precipChancePercent: Math.round(Math.max(...entries.map(e => e.pop)) * 100),
		precipitationMm: precipitationMm > 0 ? Math.round(precipitationMm) : undefined,
		windMph: Math.round(Math.max(...entries.map(e => e.wind.speed))),
		humidityPercent: midday.main.humidity,
	};
}

export const weatherTool = createTool({
	id: 'weather-tool',
	description:
    'Current weather conditions for a location. '
    + 'Use for "now" questions like "what\'s the weather" or "is it safe to walk outside".',
	inputSchema: z.object({
		location: z.string().describe('City name, e.g. "Chicago" or "Paris, FR"'),
	}),
	outputSchema: z.object({
		location: z.string(),
		country: z.string(),
		localTime: z.string(),
		temperature: z.number().describe('°F'),
		feelsLike: z.number().describe('°F'),
		condition: z.string(),
		isDay: z.boolean(),
		precipitationMmPerHour: z.number().optional(),
		windMph: z.number(),
		gustMph: z.number().optional(),
	visibilityMiles: z.number().optional(),
		humidityPercent: z.number(),
		sunrise: z.string(),
		sunset: z.string(),
	}),
	execute: async ({ location }, { abortSignal }) => {
		return await getCurrentWeather(location, abortSignal ?? undefined);
	},
});

export const forecastTool = createTool({
	id: 'forecast-tool',
	description:
    'Weather forecast for a location on a future date, up to 5 days out. '
    + 'Use for questions like "what should we wear to the zoo on Saturday". '
    + 'Prefer day for day-name phrasing ("Saturday") and date for absolute references.',
	inputSchema: z.object({
		location: z.string().describe('City name, e.g. "Chicago" or "Paris, FR"'),
		date: z.string().optional().describe('Target date as YYYY-MM-DD, in the location\'s local time'),
		day: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])
			.optional()
			.describe('Nearest upcoming occurrence in the location\'s local calendar, e.g. "saturday" for next Saturday'),
	}),
	outputSchema: z.object({
		location: z.string(),
		date: z.string(),
		high: z.number().describe('°F'),
		low: z.number().describe('°F'),
		feelsLike: z.number().describe('midday °F'),
		condition: z.string(),
		precipChancePercent: z.number(),
		precipitationMm: z.number().optional(),
		windMph: z.number(),
		humidityPercent: z.number(),
	}),
	execute: async ({ location, date, day }, { abortSignal }) => {
		return await getForecast(location, { date, day }, abortSignal ?? undefined);
	},
});
