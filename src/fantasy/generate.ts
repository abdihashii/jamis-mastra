import type { MastraDBMessage } from '@mastra/core/memory';
import type { WeekFacts } from './analysis';
import type { FantasyConfig } from './config';

import type { SleeperManager } from './sleeper';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';

/**
 * Bump when the prompt or output contract changes. A generation row is keyed
 * by (league, week, version, model), so a new version lands as history rather
 * than an overwrite of the old rendering.
 */
export const FANTASY_GENERATOR_VERSION = 'fantasy-recap-v6';

/** Shipped recap model. One constant; edit this line to swap generators. */
export const DEFAULT_RECAP_MODEL = 'openai-codex/gpt-5.6-sol';

/** One chat line the model may callback into. */
export interface ChatContextMessage {
	/** Sendblue message handle; the only id the model may reference. */
	id: string;
	/** Sleeper display name, or 'unknown sender' when unmapped. */
	sender: string;
	text: string;
}

const awardTakeSchema = z.string().min(1).max(180).nullable();

/** Model output is only flavor: facts are rendered from WeekFacts, never from the model. */
export const recapShapingSchema = z.object({
	awards: z.object({
		roughestWeek: awardTakeSchema,
		bestWeek: awardTakeSchema,
		mostEntertainingMatchup: awardTakeSchema,
		biggestBlowout: awardTakeSchema,
	}),
	/** Callbacks into archived group chat. Zero callbacks is always valid. */
	callbacks: z
		.array(
			z.object({
				messageId: z.string(),
				/** Paraphrase or reaction; never a verbatim copy of the message. */
				take: z.string().max(160),
			}),
		)
		.max(3),
});

export type RecapShaping = z.infer<typeof recapShapingSchema>;

export class ShapingValidationError extends Error {}

const CHAT_CONTEXT_MAX_MESSAGES = 200;
const CHAT_CONTEXT_MAX_CHARS = 20_000;

/**
 * Maps archived thread messages into callback-eligible context. Manager lookup
 * happens here (not at ingest) so a mapping change fixes old messages too.
 */
export function toChatContext(
	messages: MastraDBMessage[],
	config: FantasyConfig,
	managers: SleeperManager[],
): ChatContextMessage[] {
	const displayNameByUserId = new Map(managers.map(m => [m.userId, m.displayName]));
	const out: ChatContextMessage[] = [];
	let chars = 0;
	for (const message of messages) {
		const metadata = (message.content.metadata ?? {}) as Record<string, unknown>;
		const senderNumber = typeof metadata.senderNumber === 'string' ? metadata.senderNumber : null;
		const parts = Array.isArray(message.content.parts) ? message.content.parts : [];
		const text = parts
			.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
			.map(p => p.text)
			.join(' ')
			.trim();
		if (!senderNumber || !text)
			continue;
		if (out.length >= CHAT_CONTEXT_MAX_MESSAGES || chars + text.length > CHAT_CONTEXT_MAX_CHARS)
			break;
		chars += text.length;
		const userId = config.managerMap[senderNumber];
		out.push({ id: message.id, sender: (userId && displayNameByUserId.get(userId)) || 'unknown sender', text });
	}
	return out.reverse(); // caller passes newest-first; model reads oldest-first
}

/** The one league-facing voice; recaps and broadcasts both speak as ibn Jamis. */
export const FANTASY_VOICE = `Style: plain prose, short declaratives, free of jargon and wordiness. Humor must be grounded in supplied facts or group-chat culture. Banned: em dashes, generic sports-announcer hype, AI self-reference, emojis, canned pleasantries, and media-theater cliches ('per the transaction wire', 'terms were not disclosed', 'analysts are calling it'). Identity: the group-facing persona is ibn Jamis (son of Jamis); never explain or unpack the name; claim only what it actually does.`;

const INSTRUCTIONS = `You are the Fantasy Agent: you flavor a deterministic fantasy football weekly recap.
You never state scores, records, rankings, or any other fact. The deterministic renderer owns every number and every award label.
Your job is one short satirical take for each fixed award, plus optional reactions to archived group-chat messages.

Hard rules:
- Never write digits. The renderer writes every number.
- Base each award take only on its supplied result. Do not invent lineup mistakes, injuries, transactions, motives, or events.
- Return null for an award unless you have a genuinely funny, specific line. An unadorned fact is better than a forced joke.
- Be direct, conversational, and willing to be mean about that week's fantasy performance. Light profanity is allowed. Personal traits and real-life circumstances are not.
- Cut every disposable word. One or two short sentences maximum, with the strongest word or turn as late as natural.
- The renderer puts every manager name immediately before your take. Do not repeat, alter, or spell out a manager name.
- Find a distinct angle in the actual result. If the line would work equally well after swapping in another award or matchup, return null.
- Direct ridicule beats a decorative metaphor. Avoid stock constructions involving floors, basements, digging, paperwork, scenery, magnifying glasses, before-and-after photos, hostile takeovers, resignation letters, cautionary tales, or any close rewrite.
- Callbacks reference ONLY message ids from the provided context list. Your "take" is a reaction or paraphrase, never a verbatim copy.
- Use a callback only when the original message already supplies a funny premise and the new context improves it. Otherwise use zero callbacks.
- Voice: ${FANTASY_VOICE}
`;

export function createFantasyAgent(model: string): Agent {
	return new Agent({
		id: 'fantasy-agent',
		name: 'Fantasy Agent',
		instructions: INSTRUCTIONS,
		model,
		// providerOptions are namespaced; models from other providers ignore the openai block.
		defaultOptions: { providerOptions: { openai: { reasoningEffort: 'xhigh' } } },
	});
}

function factsSummary(facts: WeekFacts): string {
	const lines: string[] = [`League "${facts.leagueName}", week ${facts.week} (${facts.season}).`];
	for (const result of facts.results) {
		const pair = `${result.a.displayName} ${result.aPoints} vs ${result.b.displayName} ${result.bPoints}`;
		lines.push(result.winner ? `${result.winner.displayName} def. ${result.loser!.displayName} (${pair})` : `${pair}, tie`);
	}
	if (facts.high)
		lines.push(`Best Week: ${facts.high.teams.map(t => t.displayName).join(', ')} at ${facts.high.points}`);
	if (facts.low)
		lines.push(`Roughest Week: ${facts.low.teams.map(t => t.displayName).join(', ')} at ${facts.low.points}`);
	if (facts.closest) {
		const tied = facts.results.filter(r => r.margin === facts.closest!.margin);
		lines.push(`Most Entertaining Matchup: ${tied.map(r => `${r.a.displayName} ${r.aPoints} vs ${r.b.displayName} ${r.bPoints}`).join('; ')}, margin ${facts.closest.margin}`);
	}
	if (facts.blowout) {
		const tied = facts.results.filter(r => r.margin === facts.blowout!.margin);
		lines.push(`Biggest Blowout: ${tied.map(r => `${r.a.displayName} ${r.aPoints} vs ${r.b.displayName} ${r.bPoints}`).join('; ')}, margin ${facts.blowout.margin}`);
	}
	return lines.join('\n');
}

export function buildRecapPrompt(facts: WeekFacts, context: ChatContextMessage[]): string {
	const chat = context.length > 0
		? context.map(m => `[${m.id}] ${m.sender}: ${m.text}`).join('\n')
		: '(the group chat was quiet this week — use zero callbacks)';
	return `${factsSummary(facts)}\n\nArchived group chat (callback pool):\n${chat}\n\nReturn the shaping object only.`;
}

/** Validates the model stayed inside its lane. Throws ShapingValidationError otherwise. */
export function validateShaping(shaping: RecapShaping, context: ChatContextMessage[], _facts: WeekFacts): RecapShaping {
	const byId = new Map(context.map(m => [m.id, m]));

	// Every model field: zero digits (renderer owns numbers outright) and, once long
	// enough to be cargo, never a verbatim echo of archived chat (either direction).
	const freeTextFields: Array<[string, string | null]> = [
		['roughestWeek', shaping.awards.roughestWeek],
		['bestWeek', shaping.awards.bestWeek],
		['mostEntertainingMatchup', shaping.awards.mostEntertainingMatchup],
		['biggestBlowout', shaping.awards.biggestBlowout],
		...shaping.callbacks.map((c): [string, string] => [`callback ${c.messageId}`, c.take]),
	];
	for (const [label, text] of freeTextFields) {
		if (text == null)
			continue;
		const normalized = text.trim().toLowerCase();
		if (/\d/.test(normalized))
			throw new ShapingValidationError(`Digits are never allowed in ${label}; the renderer writes every number`);
		if (normalized.length < 20)
			continue;
		for (const original of context) {
			const quoted = original.text.trim().toLowerCase();
			if (quoted.length >= 20 && (quoted.includes(normalized) || normalized.includes(quoted))) {
				throw new ShapingValidationError(`${label} echoes archived chat verbatim; prose must paraphrase`);
			}
		}
	}

	for (const callback of shaping.callbacks) {
		if (!byId.has(callback.messageId))
			throw new ShapingValidationError(`Callback references unknown message id "${callback.messageId}"`);
	}
	return shaping;
}
