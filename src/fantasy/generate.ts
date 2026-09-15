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
export const FANTASY_GENERATOR_VERSION = 'fantasy-recap-v7';

/** Shipped recap model. One constant; edit this line to swap generators. */
export const DEFAULT_RECAP_MODEL = 'openai-codex/gpt-5.6-sol';

/** One chat line the model may callback into. */
export interface ChatContextMessage {
	/** Sendblue message handle; the only id the model may reference. */
	id: string;
	/** Sleeper display name resolved from the current manager map. */
	sender: string;
	text: string;
	/** Archived message time normalized to UTC. */
	createdAt: string;
}

const awardTakeSchema = z.string().trim().min(1).max(180).nullable();
const editorialSentenceSchema = z.object({
	text: z.string().trim().min(1).max(500),
	callbackMessageId: z.string().nullable(),
});

/** Model output is only flavor: facts are rendered from WeekFacts, never from the model. */
export const recapShapingSchema = z.object({
	awards: z.object({
		roughestWeek: awardTakeSchema,
		bestWeek: awardTakeSchema,
		mostEntertainingMatchup: awardTakeSchema,
		biggestBlowout: awardTakeSchema,
	}),
	/** Strongest story first so the renderer can remove the weakest whole paragraph. */
	editorial: z.array(z.object({
		sentences: z.array(editorialSentenceSchema).min(2).max(4),
	})).max(4),
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
		const userId = config.managerMap[senderNumber];
		const sender = userId && displayNameByUserId.get(userId);
		if (!sender)
			continue;
		if (out.length >= CHAT_CONTEXT_MAX_MESSAGES || chars + text.length > CHAT_CONTEXT_MAX_CHARS)
			break;
		chars += text.length;
		out.push({ id: message.id, sender, text, createdAt: message.createdAt.toISOString() });
	}
	return out.reverse(); // caller passes newest-first; model reads oldest-first
}

/** The one league-facing voice; recaps and broadcasts both speak as ibn Jamis. */
export const FANTASY_VOICE = `Style: plain prose, short declaratives, free of jargon and wordiness. Humor must be grounded in supplied facts or group-chat culture. Banned: em dashes, generic sports-announcer hype, AI self-reference, emojis, canned pleasantries, and media-theater cliches ('per the transaction wire', 'terms were not disclosed', 'analysts are calling it'). Identity: the group-facing persona is ibn Jamis (son of Jamis); never explain or unpack the name; claim only what it actually does.`;

const INSTRUCTIONS = `You are the Fantasy Agent: you shape a deterministic fantasy football weekly recap.
The renderer owns every number and award label. You may interpret only the supplied results, standings, movement, curated player facts, and archived group chat.
Your job is one optional short take for each fixed award plus an optional closing editorial about the week's biggest stories.

Hard rules:
- Never write numeric facts, as digits or words. Digits are allowed only when they are part of an exact supplied name.
- Base each award take only on its supplied result. Do not invent lineup mistakes, injuries, transactions, motives, or events.
- Return null for an award unless you have a genuinely funny, specific line. An unadorned fact is better than a forced joke.
- Be direct, conversational, and willing to be mean about that week's fantasy performance. Light profanity is allowed. Personal traits and real-life circumstances are not.
- Cut every disposable word. One or two short sentences maximum, with the strongest word or turn as late as natural.
- The renderer puts every manager name immediately before your take. Do not repeat, alter, or spell out a manager name.
- Find a distinct angle in the actual result. If the line would work equally well after swapping in another award or matchup, return null.
- Direct ridicule beats a decorative metaphor. Avoid stock constructions involving floors, basements, digging, paperwork, scenery, magnifying glasses, before-and-after photos, hostile takeovers, resignation letters, cautionary tales, or any close rewrite.
- Return zero to four editorial stories, strongest first. Return zero when nothing deserves a paragraph.
- Each story is one paragraph of two to four sentences. Use at most twelve editorial sentences and one hundred eighty editorial words total.
- Every story needs a distinct premise. Never restate a Highlight score, margin, award outcome, another story, callback, observation, or joke. Add interpretation, consequence, contrast, a curated player story, or genuinely useful chat context.
- Never force a conclusion, signoff, callback, joke, or fourth story. Humor is optional and never a quota.
- A callback sentence references only one supplied message id, uses the exact {speaker} placeholder once, and paraphrases rather than quotes the source. Never copy source wording or use quotation marks.
- Set callbackMessageId to null for every non-callback sentence.
- Use zero to four callbacks total, normally no more than one per story. Use two only when the exchange itself is the story.
- Timestamps are exact UTC evidence. Make pregame, live, or postgame chronology claims only when the supplied timestamp supports them.
- Order paragraphs by editorial importance because the renderer drops the last complete paragraph first when space is tight.
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
	const lines: string[] = [`League "${facts.leagueName}", week ${facts.week} (${facts.season}).`, 'Completed results:'];
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
		const closest = facts.closest ? facts.results.filter(r => r.margin === facts.closest!.margin) : [];
		lines.push(matchupSetKey(tied) === matchupSetKey(closest)
			? 'Biggest Blowout: omitted because it exactly duplicates Most Entertaining Matchup'
			: `Biggest Blowout: ${tied.map(r => `${r.a.displayName} ${r.aPoints} vs ${r.b.displayName} ${r.bPoints}`).join('; ')}, margin ${facts.blowout.margin}`);
	}
	if (facts.standings) {
		lines.push(`Standings after week ${facts.week}: ${facts.standings.map(row => `${row.rank}. ${row.team.displayName} ${row.wins}-${row.losses}${row.ties ? `-${row.ties}` : ''}, ${row.pointsFor} points`).join('; ')}`);
	}
	lines.push(facts.movement.length > 0
		? `Movement: ${facts.movement.map(move => `${move.team.displayName} from ${move.fromRank} to ${move.toRank}`).join('; ')}`
		: 'Movement: none');
	if (facts.playerStoryCandidates.length > 0) {
		lines.push('Curated player story candidates:');
		for (const candidate of facts.playerStoryCandidates) {
			lines.push(candidate.kind === 'top-starter'
				? `Top starter: ${candidate.player.name} (${candidate.player.position}) scored ${candidate.points} for ${candidate.team.displayName}`
				: `Bench flip: ${candidate.team.displayName} lost to ${candidate.opponent.displayName} by ${candidate.lossMargin}; ${candidate.benchedPlayer.name} scored ${candidate.benchedPoints} on the bench while same-position starter ${candidate.startedPlayer.name} scored ${candidate.startedPoints}, a ${candidate.pointSwing}-point swing`);
		}
	}
	return lines.join('\n');
}

function matchupSetKey(results: WeekFacts['results']): string {
	return results
		.map(result => [result.a.rosterId, result.b.rosterId].sort((a, b) => a - b).join(':'))
		.sort()
		.join('|');
}

export function buildRecapPrompt(facts: WeekFacts, context: ChatContextMessage[]): string {
	const eligible = context.filter(message => message.sender !== 'unknown sender');
	const chat = eligible.length > 0
		? eligible.map(m => `[${m.id}] ${m.createdAt} ${m.sender}: ${m.text}`).join('\n')
		: '(no mapped group-chat messages are eligible, use zero callbacks)';
	return `${factsSummary(facts)}\n\nArchived mapped group chat, oldest first, timestamps in UTC:\n${chat}\n\nReturn the shaping object only.`;
}

/** Validates the model stayed inside its lane. Throws ShapingValidationError otherwise. */
export function validateShaping(shaping: RecapShaping, context: ChatContextMessage[], facts: WeekFacts): RecapShaping {
	const parsed = recapShapingSchema.safeParse(shaping);
	if (!parsed.success)
		throw new ShapingValidationError('Model output did not match the editorial schema');
	const normalized: RecapShaping = {
		awards: {
			roughestWeek: normalizeProse(parsed.data.awards.roughestWeek),
			bestWeek: normalizeProse(parsed.data.awards.bestWeek),
			mostEntertainingMatchup: normalizeProse(parsed.data.awards.mostEntertainingMatchup),
			biggestBlowout: normalizeProse(parsed.data.awards.biggestBlowout),
		},
		editorial: parsed.data.editorial.map(story => ({
			sentences: story.sentences.map(sentence => ({ ...sentence, text: normalizeProse(sentence.text)! })),
		})),
	};
	const byId = new Map(context.map(m => [m.id, m]));
	const fields: Array<{ label: string; text: string | null; callbackMessageId: string | null; editorial: boolean }> = [
		{ label: 'roughestWeek', text: normalized.awards.roughestWeek, callbackMessageId: null, editorial: false },
		{ label: 'bestWeek', text: normalized.awards.bestWeek, callbackMessageId: null, editorial: false },
		{ label: 'mostEntertainingMatchup', text: normalized.awards.mostEntertainingMatchup, callbackMessageId: null, editorial: false },
		{ label: 'biggestBlowout', text: normalized.awards.biggestBlowout, callbackMessageId: null, editorial: false },
		...normalized.editorial.flatMap((story, storyIndex) => story.sentences.map((sentence, sentenceIndex) => ({
			label: `editorial story ${storyIndex + 1} sentence ${sentenceIndex + 1}`,
			text: sentence.text,
			callbackMessageId: sentence.callbackMessageId,
			editorial: true,
		}))),
	];
	const knownNames = suppliedNames(facts);
	const callbackIds = new Set<string>();
	let callbackCount = 0;
	let editorialWords = 0;
	for (const [storyIndex, story] of normalized.editorial.entries()) {
		const storyCallbacks = story.sentences.filter(sentence => sentence.callbackMessageId != null).length;
		if (storyCallbacks > 2)
			throw new ShapingValidationError(`Editorial story ${storyIndex + 1} has more than two callbacks`);
	}
	for (const field of fields) {
		const { label, text } = field;
		if (text == null)
			continue;
		if (/["“”«»]/.test(text))
			throw new ShapingValidationError(`${label} uses quotation marks; prose must paraphrase`);
		const digitCheck = field.editorial ? stripKnownNames(text, knownNames) : text;
		if (/\d/.test(digitCheck))
			throw new ShapingValidationError(`Digits are never allowed in ${label}; the renderer writes every number`);
		if (field.editorial && sentenceParts(text).length !== 1)
			throw new ShapingValidationError(`${label} must contain exactly one sentence`);

		let callbackSource: ChatContextMessage | null = null;
		const placeholders = text.split('{speaker}').length - 1;
		if (field.callbackMessageId) {
			callbackSource = byId.get(field.callbackMessageId) ?? null;
			if (!callbackSource)
				throw new ShapingValidationError(`Callback references unknown message id "${field.callbackMessageId}"`);
			if (callbackSource.sender === 'unknown sender')
				throw new ShapingValidationError(`Callback ${field.callbackMessageId} requires a known sender`);
			if (placeholders !== 1)
				throw new ShapingValidationError(`Callback ${field.callbackMessageId} requires one speaker placeholder`);
			if (callbackIds.has(field.callbackMessageId))
				throw new ShapingValidationError('Callback message ids must be unique');
			callbackIds.add(field.callbackMessageId);
			callbackCount += 1;
		}
		else if (placeholders > 0) {
			throw new ShapingValidationError(`${label} has a speaker placeholder without a callback message id`);
		}

		const tokens = words(text.replace('{speaker}', ''));
		for (const original of context) {
			const sourceTokens = words(original.text);
			const copiesShortSource = callbackSource?.id === original.id
				&& (sourceTokens.length === 1
					? tokens.length === 1 && tokens[0] === sourceTokens[0]
					: containsWords(tokens, sourceTokens));
			if (copiesShortSource || sharesPhrase(tokens, sourceTokens, 4)) {
				throw new ShapingValidationError(`${label} echoes archived chat verbatim; prose must paraphrase`);
			}
		}
		if (field.editorial) {
			const rendered = callbackSource ? text.replace('{speaker}', callbackSource.sender) : text;
			editorialWords += words(rendered).length;
		}
	}
	if (callbackCount > 4)
		throw new ShapingValidationError('Editorial may use at most four callbacks');
	const sentenceCount = normalized.editorial.reduce((sum, story) => sum + story.sentences.length, 0);
	if (sentenceCount > 12)
		throw new ShapingValidationError('Editorial may use at most twelve sentences');
	if (editorialWords > 180)
		throw new ShapingValidationError('Editorial may use at most one hundred eighty words');

	const seenSentences = new Set<string>();
	for (const field of fields) {
		if (!field.text)
			continue;
		for (const sentence of sentenceParts(field.text)) {
			const key = words(sentence).join(' ');
			if (key && seenSentences.has(key))
				throw new ShapingValidationError(`Model output repeated sentence in ${field.label}`);
			if (key)
				seenSentences.add(key);
		}
	}
	return normalized;
}

const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

function normalizeProse(text: string | null): string | null {
	if (text == null)
		return null;
	const normalized = text.trim().replace(/\s+/g, ' ');
	return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function sentenceParts(text: string): string[] {
	return [...sentenceSegmenter.segment(text)].map(part => part.segment.trim()).filter(Boolean);
}

function words(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function containsWords(haystack: string[], needle: string[]): boolean {
	return needle.length > 0 && haystack.some((_, index) => needle.every((word, offset) => haystack[index + offset] === word));
}

function sharesPhrase(a: string[], b: string[], length: number): boolean {
	if (a.length < length || b.length < length)
		return false;
	const phrases = new Set(a.slice(0, a.length - length + 1).map((_, index) => a.slice(index, index + length).join(' ')));
	return b.slice(0, b.length - length + 1).some((_, index) => phrases.has(b.slice(index, index + length).join(' ')));
}

function suppliedNames(facts: WeekFacts): string[] {
	const names = new Set(facts.results.flatMap(result => [result.a.displayName, result.b.displayName]));
	for (const candidate of facts.playerStoryCandidates) {
		names.add(candidate.team.displayName);
		if (candidate.kind === 'top-starter') {
			names.add(candidate.player.name);
		}
		else {
			names.add(candidate.opponent.displayName);
			names.add(candidate.benchedPlayer.name);
			names.add(candidate.startedPlayer.name);
		}
	}
	return [...names].sort((a, b) => b.length - a.length);
}

function stripKnownNames(text: string, names: string[]): string {
	return names.reduce((remaining, name) => remaining.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ''), text);
}
