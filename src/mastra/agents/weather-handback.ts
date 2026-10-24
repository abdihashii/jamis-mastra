import { z } from 'zod';

import type { SpecialistHandback } from './specialist-handback';

const text = z.string().min(1);
const forecastSchema = z.object({
	kind: z.literal('forecast'),
	location: text,
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	high: z.number(),
	low: z.number(),
	feelsLike: z.number(),
	condition: text,
	precipChancePercent: z.number().min(0).max(100),
	precipitationMm: z.number().nonnegative().nullable(),
	windMph: z.number().nonnegative(),
	humidityPercent: z.number().min(0).max(100),
}).strict();
const currentSchema = z.object({
	kind: z.literal('current'),
	location: text,
	country: text,
	localTime: text,
	temperature: z.number(),
	feelsLike: z.number(),
	condition: text,
	isDay: z.boolean(),
	precipitationMmPerHour: z.number().nonnegative().nullable(),
	windMph: z.number().nonnegative(),
	gustMph: z.number().nonnegative().nullable(),
	visibilityMiles: z.number().nonnegative().nullable(),
	humidityPercent: z.number().min(0).max(100),
	sunrise: text,
	sunset: text,
}).strict();

export const weatherResultSchema = z.object({
	answer: text,
	reading: z.discriminatedUnion('kind', [currentSchema, forecastSchema]),
}).strict();

export function validateWeatherHandback(
	handback: SpecialistHandback<z.infer<typeof weatherResultSchema>>,
	{ toolResults }: {
		toolResults: Array<{ payload: { toolName: string; result: unknown; args?: unknown; isError?: boolean } }>;
	},
) {
	const result = 'result' in handback ? handback.result : handback.progress;
	if (!result)
		return;
	const { kind, ...reading } = result.reading;
	const toolName = kind === 'forecast' ? 'forecastTool' : 'weatherTool';
	const verified = toolResults.some(({ payload }) => {
		const requestedDate = z.object({ date: z.string() }).safeParse(payload.args);
		return payload.toolName === toolName && !payload.isError && payload.result && typeof payload.result === 'object'
			&& (kind !== 'forecast' || !requestedDate.success || requestedDate.data.date === result.reading.date)
			&& Object.entries(reading).every(
				([key, value]) => ((payload.result as Record<string, unknown>)[key] ?? null) === value,
			);
	});
	const opening = `The weather in ${reading.location}`;
	if (!verified || !result.answer.startsWith(opening) || !/^[\s.,:!?]/.test(result.answer.slice(opening.length)))
		throw new Error('Weather handback does not match retrieved conditions.');
}
