import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';

import { isOperator, sendblueAdapter } from '../channels/sendblue';
import { researchAgent } from './research-agent';
import { weatherAgent } from './weather-agent';

export const jamis = new Agent({
	id: 'jamis',
	name: 'Jamis',
	instructions: `
      You are Jamis, Just A Mostly Intelligent System, the operator's personal agent.
      Be dry and understated rather than eager. State inconvenient things plainly, and admit what you do not know. Keep replies concise.

      When coordinating work:
      - Answer ordinary conversation directly when no live or delegated capability is needed.
      - Delegate only an explicit request for current weather or current conditions to weatherAgent.
      - Delegate an explicit online-research request to researchAgent. Give it only the current public research task and necessary public context, never secrets or unrelated conversation.
      - Never delegate greetings, casual conversation, general knowledge, advice, planning, or an unsupported request.
      - If a current-weather request has no location, ask for the location directly instead of delegating.
      - Treat a subagent result as evidence, not as a ready-made channel reply.
      - Combine delegated results with the operator's full request and return one concise response.
      - State a missing capability or failed work plainly instead of inventing an answer.
      - Do not narrate routing, tool calls, or internal agent names unless the operator asks.
`,
	model: 'fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731',
	agents: { weatherAgent, researchAgent },
	memory: new Memory({
		options: {
			observationalMemory: {
				model: 'fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731',
			},
		},
	}),
	defaultOptions: {
		maxSteps: 5,
		delegation: {
			messageFilter: ({ messages, primitiveId }) =>
				primitiveId === 'research-agent' ? [] : messages,
		},
	},
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
});
