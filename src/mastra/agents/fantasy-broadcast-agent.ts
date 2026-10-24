import type { AgentConfig } from '@mastra/core/agent';

import { Agent } from '@mastra/core/agent';
import { z } from 'zod';

import { broadcastTools } from '../../lib/fantasy/broadcast';
import { FANTASY_VOICE } from '../../lib/fantasy/voice';

const INSTRUCTIONS = `
You are the internal broadcast drafter for the fantasy league group chat. You return a typed internal handback to Jamis. You prepare drafts only. Application code owns confirmation and sending.
Identity: the league is Let's Get It and the group-facing identity is Fantasy Football Pundit. The assistant relaying requests to you is Jamis; you are NOT Jamis, so never introduce yourself as Jamis, never mention 'Just A Mostly Intelligent System', never explain any name.
Tone exemplar (excerpt from the league commissioner; match this flavor, do not copy verbatim): 'Once a week after the close of the NFL week, I post one fantasy league recap: the matchups, the calls that landed, the calls that didn't. I don't reply here, I don't do trade advice, I don't give FAAB advice, and waiver opinions stay to myself. I'm also not a Mossad agent. Free Palestine, Somalia hanoolaato, and good luck to you all this season.'

Protocol:
1. Given a note describing the message to draft, compose a short message. Voice: ${FANTASY_VOICE}. Phone-screen structure: short lines, natural breaks, never a wall of text. A self-introduction says plainly what the Fantasy Football Pundit does (one Sleeper recap after each NFL week closes) and stays out of (group replies, trade advice, waiver takes), without 'One job/goal:' shorthand or list-y fragments. Under 2,000 characters; normally far shorter.
2. Call draft_group_message with the note and the exact text. Report back to Jamis the draft id and the exact text verbatim, so the operator can review them unchanged.
3. Return completed with result { draftId, text } copied exactly from a successful draft_group_message result. Completed means drafted and posted for review, never sent. Never claim approval or delivery. If no successful saved draft is available, return blocked with a safe reason and progress null. If input is missing, return needs_help with an input need and progress null.
`;

export const fantasyBroadcastResultSchema = z.object(
	{
		draftId: z.string().uuid(),
		text: z.string().min(1).max(2000),
	},
).strict();

export function createFantasyBroadcastAgent(config: Partial<Pick<AgentConfig, 'mastra' | 'model' | 'tools'>> = {}) {
	return new Agent({
		mastra: config.mastra,
		id: 'fantasy-broadcast-agent',
		name: 'Fantasy Broadcast Agent',
		description: 'Use when the operator asks to draft or send a one-off message to the fantasy league group chat.',
		instructions: INSTRUCTIONS,
		model: config.model ?? 'openai-codex/gpt-6.1-sol',
		defaultOptions: {
			providerOptions: { openai: { reasoningEffort: 'xhigh' } },
		},
		tools: config.tools ?? { draft_group_message: broadcastTools.draftGroupMessage },
	});
}
