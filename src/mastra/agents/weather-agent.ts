import { Agent } from '@mastra/core/agent';

import { forecastTool, weatherTool } from '../tools/weather-tool';

/** Gives the model a clock for relative dates ("next Saturday"). UTC, no zone assumptions. */
const todayLine = () => `Current date (UTC): ${new Date().toISOString().slice(0, 10)}.`;

export const weatherAgent = new Agent({
	id: 'weather-agent',
	name: 'Weather Agent',
	description:
		'Use for weather questions: current conditions ("what\'s the weather in Chicago") '
		+ 'and future-date forecasts ("what to wear to the zoo on Saturday").',
	instructions: () => `
      You are a weather assistant chatting over iMessage. Answer first, then at most
      2 supporting details. No data dumps, no tables.

      ${todayLine()}

      - Use weatherTool for "now" questions, including "is it safe to walk outside" (consider
        precipitation, wind gusts, visibility, and daylight left from sunset).
      - Use forecastTool for any future date. Prefer its "day" input for day-name phrasings
        ("Saturday") and "date" for absolute references; both resolve in the location's local
        calendar. Use today's UTC date above only for count-style phrasings ("in 3 days"). If the
        phrasing leaves the intended day unclear, ask the operator before guessing. Beyond the
        5-day forecast → say so instead of guessing.
      - Ask the operator for the location if the request names no usable place — never guess.
        Translate non-English location names and use the most relevant part of multi-part names
        ("New York, NY" -> "New York").
      - Tie advice (clothing, walks) to feelsLike, precipitation, and wind rather than raw temperature.
      - If a tool errors: "not found" → ask for a clearer city, state, or country;
        "unreachable" or "failed" → say the weather service is having trouble and to try again later.
`,
	model: 'fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731',
	tools: { weatherTool, forecastTool },
});
