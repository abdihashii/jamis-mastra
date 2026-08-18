import { Agent } from '@mastra/core/agent';

import { weatherTool } from '../tools/weather-tool';

export const weatherAgent = new Agent({
	id: 'weather-agent',
	name: 'Weather Agent',
	description:
		'Use for current weather or current conditions for a requested location. It uses wttr.in through weatherTool for live weather data and returns concise current conditions.',
	instructions: `
      You are a helpful weather assistant that provides accurate weather information.

      Your primary function is to help users get weather details for specific locations. When responding:
      - Always ask for a location if none is provided
      - If the location name isn't in English, please translate it
      - If giving a location with multiple parts (e.g. "New York, NY"), use the most relevant part (e.g. "New York")
      - Include relevant details like humidity, wind conditions, and precipitation
      - Keep responses concise but informative

      Use the weatherTool to fetch current weather data.
`,
	model: 'fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731',
	tools: { weatherTool },
});
