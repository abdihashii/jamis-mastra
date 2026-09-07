import process from 'node:process';

import { z } from 'zod';

export interface FantasyConfig {
	sendblueGroupId: string;
	sleeperLeagueId: string;
	/** E.164 sender number -> Sleeper user ID. Never log values. */
	managerMap: Record<string, string>;
	recapTimezone: string;
}

const managerMapSchema = z.record(z.string().regex(/^\+[1-9]\d{1,14}$/), z.string().min(1));

/**
 * All-or-nothing: when every Fantasy variable is absent the feature is quietly
 * disabled. Partial or invalid config disables only Fantasy and warns, leaving
 * Jamis available (JAM-54).
 */
export function parseFantasyConfig(
	env: Record<string, string | undefined> = process.env,
	warn: (message: string) => void = message => console.warn(`[fantasy-recap] ${message}`),
): FantasyConfig | null {
	const sendblueGroupId = env.FANTASY_SENDBLUE_GROUP_ID?.trim();
	const sleeperLeagueId = env.FANTASY_SLEEPER_LEAGUE_ID?.trim();
	const managerMapJson = env.FANTASY_MANAGER_MAP?.trim();
	const recapTimezone = env.FANTASY_RECAP_TIMEZONE?.trim();

	if (!sendblueGroupId && !sleeperLeagueId && !managerMapJson && !recapTimezone) {
		return null;
	}

	const missing: string[] = [];
	if (!sendblueGroupId)
		missing.push('FANTASY_SENDBLUE_GROUP_ID');
	if (!sleeperLeagueId)
		missing.push('FANTASY_SLEEPER_LEAGUE_ID');
	if (!managerMapJson)
		missing.push('FANTASY_MANAGER_MAP');
	if (!recapTimezone)
		missing.push('FANTASY_RECAP_TIMEZONE');
	if (!sendblueGroupId || !sleeperLeagueId || !managerMapJson || !recapTimezone) {
		warn(`Fantasy disabled: missing ${missing.join(', ')}`);
		return null;
	}

	let managerMap: Record<string, string>;
	try {
		managerMap = managerMapSchema.parse(JSON.parse(managerMapJson));
	}
	catch {
		warn('Fantasy disabled: FANTASY_MANAGER_MAP must be JSON of {"+1<phone>":"<sleeper user id>"}');
		return null;
	}

	if (!Intl.supportedValuesOf('timeZone').includes(recapTimezone)) {
		warn('Fantasy disabled: FANTASY_RECAP_TIMEZONE is not a valid IANA timezone');
		return null;
	}

	return {
		sendblueGroupId,
		sleeperLeagueId,
		managerMap,
		recapTimezone,
	};
}

let cachedConfig: FantasyConfig | null | undefined;

export function getFantasyConfig(): FantasyConfig | null {
	if (cachedConfig === undefined) {
		cachedConfig = parseFantasyConfig();
	}
	return cachedConfig;
}
