import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';

import { isOperator, sendblueAdapter } from '../channels/sendblue';
import { weatherTool } from '../tools/weather-tool';

export const weatherAgent = new Agent({
	id: 'weather-agent',
	name: 'Weather Agent',
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
	channels: {
		adapters: {
			sendblue: {
				adapter: sendblueAdapter,
				toolDisplay: 'hidden',
				gateway: false,
			},
		},
		handlers: {
			onDirectMessage: async (thread, message, defaultHandler) => {
				if (!isOperator(message)) {
					return;
				}

				await defaultHandler(thread, message);
			},
			onMention: false,
			onSubscribedMessage: false,
		},
	},
	memory: new Memory({
		options: {
			observationalMemory: {
				model: 'fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731',
			},
		},
	}),
});
