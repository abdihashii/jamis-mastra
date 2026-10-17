import type { MatchupResult, ScoringExtreme, WeekFacts } from './analysis';
import type { ChatContextMessage, RecapShaping } from './generate';
import { managerReferences, resolveManagerReferences } from './generate';

export const RECAP_MAX_LENGTH = 2000;

export class RecapRenderError extends Error {}

export function renderResult(result: MatchupResult): string {
	const score = result.winner?.rosterId === result.b.rosterId
		? `${result.bPoints}–${result.aPoints}`
		: `${result.aPoints}–${result.bPoints}`;
	if (!result.winner)
		return `${result.a.displayName} ties ${result.b.displayName} (${score})`;
	return `${result.winner.displayName} def. ${result.loser!.displayName} (${score}, margin ${result.margin})`;
}

/** Assembles the final recap text. Every number comes from facts; the model only lent flavor. */
export function renderWeekRecap(facts: WeekFacts, shaping: RecapShaping, context: ChatContextMessage[]): string {
	// Stories arrive strongest first, so fitting removes only the weakest whole paragraph.
	for (let editorial = shaping.editorial; ; editorial = editorial.slice(0, -1)) {
		const text = assemble(facts, { ...shaping, editorial }, context);
		if (text.length <= RECAP_MAX_LENGTH)
			return text;
		if (editorial.length === 0)
			throw new RecapRenderError(`Recap is ${text.length} chars even without editorial; Awards alone overflow ${RECAP_MAX_LENGTH}`);
	}
}

function assemble(facts: WeekFacts, shaping: RecapShaping, context: ChatContextMessage[]): string {
	const byId = new Map(context.map(m => [m.id, m]));
	const references = managerReferences(facts);
	if (!facts.high || !facts.low || !facts.closest)
		throw new RecapRenderError('All three weekly awards require at least one scored matchup');

	const closestResults = facts.results.filter(r => r.margin === facts.closest!.margin);
	const closest = closestResults
		.map(r => `${r.a.displayName} ${r.aPoints}, ${r.b.displayName} ${r.bPoints}`)
		.join('; ');
	const lines: string[] = [
		`Week ${facts.week} recap:`,
		'',
		'Awards:',
		'',
		`• Manager of the Week: ${scoringContext(facts.high, facts)}.`,
		'',
		`• Loser of the Week: ${scoringContext(facts.low, facts)}.`,
		'',
		`• Match of the Week: ${closest} (${facts.closest.margin}-point margin).`,
	];
	if (shaping.editorial.length > 0)
		lines.push('', 'Stories of the Week:');

	for (const story of shaping.editorial) {
		const sentences = story.sentences.map((sentence) => {
			const text = resolveManagerReferences(sentence.text, references);
			if (!sentence.callbackMessageId)
				return text.trim();
			const source = byId.get(sentence.callbackMessageId);
			if (!source)
				throw new RecapRenderError(`Editorial callback references unknown message id "${sentence.callbackMessageId}"`);
			return resolveManagerReferences(sentence.text, references, source.sender).trim();
		});
		lines.push('', sentences.join(' '));
	}

	return lines.join('\n');
}

function scoringContext(award: ScoringExtreme, facts: WeekFacts): string {
	return award.teams.map((team) => {
		const result = facts.results.find(r => r.a.rosterId === team.rosterId || r.b.rosterId === team.rosterId);
		if (!result)
			throw new RecapRenderError(`Award roster ${team.rosterId} has no scored matchup`);
		const opponent = result.a.rosterId === team.rosterId ? result.b : result.a;
		const outcome = !result.winner ? 'tied' : result.winner.rosterId === team.rosterId ? 'won against' : 'lost to';
		return `${team.displayName} (${award.points} points, ${outcome} ${opponent.displayName})`;
	}).join('; ');
}
