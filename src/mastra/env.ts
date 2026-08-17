import process from 'node:process';

// Fail at boot rather than hand undefined to a driver. ClickHouse accepts an
// empty password and connects, hiding the misconfiguration.
export function requireEnv(name: string): string {
	const value = process.env[name];

	if (!value) {
		throw new Error(`Missing required env var: ${name}`);
	}

	return value;
}
