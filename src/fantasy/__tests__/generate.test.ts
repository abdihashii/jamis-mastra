import type { WeekFacts } from '../analysis';
import type { ChatContextMessage, RecapShaping } from '../generate';
import type { RecapGenerationRecord, SqlLike } from '../recaps';

import type { SleeperManager } from '../sleeper';

import { describe, expect, it } from 'bun:test';
import { parseFantasyConfig } from '../config';
import { FANTASY_GENERATOR_VERSION, toChatContext, validateShaping } from '../generate';
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
	{ id: 'm1', sender: 'alpha', text: 'bravo is cooked this week' },
	{ id: 'm2', sender: 'bravo', text: 'been workshopping plays all night' },
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
		...overrides,
	};
}

function shapingOf(overrides: Partial<RecapShaping> = {}): RecapShaping {
	return {
		awards: {
			roughestWeek: 'The lineup submitted a resignation letter.',
			bestWeek: 'The league briefly became a private showcase.',
			mostEntertainingMatchup: 'Nobody was permitted a comfortable Sunday.',
			biggestBlowout: 'The contest became paperwork before dinner.',
		},
		callbacks: [],
		...overrides,
	};
}

describe('toChatContext', () => {
	it('resolves mapped senders to display names and keeps order oldest-first', () => {
		// newest-first input, as listMessages returns it
		const messages = [dbMessage('m2', '+15550002222', 'been workshopping'), dbMessage('m1', '+15550001111', 'bravo is cooked')];
		expect(toChatContext(messages, config, managers)).toEqual([
			{ id: 'm1', sender: 'alpha', text: 'bravo is cooked' },
			{ id: 'm2', sender: 'bravo', text: 'been workshopping' },
		]);
	});

	it('labels unmapped senders as unknown instead of leaking numbers', () => {
		const messages = [dbMessage('m9', '+19999999999', 'who dis')];
		const [entry] = toChatContext(messages, config, managers);
		expect(entry.sender).toBe('unknown sender');
		expect(JSON.stringify(entry)).not.toContain('19999999999');
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
	it('accepts a clean shaping with zero callbacks', () => {
		expect(validateShaping(shapingOf(), context, factsStub())).toEqual(shapingOf());
	});

	it('rejects callbacks referencing messages outside the pool', () => {
		const bad = shapingOf({ callbacks: [{ messageId: 'nope', take: 'hmm' }] });
		expect(() => validateShaping(bad, context, factsStub())).toThrow(/unknown message id/);
	});

	it('rejects verbatim copies in either direction', () => {
		const copied = shapingOf({ callbacks: [{ messageId: 'm1', take: 'bravo is cooked this week' }] });
		expect(() => validateShaping(copied, context, factsStub())).toThrow(/verbatim/);
		const copiedWhole = shapingOf({ callbacks: [{ messageId: 'm1', take: 'BRAVO IS COOKED THIS WEEK' }] });
		expect(() => validateShaping(copiedWhole, context, factsStub())).toThrow(/verbatim/);
	});

	it('accepts real paraphrases', () => {
		const ok = shapingOf({ callbacks: [{ messageId: 'm1', take: 'alpha called the ending early' }] });
		expect(validateShaping(ok, context, factsStub())).toEqual(ok);
	});

	it('rejects a take that strictly contains the whole message (padded verbatim)', () => {
		const padded = shapingOf({ callbacks: [{ messageId: 'm1', take: 'honestly, bravo is cooked this week, like always' }] });
		expect(() => validateShaping(padded, context, factsStub())).toThrow(/echoes archived chat/);
	});

	it('allows a short quoted fragment mixed with added voice', () => {
		// "bravo is cooked" is under the 20-char echo threshold; reaction words make it voice, not cargo.
		const rake = shapingOf({ callbacks: [{ messageId: 'm1', take: 'as foretold: bravo is cooked' }] });
		expect(validateShaping(rake, context, factsStub())).toEqual(rake);
	});

	it('rejects digits anywhere in model fields; the renderer owns numbers outright', () => {
		const facts = factsStub();
		expect(() => validateShaping(shapingOf({ awards: { ...shapingOf().awards, roughestWeek: 'Week 1 chaos' } }), context, facts)).toThrow(/[Dd]igits/);
		expect(() => validateShaping(shapingOf({ callbacks: [{ messageId: 'm1', take: 'the workshop produced 97 points of nothing' }] }), context, facts)).toThrow(/[Dd]igits/);
	});

	it('rejects long verbatim echoes in award takes, not just callbacks', () => {
		const facts = factsStub();
		const echoedHeadline = shapingOf({ awards: { ...shapingOf().awards, bestWeek: 'bravo is cooked this week, and honestly the chat called it' } });
		// contains the m1 message text verbatim
		expect(() => validateShaping(echoedHeadline, context, facts)).toThrow(/echoes archived chat/);
		// short generic phrases stay legal even when they appeared in chat
		const fine = shapingOf({ awards: { ...shapingOf().awards, bestWeek: 'bravo is cooked' } });
		expect(validateShaping(fine, context, facts)).toEqual(fine);
	});
});

describe('renderWeekRecap', () => {
	it('renders the fixed heading and four factual award bullets', () => {
		const text = renderWeekRecap(factsStub(), shapingOf(), context);
		expect(text.startsWith('Week 2 Recap\n\n')).toBe(true);
		expect(text).toContain('- Roughest Week: bravo (97.25 points).');
		expect(text).toContain('- Best Week: alpha (120.5 points).');
		expect(text).toContain('- Most Entertaining Matchup: alpha 120.5, bravo 97.25 (23.25-point margin).');
		expect(text).toContain('- Biggest Blowout: alpha 120.5, bravo 97.25 (23.25-point margin).');
		expect(text).not.toContain('Standings:');
		expect(text).not.toContain('Watch next week:');
		expect(text.length).toBeLessThanOrEqual(RECAP_MAX_LENGTH);
	});

	it('renders callback paraphrases without original chat text', () => {
		const shaping = shapingOf({ callbacks: [{ messageId: 'm2', take: 'the workshop produced nothing but excuses' }] });
		const text = renderWeekRecap(factsStub(), shaping, context);
		expect(text).not.toContain('been workshopping plays all night');
		expect(text).toContain('the workshop produced nothing but excuses');
		expect(text.startsWith('Week 2 Recap')).toBe(true);
	});

	it('sacrifices callbacks to stay under the length cap, facts untouched', () => {
		const long = 'team'.repeat(55);
		const alpha = { rosterId: 1, userId: 'u1', displayName: `${long}a` };
		const bravo = { rosterId: 2, userId: 'u2', displayName: `${long}b` };
		const result = { a: alpha, b: bravo, aPoints: 120.5, bPoints: 97.25, margin: 23.25, winner: alpha, loser: bravo };
		const facts = factsStub({ results: [result], high: { teams: [alpha], points: 120.5 }, low: { teams: [bravo], points: 97.25 }, closest: result, blowout: result });
		const withCallbacks = shapingOf({
			callbacks: [
				{ messageId: 'm1', take: 'x'.repeat(160) },
				{ messageId: 'm2', take: 'y'.repeat(160) },
			],
		});
		const text = renderWeekRecap(facts, withCallbacks, context);
		expect(text.length).toBeLessThanOrEqual(RECAP_MAX_LENGTH);
		expect(text).toContain(`${long}a 120.5`);
		// cap was actually approached: the dropped take(s) are gone
		expect(text.includes('x'.repeat(160)) && text.includes('y'.repeat(160))).toBe(false);
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

	it('leaves an award factual when the model returns no worthwhile joke', () => {
		const shaping = shapingOf({ awards: { ...shapingOf().awards, bestWeek: null } });
		const text = renderWeekRecap(factsStub(), shaping, context);
		expect(text).toContain('- Best Week: alpha (120.5 points).\n');
		expect(text).not.toContain('null');
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
