import type { WeekFacts } from './analysis';
import type { ChatContextMessage, RecapShaping } from './generate';

export const RECAP_MAX_LENGTH = 2000;

export class RecapRenderError extends Error {}

/** Assembles the final recap text. Every number comes from facts; the model only lent flavor. */
export function renderWeekRecap(facts: WeekFacts, shaping: RecapShaping, context: ChatContextMessage[]): string {
	// Stories arrive strongest first, so fitting removes only the weakest whole paragraph.
	for (let editorial = shaping.editorial; ; editorial = editorial.slice(0, -1)) {
		const text = assemble(facts, { ...shaping, editorial }, context);
		if (text.length <= RECAP_MAX_LENGTH)
			return text;
		if (editorial.length === 0)
			throw new RecapRenderError(`Recap is ${text.length} chars even without editorial; Highlights alone overflow ${RECAP_MAX_LENGTH}`);
	}
}

function assemble(facts: WeekFacts, shaping: RecapShaping, context: ChatContextMessage[]): string {
	const byId = new Map(context.map(m => [m.id, m]));
	if (!facts.high || !facts.low || !facts.closest || !facts.blowout)
		throw new RecapRenderError('All four weekly awards require at least one scored matchup');

	const closestResults = facts.results.filter(r => r.margin === facts.closest!.margin);
	const blowoutResults = facts.results.filter(r => r.margin === facts.blowout!.margin);
	const closest = closestResults
		.map(r => `${r.a.displayName} ${r.aPoints}, ${r.b.displayName} ${r.bPoints}`)
		.join('; ');
	const blowouts = blowoutResults
		.map(r => `${r.a.displayName} ${r.aPoints}, ${r.b.displayName} ${r.bPoints}`)
		.join('; ');
	const take = (text: string | null) => text ? ` ${text.trim()}` : '';
	const lines: string[] = [
		`Week ${facts.week} Recap`,
		'',
		`- Roughest Week: ${facts.low.teams.map(t => t.displayName).join(', ')} (${facts.low.points} points).${take(shaping.awards.roughestWeek)}`,
		`- Best Week: ${facts.high.teams.map(t => t.displayName).join(', ')} (${facts.high.points} points).${take(shaping.awards.bestWeek)}`,
		`- Most Entertaining Matchup: ${closest} (${facts.closest.margin}-point margin).${take(shaping.awards.mostEntertainingMatchup)}`,
	];
	if (matchupSetKey(blowoutResults) !== matchupSetKey(closestResults))
		lines.push(`- Biggest Blowout: ${blowouts} (${facts.blowout.margin}-point margin).${take(shaping.awards.biggestBlowout)}`);

	for (const story of shaping.editorial) {
		const sentences = story.sentences.map((sentence) => {
			if (!sentence.callbackMessageId)
				return sentence.text.trim();
			const source = byId.get(sentence.callbackMessageId);
			if (!source)
				throw new RecapRenderError(`Editorial callback references unknown message id "${sentence.callbackMessageId}"`);
			return sentence.text.replace('{speaker}', source.sender).trim();
		});
		lines.push('', sentences.join(' '));
	}

	return lines.join('\n');
}

function matchupSetKey(results: WeekFacts['results']): string {
	return results
		.map(result => [result.a.rosterId, result.b.rosterId].sort((a, b) => a - b).join(':'))
		.sort()
		.join('|');
}
