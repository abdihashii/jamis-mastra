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
		const data = await response.json();

		return {
			location,
			temperatureCelcius: Number(data.current_condition[0].temp_C),
			conditions: data.current_condition[0].weatherDesc[0].value,
		};
	},
});
