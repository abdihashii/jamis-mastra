import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const weatherTool = createTool({
	id: 'weather-tool',
	description: 'Fetches weather for a location',
	inputSchema: z.object({
		location: z.string().describe('Location name'),
	}),
	outputSchema: z.object({
		location: z.string(),
		temperatureCelcius: z.number(),
		conditions: z.string(),
	}),
	execute: async ({ location }, { abortSignal }) => {
		const response = await fetch(`https://wttr.in/${location}?format=j1`, {
			signal: abortSignal,
		});

		if (!response.ok) {
			throw new Error(`Weather lookup for "${location}" failed: wttr.in returned ${response.status}.`);
		}

		// wttr.in answers 200 with a plain-text error body for locations it cannot
		// resolve, so the parse and the shape both have to be checked.
		const data = await response.json().catch(() => null);
		const current = data?.current_condition?.[0];
		const temperatureCelcius = Number(current?.temp_C);

		if (!current || !Number.isFinite(temperatureCelcius)) {
			throw new Error(`No weather data for "${location}". Try a city name like "Berlin".`);
		}

		return {
			location,
			temperatureCelcius,
			conditions: current.weatherDesc?.[0]?.value ?? 'Unknown',
		};
	},
});
