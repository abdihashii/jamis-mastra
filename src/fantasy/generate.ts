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
export const FANTASY_GENERATOR_VERSION = 'fantasy-recap-v5';

/**
 * Shipped default recap model. Precedence: --model flag > FANTASY_RECAP_MODEL > this.
 * (The overrides exist only for the voice A/B window; see scripts/fantasy-recap.ts.)
 */
export const DEFAULT_RECAP_MODEL = 'openai-codex/gpt-5.6-sol';

/** One chat line the model may callback into. */
export interface ChatContextMessage {
	/** Sendblue message handle; the only id the model may reference. */
	id: string;
	/** Sleeper display name, or 'unknown sender' when unmapped. */
	sender: string;
	text: string;
}

/** Model output is only flavor: facts are rendered from WeekFacts, never from the model. */
export const recapShapingSchema = z.object({
	/** Punchy one-liner. No numbers that are not in the facts. */
	headline: z.string().max(200),
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
	/** Upcoming-matchup index to spotlight, or null to skip. */
	spotlightIndex: z.number().int().nonnegative().nullable(),
	signoff: z.string().max(160),
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
export const FANTASY_VOICE = `Style: plain prose, short declaratives, free of jargon and wordiness. Humor: optional and rare, landing on the league, its rituals, and the group's culture (callbacks prized), never on a manager's play. Banned: em dashes, '[name] here.' openings, media-theater cliches ('per the transaction wire', 'terms were not disclosed', 'analysts are calling it'), canned pleasantries. Identity: the group-facing persona is ibn Jamis (son of Jamis); never explain or unpack the name; claim only what it actually does.`;

const INSTRUCTIONS = `You are the Fantasy Agent: you flavor a deterministic fantasy football weekly recap.
You never state scores, records, rankings, or any other fact — the deterministic renderer owns every number, and writes the "Week N" prefix itself.
Your job is only the surrounding voice: a punchy headline, reactions to archived group-chat messages, one spotlight pick among the week's upcoming matchups, and a signoff.

Hard rules:
- Never write digits. Not a score, not a record, not a week number: no digits in headline, takes, or signoff (enforced).
- Callbacks reference ONLY message ids from the provided context list. Your "take" is a reaction or paraphrase, never a verbatim copy.
- Zero callbacks is always valid, especially when the chat was quiet or off-topic.
- Spotlight picks a provided upcoming matchup index, or null when none is worth hyping.
- Voice: ${FANTASY_VOICE}

Shape exemplar (match this flavor, do not copy verbatim):
- headline: half the league won on Sunday; the other half filed for an internal review.
- callback take (someone typed "I am never starting him again"): week-one vow. Filed.
- signoff: new week starts when the NFL says so, not when the group chat declares it.`;

export function createFantasyAgent(model: string): Agent {
	return new Agent({
		id: 'fantasy-agent',
		name: 'Fantasy Agent',
		instructions: INSTRUCTIONS,
		model,
		// OpenAI-backed models benefit from explicit effort; others ignore nothing here because providers differ -- apply only for openai-codex.
		defaultOptions: model.startsWith('openai-codex/')
			? { providerOptions: { openai: { reasoningEffort: 'xhigh' } } }
			: undefined,
	});
}

function factsSummary(facts: WeekFacts): string {
	const lines: string[] = [`League "${facts.leagueName}", week ${facts.week} (${facts.season}).`];
	for (const result of facts.results) {
		const pair = `${result.a.displayName} ${result.aPoints} vs ${result.b.displayName} ${result.bPoints}`;
		lines.push(result.winner ? `${result.winner.displayName} def. ${result.loser!.displayName} (${pair})` : `${pair}, tie`);
	}
	if (facts.high)
		lines.push(`High: ${facts.high.teams.map(t => t.displayName).join(', ')} at ${facts.high.points}`);
	if (facts.low)
		lines.push(`Low: ${facts.low.teams.map(t => t.displayName).join(', ')} at ${facts.low.points}`);
	if (facts.standings) {
		for (const row of facts.standings) lines.push(`Standings ${row.rank}. ${row.team.displayName} ${row.wins}-${row.losses}-${row.ties}, ${row.pointsFor} pts`);
	}
	if (facts.upcoming)
		facts.upcoming.forEach((u, i) => lines.push(`Upcoming[${i}]: ${u.a.displayName} vs ${u.b.displayName}`));
	return lines.join('\n');
}

export function buildRecapPrompt(facts: WeekFacts, context: ChatContextMessage[]): string {
	const chat = context.length > 0
		? context.map(m => `[${m.id}] ${m.sender}: ${m.text}`).join('\n')
		: '(the group chat was quiet this week — use zero callbacks)';
	return `${factsSummary(facts)}\n\nArchived group chat (callback pool):\n${chat}\n\nReturn the shaping object only.`;
}

/** Validates the model stayed inside its lane. Throws ShapingValidationError otherwise. */
export function validateShaping(shaping: RecapShaping, context: ChatContextMessage[], facts: WeekFacts): RecapShaping {
	const byId = new Map(context.map(m => [m.id, m]));

	// Every model field: zero digits (renderer owns numbers outright) and, once long
	// enough to be cargo, never a verbatim echo of archived chat (either direction).
	const freeTextFields: Array<[string, string]> = [
		['headline', shaping.headline],
		['signoff', shaping.signoff],
		...shaping.callbacks.map((c): [string, string] => [`callback ${c.messageId}`, c.take]),
	];
	for (const [label, text] of freeTextFields) {
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
	if (shaping.spotlightIndex != null) {
		const upcoming = facts.upcoming ?? [];
		if (shaping.spotlightIndex >= upcoming.length)
			throw new ShapingValidationError(`Spotlight index ${shaping.spotlightIndex} is out of bounds for ${upcoming.length} upcoming matchups`);
	}
	return shaping;
}
