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
	const move = new Map(facts.movement.map(m => [m.team.rosterId, m]));

	const lines: string[] = [`Week ${facts.week} — ${shaping.headline.trim()}`, ''];

	for (const result of facts.results) {
		const pair = `${result.a.displayName} ${result.aPoints}-${result.b.displayName} ${result.bPoints}`;
		lines.push(result.winner
			? `${result.winner.displayName} def. ${result.loser!.displayName} (${pair})`
			: `Tie: ${pair}`);
	}
	lines.push('');
	if (facts.high)
		lines.push(`High scorer: ${facts.high.teams.map(t => t.displayName).join(', ')} (${facts.high.points})`);
	if (facts.low)
		lines.push(`Low scorer: ${facts.low.teams.map(t => t.displayName).join(', ')} (${facts.low.points})`);
	if (facts.closest && resultsAreDistinct(facts.results))
		lines.push(`Closest: ${facts.closest.a.displayName} vs ${facts.closest.b.displayName}, margin ${facts.closest.margin}`);
	if (facts.blowout && resultsAreDistinct(facts.results))
		lines.push(`Blowout: ${facts.blowout.a.displayName} vs ${facts.blowout.b.displayName}, margin ${facts.blowout.margin}`);

	if (facts.standings) {
		lines.push('', 'Standings:');
		for (const row of facts.standings) {
			const moved = move.get(row.team.rosterId);
			const arrow = moved ? moved.toRank < moved.fromRank ? ' ▲' : ' ▼' : '';
			const record = row.ties > 0 ? `${row.wins}-${row.losses}-${row.ties}` : `${row.wins}-${row.losses}`;
			lines.push(`${row.rank}. ${row.team.displayName} (${record}, ${row.pointsFor} pts)${arrow}`);
		}
	}

	for (const callback of shaping.callbacks) {
		if (byId.has(callback.messageId))
			lines.push('', callback.take.trim());
	}

	if (shaping.spotlightIndex != null && facts.upcoming?.[shaping.spotlightIndex]) {
		const spotlight = facts.upcoming[shaping.spotlightIndex];
		lines.push('', `Watch next week: ${spotlight.a.displayName} vs ${spotlight.b.displayName}`);
	}

	lines.push('', shaping.signoff.trim());
	return lines.join('\n');
}

/** All-tie weeks make "closest" and "blowout" the same matchup, which reads as noise. */
function resultsAreDistinct(results: WeekFacts['results']): boolean {
	return new Set(results.map(r => r.margin)).size > 1;
}
