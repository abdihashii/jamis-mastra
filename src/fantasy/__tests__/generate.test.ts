import type { WeekFacts } from '../analysis';
import type { ChatContextMessage, RecapShaping } from '../generate';
import type { RecapGenerationRecord, SqlLike } from '../recaps';

import type { SleeperManager } from '../sleeper';

import { describe, expect, it } from 'bun:test';
import { toPlainText } from 'chat-adapter-sendblue';
import { parseFantasyConfig } from '../config';
import { buildRecapPrompt, FANTASY_GENERATOR_VERSION, recapShapingSchema, toChatContext, validateShaping } from '../generate';
import { listGenerations, recordClaimedGeneration, recordGeneration } from '../recaps';
import { RECAP_MAX_LENGTH, RecapRenderError, renderWeekRecap } from '../render';

const config = parseFantasyConfig({
	FANTASY_SENDBLUE_GROUP_ID: 'g1',
	FANTASY_SLEEPER_LEAGUE_ID: '111',
	FANTASY_MANAGER_MAP: '{"+15550001111":"u1","+15550002222":"u2"}',
	FANTASY_RECAP_TIMEZONE: 'America/Chicago',
})!;

const managers: SleeperManager[] = [
	{ rosterId: 1, userId: 'u1', displayName: 'alpha' },
	{ rosterId: 2, userId: 'u2', displayName: 'bravo' },
];

function dbMessage(id: string, senderNumber: string, text: string) {
	return {
		id,
		role: 'user' as const,
		createdAt: new Date('2026-09-01T00:00:00Z'),
		threadId: 'fantasy-group-g1',
		resourceId: 'fantasy-group-g1',
		content: { format: 2 as const, parts: text ? [{ type: 'text' as const, text }] : [], metadata: { senderNumber } },
	};
}

const context: ChatContextMessage[] = [
	{ id: 'm1', sender: 'alpha', text: 'bravo is cooked this week', createdAt: '2026-09-01T00:00:00.000Z' },
	{ id: 'm2', sender: 'bravo', text: 'been workshopping plays all night', createdAt: '2026-09-01T01:00:00.000Z' },
];

function factsStub(overrides: Partial<WeekFacts> = {}): WeekFacts {
	const alpha = { rosterId: 1, userId: 'u1', displayName: 'alpha' };
	const bravo = { rosterId: 2, userId: 'u2', displayName: 'bravo' };
	const result = {
		a: alpha,
		b: bravo,
		aPoints: 120.5,
		bPoints: 97.25,
		margin: 23.25,
		winner: alpha,
		loser: bravo,
	};
	return {
		leagueId: '111',
		leagueName: 'Test League',
		season: '2026',
		week: 2,
		isPlayoffWeek: false,
		isChampionshipWeek: false,
		results: [result],
		high: { teams: [alpha], points: 120.5 },
		low: { teams: [bravo], points: 97.25 },
		closest: result,
		blowout: result,
		standings: [
			{ rank: 1, team: alpha, wins: 2, losses: 0, ties: 0, pointsFor: 250.5 },
			{ rank: 2, team: bravo, wins: 0, losses: 2, ties: 0, pointsFor: 187.25 },
		],
		movement: [{ team: alpha, fromRank: 2, toRank: 1 }],
		upcoming: [{ a: bravo, b: alpha }],
		playerStoryCandidates: [],
		...overrides,
	};
}

function shapingOf(overrides: Partial<RecapShaping> = {}): RecapShaping {
	return {
		editorial: [],
		...overrides,
	};
}

describe('toChatContext', () => {
	it('resolves mapped senders to display names and keeps order oldest-first', () => {
		// newest-first input, as listMessages returns it
		const messages = [dbMessage('m2', '+15550002222', 'been workshopping'), dbMessage('m1', '+15550001111', 'bravo is cooked')];
		expect(toChatContext(messages, config, managers)).toEqual([
			{ id: 'm1', sender: 'alpha', text: 'bravo is cooked', createdAt: '2026-09-01T00:00:00.000Z' },
			{ id: 'm2', sender: 'bravo', text: 'been workshopping', createdAt: '2026-09-01T00:00:00.000Z' },
		]);
	});

	it('removes unmapped senders from the model context', () => {
		const messages = [dbMessage('m9', '+19999999999', 'who dis')];
		expect(toChatContext(messages, config, managers)).toEqual([]);
	});

	it('skips empty texts and bounds the pool at 200 messages', () => {
		const messages = [dbMessage('m0', '+15550001111', '')];
		expect(toChatContext(messages, config, managers)).toEqual([]);
		const many = Array.from({ length: 250 }, (_, i) => dbMessage(`m${i}`, '+15550001111', `msg ${i}`));
		expect(toChatContext(many, config, managers)).toHaveLength(200);
	});

	it('stops adding context once 20k characters are banked', () => {
		const big = 'y'.repeat(9_000);
		const messages = [
			dbMessage('m3', '+15550001111', big),
			dbMessage('m2', '+15550001111', big),
			dbMessage('m1', '+15550001111', big), // excluded: 9k+9k+9k would exceed the 20k char budget
		];
		const out = toChatContext(messages, config, managers);
		expect(out.map(m => m.id)).toEqual(['m2', 'm3']);
		expect(out.reduce((sum, m) => sum + m.text.length, 0)).toBeLessThanOrEqual(20_000);
	});
});

describe('validateShaping', () => {
	it('accepts a clean shaping with no editorial', () => {
		expect(validateShaping(shapingOf(), context, factsStub())).toEqual(shapingOf());
	});

	it('rejects callbacks outside the pool or without the speaker placeholder', () => {
		const bad = shapingOf({ editorial: [{ sentences: [
			{ text: 'The result settled the issue.', callbackMessageId: null },
			{ text: '{speaker} lost the argument by Sunday.', callbackMessageId: 'nope' },
		] }] });
		expect(() => validateShaping(bad, context, factsStub())).toThrow(/unknown message id/);
		const missingPlaceholder = shapingOf({ editorial: [{ sentences: [
			{ text: 'The result settled the issue.', callbackMessageId: null },
			{ text: 'The prediction aged badly.', callbackMessageId: 'm1' },
		] }] });
		expect(() => validateShaping(missingPlaceholder, context, factsStub())).toThrow(/speaker placeholder/);
	});

	it('rejects duplicate callback ids and quotation marks', () => {
		const duplicate = shapingOf({ editorial: [{ sentences: [
			{ text: '{speaker} made the prediction early.', callbackMessageId: 'm1' },
			{ text: '{speaker} watched it collapse later.', callbackMessageId: 'm1' },
		] }] });
		expect(() => validateShaping(duplicate, context, factsStub())).toThrow(/unique/);
		const quoted = shapingOf({ editorial: [{ sentences: [
			{ text: 'The chat called it “easy” before kickoff.', callbackMessageId: null },
			{ text: 'Sunday supplied the correction.', callbackMessageId: null },
		] }] });
		expect(() => validateShaping(quoted, context, factsStub())).toThrow(/quotation marks/);
	});

	it('rejects copied short sources and meaningful phrase overlap', () => {
		const shortContext = [{ id: 'm3', sender: 'alpha', text: 'called it', createdAt: '2026-09-01T02:00:00.000Z' }];
		const copied = shapingOf({ editorial: [{ sentences: [
			{ text: '{speaker} called it before kickoff.', callbackMessageId: 'm3' },
			{ text: 'The result made that confidence relevant.', callbackMessageId: null },
		] }] });
		expect(() => validateShaping(copied, shortContext, factsStub())).toThrow(/verbatim/);
		const overlap = shapingOf({ editorial: [{ sentences: [
			{ text: 'The group had been workshopping plays all night.', callbackMessageId: null },
			{ text: 'The final score ended the workshop.', callbackMessageId: null },
		] }] });
		expect(() => validateShaping(overlap, context, factsStub())).toThrow(/verbatim/);
	});

	it('normalizes sentences and rejects exact repetition', () => {
		const clean = shapingOf({ editorial: [{ sentences: [
			{ text: '  The matchup changed   the week  ', callbackMessageId: null },
			{ text: '{speaker} supplied the early confidence', callbackMessageId: 'm1' },
		] }] });
		expect(validateShaping(clean, context, factsStub()).editorial[0].sentences).toEqual([
			{ text: 'The matchup changed the week.', callbackMessageId: null },
			{ text: '{speaker} supplied the early confidence.', callbackMessageId: 'm1' },
		]);
		const repeated = shapingOf({ editorial: [{ sentences: [
			{ text: 'The matchup changed the week.', callbackMessageId: null },
			{ text: 'The matchup changed the week.', callbackMessageId: null },
		] }] });
		expect(() => validateShaping(repeated, context, factsStub())).toThrow(/repeated sentence/);
	});

	it('enforces the editorial sentence and word budgets', () => {
		const story = (prefix: string) => ({ sentences: Array.from({ length: 4 }, (_, i) => ({
			text: `${prefix} sentence ${String.fromCharCode(97 + i)} adds a distinct thought.`,
			callbackMessageId: null,
		})) });
		const tooMany = shapingOf({ editorial: [story('First'), story('Second'), story('Third'), story('Fourth')] });
		expect(() => validateShaping(tooMany, context, factsStub())).toThrow(/twelve sentences/);
		const wordy = shapingOf({ editorial: [{ sentences: [
			{ text: `${'word '.repeat(95)}ends.`, callbackMessageId: null },
			{ text: `${'more '.repeat(95)}ends.`, callbackMessageId: null },
		] }] });
		expect(() => validateShaping(wordy, context, factsStub())).toThrow(/one hundred eighty words/);
	});

	it('rejects digits anywhere in model fields; the renderer owns numbers outright', () => {
		const facts = factsStub();
		const numbered = shapingOf({ editorial: [{ sentences: [
			{ text: 'The workshop produced 97 points of nothing.', callbackMessageId: null },
			{ text: 'The week moved on.', callbackMessageId: null },
		] }] });
		expect(() => validateShaping(numbered, context, facts)).toThrow(/[Dd]igits/);
		facts.results[0].a.displayName = 'alpha1';
		const exactName = shapingOf({ editorial: [{ sentences: [
			{ text: 'alpha1 changed the shape of the week.', callbackMessageId: null },
			{ text: 'The rest of the league now has a real problem.', callbackMessageId: null },
		] }] });
		expect(() => validateShaping(exactName, context, facts)).toThrow(/manager name/);
	});

	it('rejects verbatim chat in non-callback stories while allowing short generic phrases', () => {
		const story = (text: string) => shapingOf({ editorial: [{ sentences: [
			{ text, callbackMessageId: null },
			{ text: 'The result supplied the correction.', callbackMessageId: null },
		] }] });
		expect(() => validateShaping(story('The group had been workshopping plays all night.'), context, factsStub())).toThrow(/echoes archived chat/);
		expect(validateShaping(story('{manager:2} is cooked.'), context, factsStub()).editorial[0].sentences[0].text).toBe('{manager:2} is cooked.');
	});

	it('resolves single and multiple manager subjects with callbacks and digit-bearing names', () => {
		const facts = factsStub();
		facts.results[0].a.displayName = 'alpha1';
		const shaping = shapingOf({ editorial: [{ sentences: [
			{ text: '{manager:1} dominated while {manager:2} struggled.', callbackMessageId: null },
			{ text: '{speaker} backed {manager:1} before kickoff.', callbackMessageId: 'm2' },
		] }] });
		const validated = validateShaping(shaping, context, facts);
		const rendered = renderWeekRecap(facts, validated, context);
		expect(rendered).toContain('alpha1 dominated while bravo struggled. bravo backed alpha1 before kickoff.');
		expect(rendered).not.toMatch(/\{manager:|\{speaker\}/);
	});

	it('rejects unknown and malformed manager references and digits outside valid tokens', () => {
		for (const token of ['{manager:99}', '{manager:01}', '{manager:x}', '{manager: 1}', '{manager:1', '{manager}', '{Manager:1}', '{manager:1}}', '{{manager:1}}']) {
			const shaping = shapingOf({ editorial: [{ sentences: [
				{ text: `${token} dominated.`, callbackMessageId: null },
				{ text: 'The win was emphatic.', callbackMessageId: null },
			] }] });
			expect(() => validateShaping(shaping, [], factsStub())).toThrow(/manager reference/);
		}
		const numbered = shapingOf({ editorial: [{ sentences: [
			{ text: '{manager:1} won by 23.', callbackMessageId: null },
			{ text: 'The result was emphatic.', callbackMessageId: null },
		] }] });
		expect(() => validateShaping(numbered, [], factsStub())).toThrow(/Digits/);
		expect(() => renderWeekRecap(factsStub(), shapingOf({ editorial: [{ sentences: [
			{ text: '{manager:99} dominated.', callbackMessageId: null },
			{ text: 'The result was emphatic.', callbackMessageId: null },
		] }] }), [])).toThrow(/manager reference/);
	});

	it('rejects direct supplied names without matching fragments of ordinary words', () => {
		const story = (text: string) => shapingOf({ editorial: [{ sentences: [
			{ text, callbackMessageId: null },
			{ text: 'The result was emphatic.', callbackMessageId: null },
		] }] });
		expect(() => validateShaping(story('ALPHA dominated.'), [], factsStub())).toThrow(/manager name/);
		expect(() => validateShaping(story('bravo\'s lineup struggled.'), [], factsStub())).toThrow(/manager name/);
		expect(() => validateShaping(story('The alphabet offers no explanation.'), [], factsStub())).not.toThrow();
		const symbolFacts = factsStub();
		symbolFacts.results[0].a.displayName = '🔥';
		expect(() => validateShaping(story('🔥 dominated.'), [], symbolFacts)).toThrow(/manager name/);
		symbolFacts.results[0].a.displayName = 'a.b $&';
		expect(() => validateShaping(story('a.b $& dominated.'), [], symbolFacts)).toThrow(/manager name/);
	});

	it('includes supplied subjects outside completed matchups in the reference map', () => {
		const facts = factsStub();
		facts.standings!.push({ rank: 3, team: { rosterId: 3, userId: 'u3', displayName: 'charlie' }, wins: 0, losses: 0, ties: 0, pointsFor: 0 });
		expect(buildRecapPrompt(facts, [])).toContain('{manager:3}: charlie');
		const shaping = shapingOf({ editorial: [{ sentences: [
			{ text: '{manager:3} remains in contention.', callbackMessageId: null },
			{ text: 'The standings leave room to move.', callbackMessageId: null },
		] }] });
		expect(renderWeekRecap(facts, validateShaping(shaping, [], facts), [])).toContain('charlie remains in contention.');
	});

	it('checks archived phrase copying after resolving manager references', () => {
		const shaping = shapingOf({ editorial: [{ sentences: [
			{ text: '{manager:2} is cooked this week.', callbackMessageId: null },
			{ text: 'The result was emphatic.', callbackMessageId: null },
		] }] });
		expect(() => validateShaping(shaping, context, factsStub())).toThrow(/verbatim/);
	});

	it('preserves literal replacement characters and placeholders inside supplied names', () => {
		const facts = factsStub();
		facts.results[0].a.displayName = 'alpha $& {speaker}';
		const shaping = shapingOf({ editorial: [{ sentences: [
			{ text: '{speaker} backed {manager:1}.', callbackMessageId: 'm2' },
			{ text: '{manager:1} dominated.', callbackMessageId: null },
		] }] });
		expect(renderWeekRecap(facts, validateShaping(shaping, context, facts), context)).toContain('bravo backed alpha $& {speaker}. alpha $& {speaker} dominated.');
	});

	it('trims whole stories after manager references expand', () => {
		const facts = factsStub();
		facts.results[0].a.displayName = 'a'.repeat(150);
		const shaping = shapingOf({ editorial: ['dominated', 'impressed', 'excelled', 'thrived'].map(verb => ({ sentences: [
			{ text: `{manager:1} ${verb} while {manager:2} struggled.`, callbackMessageId: null },
			{ text: `{manager:1} ${verb} across the lineup.`, callbackMessageId: null },
		] })) });
		const validated = validateShaping(shaping, [], facts);
		const rendered = renderWeekRecap(facts, validated, []);
		expect(rendered.length).toBeLessThanOrEqual(RECAP_MAX_LENGTH);
		expect(rendered).toContain('dominated across the lineup.');
		expect(rendered).not.toContain('thrived');
		expect(rendered).not.toContain('{manager:');
	});

	it('counts editorial words after manager name substitution', () => {
		const facts = factsStub();
		facts.results[0].a.displayName = 'a '.repeat(90).trim();
		const shaping = shapingOf({ editorial: [{ sentences: [
			{ text: '{manager:1} dominated.', callbackMessageId: null },
			{ text: '{manager:1} earned the win.', callbackMessageId: null },
		] }] });
		expect(() => validateShaping(shaping, [], facts)).toThrow(/one hundred eighty words/);
	});

	it('includes complete facts and timestamped mapped chat in the prompt', () => {
		const player = { id: 'p1', name: 'Player One', position: 'RB' };
		const prompt = buildRecapPrompt(factsStub({
			playerStoryCandidates: [{ kind: 'top-starter', team: factsStub().results[0].a, player, points: 31.5 }],
		}), context);
		expect(prompt).toContain('{manager:1}: alpha');
		expect(prompt).toContain('{manager:2}: bravo');
		expect(prompt).toContain('Standings after week');
		expect(prompt).toContain('Movement:');
		expect(prompt).toContain('Top starter: Player One');
		expect(prompt).toContain('[m1] 2026-09-01T00:00:00.000Z alpha: bravo is cooked this week');
		expect(buildRecapPrompt(factsStub(), [...context, { ...context[0], id: 'm9', sender: 'unknown sender' }])).not.toContain('[m9]');
	});

	it('requires two to four sentences per story at the schema boundary', () => {
		expect(recapShapingSchema.safeParse(shapingOf({ editorial: [{ sentences: [
			{ text: 'Only one sentence.', callbackMessageId: null },
		] }] })).success).toBe(false);
	});
});

describe('renderWeekRecap', () => {
	it('renders the exact facts-only awards and omits the empty Stories section', () => {
		const facts = factsStub({ blowout: null });
		const text = renderWeekRecap(facts, shapingOf(), context);
		expect(text).toBe([
			'Week 2 recap:',
			'',
			'Awards:',
			'',
			'• Manager of the Week: alpha (120.5 points, won against bravo).',
			'',
			'• Loser of the Week: bravo (97.25 points, lost to alpha).',
			'',
			'• Match of the Week: alpha 120.5, bravo 97.25 (23.25-point margin).',
		].join('\n'));
		expect(toPlainText(text)).toBe(text);
		expect(Object.keys(recapShapingSchema.shape)).toEqual(['editorial']);
	});

	it('omits the displayed blowout while keeping its facts in the prompt', () => {
		const facts = factsStub();
		const charlie = { rosterId: 3, userId: 'u3', displayName: 'charlie' };
		const delta = { rosterId: 4, userId: 'u4', displayName: 'delta' };
		const blowout = { a: charlie, b: delta, aPoints: 140, bPoints: 80, margin: 60, winner: charlie, loser: delta };
		facts.results.push(blowout);
		facts.blowout = blowout;
		expect(renderWeekRecap(facts, shapingOf(), context)).not.toContain('Biggest Blowout');
		expect(buildRecapPrompt(facts, context)).toContain('Biggest Blowout facts: charlie 140 vs delta 80, margin 60');
		expect(buildRecapPrompt(factsStub(), context)).toContain('Biggest Blowout facts: alpha 120.5 vs bravo 97.25, margin 23.25');
	});

	it('renders Stories with deterministic callback attribution', () => {
		const shaping = shapingOf({ editorial: [{ sentences: [
			{ text: 'The matchup turned the week into a real contest.', callbackMessageId: null },
			{ text: '{speaker} supplied confidence that the result did not repay.', callbackMessageId: 'm2' },
		] }] });
		const text = renderWeekRecap(factsStub(), shaping, context);
		expect(text).not.toContain('been workshopping plays all night');
		expect(text).toContain('\n\nThe matchup turned the week into a real contest. bravo supplied confidence that the result did not repay.');
		expect(text).not.toContain('Editorial');
		expect(text).toContain('\n\nStories of the Week:\n\n');
	});

	it('drops the weakest complete paragraph to stay under the length cap', () => {
		const long = 'team'.repeat(40);
		const alpha = { rosterId: 1, userId: 'u1', displayName: `${long}a` };
		const bravo = { rosterId: 2, userId: 'u2', displayName: `${long}b` };
		const result = { a: alpha, b: bravo, aPoints: 120.5, bPoints: 97.25, margin: 23.25, winner: alpha, loser: bravo };
		const facts = factsStub({ results: [result], high: { teams: [alpha], points: 120.5 }, low: { teams: [bravo], points: 97.25 }, closest: result, blowout: result });
		const story = (marker: string, fill: string) => ({
			sentences: [
				{ text: `${marker} ${fill.repeat(170)}.`, callbackMessageId: null },
				{ text: `${fill.repeat(170)} closes ${marker}.`, callbackMessageId: null },
			],
		});
		const withEditorial = shapingOf({
			editorial: [story('strongest', 'x'), story('middle', 'y'), story('weakest', 'z')],
		});
		const text = renderWeekRecap(facts, withEditorial, context);
		expect(text.length).toBeLessThanOrEqual(RECAP_MAX_LENGTH);
		expect(text).toContain(`${long}a 120.5`);
		expect(text).toContain('strongest');
		expect(text).not.toContain('weakest');
	});

	it('throws when facts alone overflow the envelope', () => {
		const long = 'team'.repeat(300);
		const alpha = { rosterId: 1, userId: 'u1', displayName: `${long}a` };
		const bravo = { rosterId: 2, userId: 'u2', displayName: `${long}b` };
		const result = { a: alpha, b: bravo, aPoints: 120.5, bPoints: 97.25, margin: 23.25, winner: alpha, loser: bravo };
		const facts = factsStub({ results: [result], high: { teams: [alpha], points: 120.5 }, low: { teams: [bravo], points: 97.25 }, closest: result, blowout: result });
		expect(() => renderWeekRecap(facts, shapingOf(), context)).toThrow(RecapRenderError);
	});

	it('renders all matchups tied for a weekly matchup award', () => {
		const facts = factsStub();
		const charlie = { rosterId: 3, userId: 'u3', displayName: 'charlie' };
		const delta = { rosterId: 4, userId: 'u4', displayName: 'delta' };
		facts.results.push({ a: charlie, b: delta, aPoints: 110, bPoints: 86.75, margin: 23.25, winner: charlie, loser: delta });
		const text = renderWeekRecap(facts, shapingOf(), context);
		expect(text).toContain('alpha 120.5, bravo 97.25; charlie 110, delta 86.75');
	});

	it('preserves tied high/low scorers and tied closest matches without inventing wins or losses', () => {
		const facts = factsStub();
		const [alpha, bravo] = [facts.results[0].a, facts.results[0].b];
		const charlie = { rosterId: 3, userId: 'u3', displayName: 'charlie' };
		const delta = { rosterId: 4, userId: 'u4', displayName: 'delta' };
		const highTie = { a: alpha, b: bravo, aPoints: 120, bPoints: 120, margin: 0, winner: null, loser: null };
		const lowTie = { a: charlie, b: delta, aPoints: 80, bPoints: 80, margin: 0, winner: null, loser: null };
		Object.assign(facts, {
			results: [highTie, lowTie],
			high: { teams: [alpha, bravo], points: 120 },
			low: { teams: [charlie, delta], points: 80 },
			closest: highTie,
			blowout: highTie,
		});
		const text = renderWeekRecap(facts, shapingOf(), []);
		expect(text).toContain('Manager of the Week: alpha (120 points, tied bravo); bravo (120 points, tied alpha).');
		expect(text).toContain('Loser of the Week: charlie (80 points, tied delta); delta (80 points, tied charlie).');
		expect(text).toContain('Match of the Week: alpha 120, bravo 120; charlie 80, delta 80 (0-point margin).');
		expect(text).not.toMatch(/won|lost|Stories/);
	});

	it('accepts and renders four stories in importance order', () => {
		const shaping = shapingOf({ editorial: ['First', 'Second', 'Third', 'Fourth'].map(marker => ({ sentences: [
			{ text: `${marker} story adds a distinct interpretation.`, callbackMessageId: null },
			{ text: `${marker} premise earns its place here.`, callbackMessageId: null },
		] })) });
		const validated = validateShaping(shaping, context, factsStub());
		const text = renderWeekRecap(factsStub(), validated, context);
		expect(text.split('\n\nStories of the Week:\n\n')[1].split('\n\n')).toEqual([
			...validated.editorial.map(story => story.sentences.map(sentence => sentence.text).join(' ')),
		]);
		expect(text.length).toBeLessThanOrEqual(RECAP_MAX_LENGTH);
	});

	it('omits the Stories heading when every whole paragraph must be removed', () => {
		const shaping = shapingOf({ editorial: [{ sentences: [
			{ text: `${'x'.repeat(1800)}.`, callbackMessageId: null },
			{ text: 'A closing thought.', callbackMessageId: null },
		] }] });
		expect(renderWeekRecap(factsStub(), shaping, [])).toBe(renderWeekRecap(factsStub(), shapingOf(), []));
	});
});

describe('generation records', () => {
	/** Tagged-template shim capturing every interpolation argument. */
	function sqlShim(rows: unknown[] = []) {
		const calls: Array<{ strings: TemplateStringsArray; values: unknown[] }> = [];
		const sql: SqlLike = ((strings: TemplateStringsArray, ...values: unknown[]) => {
			calls.push({ strings, values });
			return Promise.resolve(rows);
		}) as SqlLike;
		return { calls, sql };
	}

	it('records a rerun with a new generator version as new history, not an overwrite', async () => {
		const { calls, sql } = sqlShim();
		const base: RecapGenerationRecord = {
			leagueId: '111',
			fantasyWeek: 2,
			generatorVersion: FANTASY_GENERATOR_VERSION,
			model: 'test-model',
			finalText: 'text v1',
			facts: factsStub(),
		};
		await recordGeneration(base, sql);
		await recordGeneration({ ...base, generatorVersion: `${FANTASY_GENERATOR_VERSION}+prompt2`, finalText: 'text v2' }, sql);
		expect(calls).toHaveLength(2);
		expect(calls[0].strings.join('')).toContain('ON CONFLICT (league_id, fantasy_week, generator_version, model)');
		const [v1Args, v2Args] = calls.map(c => c.values);
		expect(v1Args[2]).toBe(FANTASY_GENERATOR_VERSION);
		expect(v2Args[2]).toBe(`${FANTASY_GENERATOR_VERSION}+prompt2`);
		expect(v1Args[0]).toBe(v2Args[0]); // same league/week — history, not replacement
	});

	it('records live generation only while its delivery claim is active', async () => {
		const { calls, sql } = sqlShim([{}]);
		const record: RecapGenerationRecord = {
			leagueId: '111',
			fantasyWeek: 2,
			generatorVersion: FANTASY_GENERATOR_VERSION,
			model: 'test-model',
			finalText: 'text v1',
			facts: factsStub(),
		};

		expect(await recordClaimedGeneration(record, 'claim-1', sql)).toBe(true);
		expect(calls[0].strings.join('')).toContain('status = \'started\' AND claim_token =');
		expect(calls[0].strings.join('')).toContain('FROM claimed');
	});

	it('creates the table with the version-history primary key', async () => {
		const { calls, sql } = sqlShim();
		await (await import('../recaps')).ensureFantasyRecapsTable(sql);
		expect(calls[0].strings.join(' ')).toContain('PRIMARY KEY (league_id, fantasy_week, generator_version, model)');
	});

	it('lists generations for a league/week', async () => {
		const { sql } = sqlShim([{ generator_version: 'v1', model: 'm', final_text: 't', created_at: 'c', updated_at: 'u' }]);
		const rows = await listGenerations('111', 2, sql);
		expect(rows).toHaveLength(1);
		expect(rows[0].generator_version).toBe('v1');
	});
});
