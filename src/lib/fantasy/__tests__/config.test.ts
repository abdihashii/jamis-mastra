import { describe, expect, it } from 'bun:test';

import { parseFantasyConfig } from '../config';

const validEnv = {
	FANTASY_SENDBLUE_GROUP_ID: 'group-abc',
	FANTASY_SLEEPER_LEAGUE_ID: '1234567890',
	FANTASY_MANAGER_MAP: JSON.stringify({ '+15551234567': 'sleeper-user-1' }),
	FANTASY_RECAP_TIMEZONE: 'America/Chicago',
};

function spy() {
	const messages: string[] = [];
	return { messages, warn: (m: string) => messages.push(m) };
}

describe('parseFantasyConfig', () => {
	it('returns null quietly when nothing is configured', () => {
		const { messages, warn } = spy();
		expect(parseFantasyConfig({}, warn)).toBeNull();
		expect(messages).toBeEmpty();
	});

	it('parses a complete valid config', () => {
		const { messages, warn } = spy();
		const config = parseFantasyConfig(validEnv, warn);
		expect(config).toEqual({
			sendblueGroupId: 'group-abc',
			sleeperLeagueId: '1234567890',
			managerMap: { '+15551234567': 'sleeper-user-1' },
			recapTimezone: 'America/Chicago',
		});
		expect(messages).toBeEmpty();
	});

	it('disables with a warning when partially configured', () => {
		const { messages, warn } = spy();
		const env = { ...validEnv };
		delete (env as Record<string, string>).FANTASY_MANAGER_MAP;
		expect(parseFantasyConfig(env, warn)).toBeNull();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain('FANTASY_MANAGER_MAP');
	});

	it('rejects an unparsable manager map', () => {
		const { messages, warn } = spy();
		expect(parseFantasyConfig({ ...validEnv, FANTASY_MANAGER_MAP: 'not-json' }, warn)).toBeNull();
		expect(messages[0]).toContain('FANTASY_MANAGER_MAP');
	});

	it('rejects manager map keys that are not E.164 numbers', () => {
		const { messages, warn } = spy();
		const bad = JSON.stringify({ 5551234567: 'sleeper-user-1' });
		expect(parseFantasyConfig({ ...validEnv, FANTASY_MANAGER_MAP: bad }, warn)).toBeNull();
		expect(messages[0]).toContain('FANTASY_MANAGER_MAP');
	});

	it('never logs manager map values', () => {
		const { messages, warn } = spy();
		parseFantasyConfig({ ...validEnv, FANTASY_MANAGER_MAP: 'no' }, warn);
		expect(messages.join(' ')).not.toContain('5551234567');
		expect(messages.join(' ')).not.toContain('sleeper-user-1');
	});

	it('accepts an empty manager map', () => {
		const { messages, warn } = spy();
		const config = parseFantasyConfig({ ...validEnv, FANTASY_MANAGER_MAP: '{}' }, warn);
		expect(config?.managerMap).toEqual({});
		expect(messages).toBeEmpty();
	});

	it('rejects an invalid IANA timezone', () => {
		const { messages, warn } = spy();
		expect(parseFantasyConfig({ ...validEnv, FANTASY_RECAP_TIMEZONE: 'Mars/Olympus_Mons' }, warn)).toBeNull();
		expect(messages[0]).toContain('FANTASY_RECAP_TIMEZONE');
	});
});
