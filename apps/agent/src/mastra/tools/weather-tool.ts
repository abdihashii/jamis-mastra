import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

export const weatherTool = createTool({
  id: 'get-weather',
  description: 'Get current weather for a location',
  inputSchema: z.object({
    location: z.string().describe('City name'),
  }),
  outputSchema: z.object({
    output: z.string(),
  }),
  execute: async ({ location }) => {
    return {
      output: `The weather in ${location} is sunny`,
    }
  },
})
