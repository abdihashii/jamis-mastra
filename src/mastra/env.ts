import process from 'node:process';

import { isIanaTimeZone } from '../lib/time';

// Fail at boot rather than hand undefined to a driver. ClickHouse accepts an
// empty password and connects, hiding the misconfiguration.
export function requireEnv(name: string): string {
	const value = process.env[name];

	if (!value) {
		throw new Error(`Missing required env var: ${name}`);
	}

	return value;
}

export function requireOperatorTimeZone(env: Record<string, string | undefined> = process.env): string {
	const value = env.OPERATOR_TIMEZONE?.trim();

	if (!value) {
		throw new Error('Missing required env var: OPERATOR_TIMEZONE. Set OPERATOR_TIMEZONE to an IANA time zone such as America/Chicago.');
	}
	if (!isIanaTimeZone(value)) {
		throw new Error(`Invalid OPERATOR_TIMEZONE: "${value}". Set OPERATOR_TIMEZONE to an IANA time zone such as America/Chicago.`);
	}

	return value;
}
