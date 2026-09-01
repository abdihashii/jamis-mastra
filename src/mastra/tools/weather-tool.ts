import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { fetchJson } from '../../lib/fetch';
import { geocodeQueries, zipQuery } from '../../lib/geocode';
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

export interface LatLon {
	lat: number;
	lon: number;
}

/** A place to fetch weather for: a query string ("Mundelein, IL", "60060") or coordinates. */
export type Where = string | LatLon;

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
	name?: string;
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
	city: { timezone: number; name?: string; };
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
	const zip = zipQuery(location);
	if (zip) {
		const res = await fetchJson(`${openWeatherBaseUrl}/geo/1.0/zip?zip=${zip.zip},${zip.country}&appid=${openWeatherApiKey}`, signal);
		if (!res.ok) {
			throw serviceError(`zip geocoding for "${location}"`, res.status);
		}
		const z = res.json as Partial<GeoResult> | null;
		if (z && typeof z.lat === 'number' && typeof z.lon === 'number') {
			return { name: z.name ?? zip.zip, state: z.state, country: z.country ?? zip.country, lat: z.lat, lon: z.lon };
		}
		throw new Error(`Location "${location}" not found. Try a city, "City, CC", a ZIP, or coordinates.`);
	}

	for (const q of geocodeQueries(location)) {
		const url = `${openWeatherBaseUrl}/geo/1.0/direct?q=${encodeURIComponent(q)}&limit=1&appid=${openWeatherApiKey}`;
		const res = await fetchJson(url, signal);
		if (!res.ok) {
			throw serviceError(`geocoding for "${location}"`, res.status);
		}
		if (Array.isArray(res.json) && res.json.length > 0) {
			const { name, state, country, lat, lon } = res.json[0];
			return { name, state, country, lat, lon };
		}
	}

	throw new Error(`Location "${location}" not found. Try a city, "City, CC", a ZIP, or coordinates.`);
}

export async function getCurrentWeather(where: Where, signal?: AbortSignal): Promise<CurrentWeatherConditions> {
	const label = typeof where === 'string' ? where : `${where.lat},${where.lon}`;
	const fromText = typeof where === 'string' ? await geocode(where, signal) : null;
	const { lat, lon } = fromText ?? (where as LatLon);
	const url = `${openWeatherBaseUrl}/data/2.5/weather?lat=${lat}&lon=${lon}&units=imperial&appid=${openWeatherApiKey}`;
	const res = await fetchJson(url, signal);

	if (!res.ok) {
		throw serviceError(`current weather for "${label}"`, res.status);
	}

	const w = res.json as CurrentWeatherResult | null;
	if (!w?.main) {
		throw unusableData(`current weather for "${label}"`);
	}

	const rain1h = w.rain?.['1h'] ?? 0;
	const snow1h = w.snow?.['1h'] ?? 0;

	return {
		location: fromText
			? (fromText.state ? `${fromText.name}, ${fromText.state}` : fromText.name)
			: (w.name?.trim() || `${lat.toFixed(2)}, ${lon.toFixed(2)}`),
		country: fromText?.country ?? w.sys?.country ?? '',
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
	where: Where,
	ref: { date?: string; day?: string },
	signal?: AbortSignal,
): Promise<ForecastSummary> {
	if ((ref.date === undefined) === (ref.day === undefined)) {
		throw new Error('Pass exactly one of date ("YYYY-MM-DD") or day ("saturday").');
	}
	if (ref.date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(ref.date) || Number.isNaN(Date.parse(ref.date)))) {
		throw new Error(`Invalid date "${ref.date}". Use a real calendar date as YYYY-MM-DD.`);
	}

	const label = typeof where === 'string' ? where : `${where.lat},${where.lon}`;
	const fromText = typeof where === 'string' ? await geocode(where, signal) : null;
	const { lat, lon } = fromText ?? (where as LatLon);
	const url = `${openWeatherBaseUrl}/data/2.5/forecast?lat=${lat}&lon=${lon}&units=imperial&appid=${openWeatherApiKey}`;
	const res = await fetchJson(url, signal);

	if (!res.ok) {
		throw serviceError(`forecast for "${label}"`, res.status);
	}

	const data = res.json as ForecastResult | null;
	if (!Array.isArray(data?.list) || typeof (data as ForecastResult).city?.timezone !== 'number') {
		throw unusableData(`forecast for "${label}"`);
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
		location: fromText
			? (fromText.state ? `${fromText.name}, ${fromText.state}` : fromText.name)
			: (data.city.name?.trim() || `${lat.toFixed(2)}, ${lon.toFixed(2)}`),
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

function toWhere(location: string | undefined, lat: number | undefined, lon: number | undefined): Where {
	if (location !== undefined && (lat !== undefined || lon !== undefined)) {
		throw new Error('Pass either location or lat/lon, not both.');
	}
	if (location === undefined && (lat === undefined || lon === undefined)) {
		throw new Error('Pass a location string, or both lat and lon.');
	}
	return location ?? { lat: lat!, lon: lon! };
}

export const weatherTool = createTool({
	id: 'weather-tool',
	description:
    'Current weather conditions for a location. '
    + 'Use for "now" questions like "what\'s the weather" or "is it safe to walk outside".',
	inputSchema: z.object({
		location: z.string().optional().describe('City name, e.g. "Chicago" or "Paris, FR"'),
		lat: z.number().min(-90).max(90).optional().describe('Latitude, when the operator gives coordinates'),
		lon: z.number().min(-180).max(180).optional().describe('Longitude, when the operator gives coordinates'),
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
	execute: async ({ location, lat, lon }, { abortSignal }) => {
		return await getCurrentWeather(toWhere(location, lat, lon), abortSignal ?? undefined);
	},
});

export const forecastTool = createTool({
	id: 'forecast-tool',
	description:
    'Weather forecast for a location on a future date, up to 5 days out. '
    + 'Use for questions like "what should we wear to the zoo on Saturday". '
    + 'Prefer day for day-name phrasing ("Saturday") and date for absolute references.',
	inputSchema: z.object({
		location: z.string().optional().describe('City name, e.g. "Chicago" or "Paris, FR"'),
		lat: z.number().min(-90).max(90).optional().describe('Latitude, when the operator gives coordinates'),
		lon: z.number().min(-180).max(180).optional().describe('Longitude, when the operator gives coordinates'),
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
	execute: async ({ location, lat, lon, date, day }, { abortSignal }) => {
		return await getForecast(toWhere(location, lat, lon), { date, day }, abortSignal ?? undefined);
	},
});
