import process from 'node:process';
import { z } from 'zod';

const configSchema = z.object({
	LINEAR_CLIENT_ID: z.string().trim().min(1),
	LINEAR_CLIENT_SECRET: z.string().trim().min(1),
	LINEAR_TEAM_ID: z.uuid(),
});
const tokenSchema = z.object({
	access_token: z.string().min(1),
	token_type: z.literal('Bearer'),
	expires_in: z.number().int().positive().max(2_592_000),
	scope: z.string().refine(scope => scope.trim() === 'read'),
});
const evidenceSchema = z.object({
	data: z.object({
		viewer: z.object({ id: z.uuid(), name: z.string().min(1).max(200), app: z.boolean() }),
		team: z.object({ id: z.uuid(), name: z.string().min(1).max(200), key: z.string().min(1).max(100) }),
	}),
	errors: z.array(z.unknown()).optional(),
});

type Failure = 'configuration' | 'authentication' | 'identity' | 'team' | 'response' | 'timeout' | 'unavailable';

/** Only fixed categories leave this boundary, never upstream bodies or causes. */
export class LinearError extends Error {
	constructor(public readonly category: Failure) {
		super(`Linear ${category} failure.`);
		this.name = 'LinearError';
	}
}

/** Runtime-only app token. No arbitrary query, issue read, or mutation surface. */
export function createLinearClient(env: Record<string, string | undefined> = process.env) {
	const parsed = configSchema.safeParse(env);
	if (!parsed.success)
		throw new LinearError('configuration');
	const config = parsed.data;
	let token: { access: string; expiresAt: number } | undefined;
	let pendingToken: Promise<string> | undefined;

	async function request(url: string, init: RequestInit): Promise<unknown> {
		const signal = AbortSignal.timeout(10_000);
		try {
			const response = await fetch(url, { ...init, signal, redirect: 'error' });
			if (response.status === 401 || response.status === 403) {
				token = undefined;
				throw new LinearError('authentication');
			}
			if (!response.ok)
				throw new LinearError(url.endsWith('/oauth/token') && response.status === 400 ? 'authentication' : 'unavailable');
			return await response.json().catch(() => {
				throw new LinearError(signal.aborted ? 'timeout' : 'response');
			});
		}
		catch (error) {
			if (error instanceof LinearError)
				throw error;
			throw new LinearError(signal.aborted ? 'timeout' : 'unavailable');
		}
	}

	async function getToken(): Promise<string> {
		if (token && Date.now() < token.expiresAt)
			return token.access;
		if (!pendingToken) {
			pendingToken = (async () => {
				const startedAt = Date.now();
				const result = tokenSchema.safeParse(await request('https://api.linear.app/oauth/token', {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({
						grant_type: 'client_credentials',
						scope: 'read',
						client_id: config.LINEAR_CLIENT_ID,
						client_secret: config.LINEAR_CLIENT_SECRET,
					}),
				}));
				if (!result.success)
					throw new LinearError('response');
				token = { access: result.data.access_token, expiresAt: startedAt + result.data.expires_in * 1000 - 60_000 };
				return token.access;
			})();
		}
		try {
			return await pendingToken;
		}
		finally {
			pendingToken = undefined;
		}
	}

	return {
		async readIdentityAndTeam() {
			const access = await getToken();
			const result = evidenceSchema.safeParse(await request('https://api.linear.app/graphql', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access}` },
				body: JSON.stringify({
					query: 'query JamisIdentityAndTeam($teamId: String!) { viewer { id name app } team(id: $teamId) { id name key } }',
					variables: { teamId: config.LINEAR_TEAM_ID },
				}),
			}));
			if (!result.success || result.data.errors?.length)
				throw new LinearError('response');
			const { viewer, team } = result.data.data;
			if (!viewer.app || viewer.name.toLowerCase() !== 'jamis')
				throw new LinearError('identity');
			if (team.id !== config.LINEAR_TEAM_ID || team.name !== 'jamis')
				throw new LinearError('team');
			return { viewer, team };
		},
	};
}
