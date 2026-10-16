import { expect, test } from 'bun:test';
import { DEFAULT_RECAP_MODEL, FANTASY_GENERATOR_VERSION } from '../../../lib/fantasy/generate';
import { FANTASY_VOICE } from '../../../lib/fantasy/voice';
import { createFantasyFootballPundit } from '../fantasy-football-pundit';

test('Pundit uses its identifying name while retaining the model and effect-free configuration', async () => {
	const agent = createFantasyFootballPundit(DEFAULT_RECAP_MODEL);
	expect(agent.id).toBe('fantasy-football-pundit');
	expect(agent.name).toBe('Fantasy Football Pundit');
	expect(agent.model).toBe(DEFAULT_RECAP_MODEL);
	expect(DEFAULT_RECAP_MODEL).toBe('openai-codex/gpt-6.1-sol');
	expect(FANTASY_GENERATOR_VERSION).toBe('fantasy-recap-v11');
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
	expect(instructions).toContain(FANTASY_VOICE);
});
