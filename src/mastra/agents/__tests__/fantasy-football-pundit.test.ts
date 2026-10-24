import { expect, test } from 'bun:test';
import { Mastra } from '@mastra/core';
import { FANTASY_EDITORIAL_MODEL, fantasyEditorialDefaults } from '../../../lib/fantasy/editorial-policy';
import { DEFAULT_RECAP_MODEL, FANTASY_GENERATOR_VERSION } from '../../../lib/fantasy/generate';
import { FANTASY_VOICE } from '../../../lib/fantasy/voice';
import { createFantasyFootballEditor } from '../fantasy-football-editor';
import { createFantasyFootballPundit } from '../fantasy-football-pundit';

test('Pundit uses its identifying name while retaining the model and effect-free configuration', async () => {
	const agent = createFantasyFootballPundit(DEFAULT_RECAP_MODEL);
	expect(agent.id).toBe('fantasy-football-pundit');
	expect(agent.name).toBe('Fantasy Football Pundit');
	expect(agent.model).toBe(DEFAULT_RECAP_MODEL);
	expect(DEFAULT_RECAP_MODEL).toBe('openai-codex/gpt-6.1-sol');
	expect(FANTASY_GENERATOR_VERSION).toBe('fantasy-recap-v12');
	expect(await agent.getDefaultOptions()).toEqual({ providerOptions: { openai: { reasoningEffort: 'xhigh' } } });
	expect(agent.getChannels()).toBeNull();
	expect(await agent.listTools()).toEqual({});
	expect(await agent.getMemory()).toBeUndefined();
});

test('extracted recap Agent keeps the existing facts-only instructions and shared voice', async () => {
	const agent = createFantasyFootballPundit('openai/fixture-model');
	expect(agent.model).toBe('openai/fixture-model');
	const instructions = await agent.getInstructions();
	expect(instructions).toContain('You are the Fantasy Football Pundit:');
	expect(instructions).not.toContain('ibn Jamis');
	expect(instructions).toContain('Awards are facts-only and supplied by the renderer.');
	expect(instructions).toContain('paraphrases rather than quotes the source');
	expect(instructions).toContain('Each sentence entry must contain exactly one complete sentence');
	expect(instructions).toContain('Four or more consecutive words from any archived message count as copying');
	expect(instructions).toContain(FANTASY_VOICE);
});

test('the internal writer and distinct editor pin Astra, limits and private tool-free configuration', async () => {
	const mastra = new Mastra({ logger: false });
	const writer = createFantasyFootballPundit({ mastra });
	const editor = createFantasyFootballEditor(mastra);
	expect([writer.id, editor.id]).toEqual(['fantasy-football-pundit', 'fantasy-football-editor']);
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
