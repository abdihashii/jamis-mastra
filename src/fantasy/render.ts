import type { WeekFacts } from './analysis';
import type { ChatContextMessage, RecapShaping } from './generate';

export const RECAP_MAX_LENGTH = 2000;

export class RecapRenderError extends Error {}

/** Assembles the final recap text. Every number comes from facts; the model only lent flavor. */
export function renderWeekRecap(facts: WeekFacts, shaping: RecapShaping, context: ChatContextMessage[]): string {
	// Fit the budget by sacrificing callbacks first; facts never get trimmed.
	for (let callbacks = shaping.callbacks; ; callbacks = callbacks.slice(0, -1)) {
		const text = assemble(facts, { ...shaping, callbacks }, context);
		if (text.length <= RECAP_MAX_LENGTH)
			return text;
		if (callbacks.length === 0)
			throw new RecapRenderError(`Recap is ${text.length} chars even without callbacks; facts alone overflow ${RECAP_MAX_LENGTH}`);
	}
}

function assemble(facts: WeekFacts, shaping: RecapShaping, context: ChatContextMessage[]): string {
	const byId = new Map(context.map(m => [m.id, m]));
	if (!facts.high || !facts.low || !facts.closest || !facts.blowout)
		throw new RecapRenderError('All four weekly awards require at least one scored matchup');

	const closest = facts.results
		.filter(r => r.margin === facts.closest!.margin)
		.map(r => `${r.a.displayName} ${r.aPoints}, ${r.b.displayName} ${r.bPoints}`)
		.join('; ');
	const blowouts = facts.results
		.filter(r => r.margin === facts.blowout!.margin)
		.map(r => `${r.a.displayName} ${r.aPoints}, ${r.b.displayName} ${r.bPoints}`)
		.join('; ');
	const take = (text: string | null) => text ? ` ${text.trim()}` : '';
	const lines: string[] = [
		`Week ${facts.week} Recap`,
		'',
		`- Roughest Week: ${facts.low.teams.map(t => t.displayName).join(', ')} (${facts.low.points} points).${take(shaping.awards.roughestWeek)}`,
		`- Best Week: ${facts.high.teams.map(t => t.displayName).join(', ')} (${facts.high.points} points).${take(shaping.awards.bestWeek)}`,
		`- Most Entertaining Matchup: ${closest} (${facts.closest.margin}-point margin).${take(shaping.awards.mostEntertainingMatchup)}`,
		`- Biggest Blowout: ${blowouts} (${facts.blowout.margin}-point margin).${take(shaping.awards.biggestBlowout)}`,
	];

	for (const callback of shaping.callbacks) {
		if (byId.has(callback.messageId))
			lines.push('', callback.take.trim());
	}

	return lines.join('\n');
}
