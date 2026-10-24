import { Mastra } from '@mastra/core';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { FANTASY_EDITORIAL_MODEL, fantasyEditorialDefaults } from '../../../lib/fantasy/editorial-policy';
import { DEFAULT_RECAP_MODEL, FANTASY_GENERATOR_VERSION } from '../../../lib/fantasy/generate';
import { createFantasyFootballEditor } from '../fantasy-football-editor';
import { createFantasyFootballPundit } from '../fantasy-football-pundit';

test('the internal writer and distinct editor pin Astra, limits and private tool-free configuration', async () => {
	const mastra = new Mastra({ logger: false });
	const writer = createFantasyFootballPundit({ mastra });
	const editor = createFantasyFootballEditor(mastra);
	expect([writer.id, editor.id]).toEqual(['fantasy-football-pundit', 'fantasy-football-editor']);
	expect([writer.name, editor.name]).toEqual(['Fantasy Football Pundit', 'Fantasy Football Editor']);
	expect(FANTASY_EDITORIAL_MODEL).toBe('openai-codex/gpt-6-astra');
	for (const agent of [writer, editor]) {
		expect(agent.model).toBe(FANTASY_EDITORIAL_MODEL);
		expect(await agent.getDefaultOptions()).toEqual(fantasyEditorialDefaults());
		expect(agent.getChannels()).toBeNull();
		expect(await agent.listTools()).toEqual({});
		expect(await agent.getMemory()).toBeUndefined();
	}
	expect(Object.keys(mastra.listAgents())).toEqual([]);
	const instructions = await writer.getInstructions();
	expect(instructions).toContain('No fixed story/word/sentence quota');
	expect(instructions).toContain('use basis performance');
	expect(instructions).not.toContain('zero to four editorial stories');
	expect(await editor.getInstructions()).toContain('Never write replacement prose');
	expect(await editor.getInstructions()).toContain('same support as digits');
});

test('keeps award policy internal and asks for warranted performance roasts, not defensive disclaimers', async () => {
	const mastra = new Mastra({ logger: false });
	const writer = await createFantasyFootballPundit({ mastra }).getInstructions();
	const editor = await createFantasyFootballEditor(mastra).getInstructions();
	expect(writer).toContain('Award basis is internal metadata');
	expect(writer).toContain('Do not soften a warranted performance roast');
	expect(writer).toContain('judging-policy explanations or defensive disclaimers');
	expect(editor).toContain('An earned, evidence-backed fantasy roast is not unfair merely because it is harsh');
	expect(editor).toContain('judging-policy explanations or defensive disclaimers');
	expect(writer).toContain('unexpected injuries are not incompetence');
	expect(editor).toContain('never personal traits');
});

test('pins the reviewed writer instructions and keeps the legacy profile retired', async () => {
	const writer = createFantasyFootballPundit({ mastra: new Mastra({ logger: false }) });
	const instructions = await writer.getInstructions();
	expect(typeof instructions).toBe('string');
	expect(createHash('sha256').update(instructions as string).digest('hex'))
		.toBe('826514787ecfd65b6266be1e1cec43b2dad669aef8159da78fff3aa4dc684c2f');
	const source = await readFile(new URL('../fantasy-football-pundit.ts', import.meta.url), 'utf8');
	expect(source).not.toMatch(/FANTASY_VOICE|const INSTRUCTIONS|input: string|typeof input/);
});

test('historical recap identifiers and unrelated specialist model bindings remain unchanged', async () => {
	expect(DEFAULT_RECAP_MODEL).toBe('openai-codex/gpt-6.1-sol');
	expect(FANTASY_GENERATOR_VERSION).toBe('fantasy-recap-v12');
	for (const [file, binding] of [
		['jamis.ts', 'model: \'openai-codex/gpt-6.1-sol\''],
		['research-agent.ts', 'model: config.model ?? \'openai-codex/gpt-6.1-sol\''],
		['fantasy-broadcast-agent.ts', 'model: config.model ?? \'openai-codex/gpt-6.1-sol\''],
		['weather-agent.ts', 'model: config.model ?? \'openai-codex/gpt-6-luna\''],
		['personal-accounts-agent.ts', 'model: config.model ?? \'openai-codex/gpt-6-luna\''],
	]) {
		expect(await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).toContain(binding);
	}
});
