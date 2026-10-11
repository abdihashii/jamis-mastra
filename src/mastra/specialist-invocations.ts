import type { AgentConfig } from '@mastra/core/agent';

import { z } from 'zod';

import { createFantasyBroadcastAgent, fantasyBroadcastResultSchema } from './agents/fantasy-broadcast-agent';
import { createPersonalAccountsAgent, personalAccountsTools } from './agents/personal-accounts-agent';
import { personalAccountsModelHandbackSchema, personalAccountsResultSchema, resolvePersonalAccountsHandback, validatePersonalAccountsHandback } from './agents/personal-accounts-handback';
import { createResearchAgent } from './agents/research-agent';
import { researchResultSchema, validateResearchHandback } from './agents/research-handback';
import { createResearchQuestionProjector, publicFareLabels, researchQuestionSchema } from './agents/research-question';
import { createWeatherAgent, weatherTools } from './agents/weather-agent';
import { validateWeatherHandback, weatherResultSchema } from './agents/weather-handback';
import { currentLinearProposalId, withoutLinearProposalTurn } from './channels/sendblue';
import { createSpecialistInvocation } from './tools/invoke-specialist';

type SpecialistOverrides = Partial<Pick<AgentConfig, 'model' | 'tools'>>;
export interface SpecialistConfig {
	fantasyBroadcast?: SpecialistOverrides;
	weather?: SpecialistOverrides;
	research?: SpecialistOverrides;
	personalAccounts?: SpecialistOverrides;
}

const assignmentSchema = z.object({
	question: z.string().trim().min(1).max(4000).describe('Bounded assignment. For clarification, include the original task and the actual missing input; reuse validated prior contributions.'),
	continueClarification: z.boolean().optional().describe('True only when the current reply answers this specialist\'s immediately preceding active-session input need. Otherwise omit; unrelated requests supersede that need. Unavailable continuation returns a gap, not permission to retry Research as a new task.'),
}).strict();

export function createSpecialistTools(mastra: AgentConfig['mastra'], config: SpecialistConfig = {}) {
	const research = createResearchAgent({ ...config.research, mastra });
	const publicQuestion = createResearchQuestionProjector(publicFareLabels);
	const invokeResearch = createSpecialistInvocation({
		id: 'invoke_research',
		agent: research,
		inputSchema: researchQuestionSchema,
		resultSchema: researchResultSchema,
		allowedCallers: [{ kind: 'agent', id: 'jamis' }, { kind: 'agent', id: 'weather-agent' }, { kind: 'agent', id: 'personal-accounts-agent' }],
		continueClarification: input => input.kind === 'clarification',
		project: (input, { caller, operatorRequest, clarification }) => {
			if (input.kind === 'clarification' && clarification?.publicAssignment && operatorRequest)
				return `Original public research task:\n${clarification.publicAssignment}\n\nResearch asked:\n${clarification.need.question}\n\nOperator clarification:\n${operatorRequest}`;
			if (input.kind !== 'operator_request')
				return publicQuestion(input);
			// This is the Operator's current public task, never a model rewrite or a private-text sanitizer.
			return caller.kind === 'agent' && caller.id === 'jamis' && operatorRequest?.trim()
				? operatorRequest
				: { case: 'blocked', reason: 'Only Jamis can submit the current Operator research request. Private-to-public questions require a supported public-label template.', progress: null };
		},
		run: withoutLinearProposalTurn,
		validate: validateResearchHandback,
	});
	const weather = createWeatherAgent({
		...config.weather,
		mastra,
		tools: async context => ({
			...typeof config.weather?.tools === 'function' ? await config.weather.tools(context) : config.weather?.tools ?? weatherTools,
			invoke_research: invokeResearch,
		}),
	});
	const accounts = createPersonalAccountsAgent({
		...config.personalAccounts,
		mastra,
		tools: async context => ({
			...typeof config.personalAccounts?.tools === 'function' ? await config.personalAccounts.tools(context) : config.personalAccounts?.tools ?? personalAccountsTools,
			invoke_research: invokeResearch,
		}),
	});
	return {
		invoke_fantasy_broadcast: createSpecialistInvocation({
			id: 'invoke_fantasy_broadcast',
			agent: createFantasyBroadcastAgent({ ...config.fantasyBroadcast, mastra }),
			inputSchema: assignmentSchema,
			resultSchema: fantasyBroadcastResultSchema,
			allowedCallers: [{ kind: 'agent', id: 'jamis' }],
			continueClarification: input => input.continueClarification === true,
			project: input => input.question,
			validate: (handback, { toolResults }) => {
				const result = handback.case === 'completed' || handback.case === 'partial' ? handback.result : handback.progress;
				if (result && !toolResults.some(({ payload }) => {
					const saved = z.object({ ok: z.literal(true), draftId: z.string(), text: z.string() }).safeParse(payload.result);
					return payload.toolName === 'draft_group_message' && saved.success && saved.data.draftId === result.draftId && saved.data.text === result.text;
				})) {
					throw new Error('Fantasy handback does not match a saved reviewed draft.');
				}
			},
		}),
		invoke_weather: createSpecialistInvocation({
			id: 'invoke_weather',
			agent: weather,
			inputSchema: assignmentSchema,
			resultSchema: weatherResultSchema,
			allowedCallers: [{ kind: 'agent', id: 'jamis' }],
			continueClarification: input => input.continueClarification === true,
			project: input => input.question,
			validate: validateWeatherHandback,
		}),
		invoke_research: invokeResearch,
		invoke_personal_accounts: createSpecialistInvocation({
			id: 'invoke_personal_accounts',
			agent: accounts,
			inputSchema: assignmentSchema,
			resultSchema: personalAccountsResultSchema,
			modelHandback: { schema: personalAccountsModelHandbackSchema, resolve: resolvePersonalAccountsHandback },
			allowedCallers: [{ kind: 'agent', id: 'jamis' }],
			continueClarification: input => input.continueClarification === true,
			project: input => input.question,
			pendingOperationId: currentLinearProposalId,
			validate: validatePersonalAccountsHandback,
		}),
	};
}
