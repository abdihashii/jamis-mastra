import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createLinearClient, LinearError } from '../linear';

const config = {
	LINEAR_CLIENT_ID: 'client-id',
	LINEAR_CLIENT_SECRET: 'seeded-client-secret',
	LINEAR_TEAM_ID: '11111111-1111-4111-8111-111111111111',
};
const evidence = {
	viewer: { id: '22222222-2222-4222-8222-222222222222', name: 'Jamis', app: true },
	team: { id: config.LINEAR_TEAM_ID, name: 'jamis', key: 'JAM' },
};
const grant = { access_token: 'seeded-access-token', token_type: 'Bearer', expires_in: 2_591_999, scope: 'read' };
const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }>;
let replies: Array<Response | Error>;

beforeEach(() => {
	calls = [];
	replies = [Response.json(grant), Response.json({ data: evidence })];
	globalThis.fetch = (async (url, init) => {
		calls.push({ url: String(url), init: init! });
		const reply = replies.shift();
		if (reply instanceof Error)
			throw reply;
		if (!reply)
			throw new Error('Unexpected HTTP call');
		return reply;
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test('reads validated app identity and pinned team, with only a read grant', async () => {
	replies[1] = Response.json({
		data: {
			viewer: { ...evidence.viewer, accessToken: grant.access_token },
			team: { ...evidence.team, secret: config.LINEAR_CLIENT_SECRET },
		},
	});
	const client = createLinearClient(config);
	expect(await client.readIdentityAndTeam()).toEqual(evidence);
	expect(Object.keys(client)).toEqual(['readIdentityAndTeam']);
	expect(calls.map(c => c.url)).toEqual(['https://api.linear.app/oauth/token', 'https://api.linear.app/graphql']);
	expect(Object.fromEntries(calls[0].init.body as URLSearchParams)).toEqual({
		grant_type: 'client_credentials',
		scope: 'read',
		client_id: config.LINEAR_CLIENT_ID,
		client_secret: config.LINEAR_CLIENT_SECRET,
	});
	expect(calls[1].init.headers).toMatchObject({ Authorization: `Bearer ${grant.access_token}` });
	expect(JSON.parse(calls[1].init.body as string)).toEqual({
		query: 'query JamisIdentityAndTeam($teamId: String!) { viewer { id name app } team(id: $teamId) { id name key } }',
		variables: { teamId: config.LINEAR_TEAM_ID },
	});
	for (const call of calls) {
		expect(call.init.signal).toBeInstanceOf(AbortSignal);
		expect(call.init.redirect).toBe('error');
	}
	replies.push(Response.json({ data: evidence }));
	expect(await client.readIdentityAndTeam()).toEqual(evidence);
	expect(calls).toHaveLength(3);
});

test('coalesces simultaneous token requests without caching team evidence', async () => {
	replies.push(Response.json({ data: evidence }));
	const client = createLinearClient(config);
	expect(await Promise.all([client.readIdentityAndTeam(), client.readIdentityAndTeam()])).toEqual([evidence, evidence]);
	expect(calls.filter(c => c.url.endsWith('/oauth/token'))).toHaveLength(1);
});

test('renews tokens before expiry using server lifetime', async () => {
	const clock = spyOn(Date, 'now').mockReturnValue(1_000_000);
	try {
		const client = createLinearClient(config);
		await client.readIdentityAndTeam();
		clock.mockReturnValue(1_000_000 + grant.expires_in * 1000 - 60_000);
		replies.push(Response.json(grant), Response.json({ data: evidence }));
		await client.readIdentityAndTeam();
		expect(calls.filter(c => c.url.endsWith('/oauth/token'))).toHaveLength(2);
	}
	finally {
		clock.mockRestore();
	}
});

test('missing credentials or invalid team configuration fails before HTTP', () => {
	for (const env of [{}, { ...config, LINEAR_CLIENT_ID: '' }, { ...config, LINEAR_CLIENT_SECRET: undefined }, { ...config, LINEAR_TEAM_ID: 'JAM' }])
		expect(() => createLinearClient(env)).toThrow('Linear configuration failure.');
	expect(calls).toHaveLength(0);
});

test('refuses a user actor, wrong app, different team ID, or renamed team', async () => {
	for (const [data, category] of [
		[{ ...evidence, viewer: { ...evidence.viewer, app: false } }, 'identity'],
		[{ ...evidence, viewer: { ...evidence.viewer, name: 'Operator' } }, 'identity'],
		[{ ...evidence, team: { ...evidence.team, id: evidence.viewer.id } }, 'team'],
		[{ ...evidence, team: { ...evidence.team, name: 'other' } }, 'team'],
	] as const) {
		replies = [Response.json(grant), Response.json({ data })];
		await expect(createLinearClient(config).readIdentityAndTeam()).rejects.toThrow(`Linear ${category} failure.`);
	}
});

test('never accepts malformed, expired, or over-scoped token responses', async () => {
	for (const response of [{}, { ...grant, access_token: '' }, { ...grant, expires_in: 0 }, { ...grant, expires_in: '2591999' }, { ...grant, token_type: 'unknown' }, { ...grant, scope: 'read write' }]) {
		replies = [Response.json(response)];
		await expect(createLinearClient(config).readIdentityAndTeam()).rejects.toThrow('Linear response failure.');
	}
	expect(calls.every(c => c.url.endsWith('/oauth/token'))).toBe(true);
});

test('malformed JSON, absent data/team, and partial GraphQL errors fail closed', async () => {
	for (const response of [
		new Response('invalid JSON'),
		Response.json({}),
		Response.json({ data: { ...evidence, team: null } }),
		Response.json({ data: { ...evidence, viewer: { ...evidence.viewer, app: 'true' } } }),
		Response.json({ data: evidence, errors: [{ message: 'seeded-access-token' }] }),
	]) {
		replies = [Response.json(grant), response];
		await expect(createLinearClient(config).readIdentityAndTeam()).rejects.toThrow('Linear response failure.');
	}
});

test('rejected credentials and upstream failures expose only safe categories', async () => {
	for (const [response, category] of [
		[new Response(config.LINEAR_CLIENT_SECRET, { status: 400 }), 'authentication'],
		[new Response(grant.access_token, { status: 401 }), 'authentication'],
		[new Response(grant.access_token, { status: 403 }), 'authentication'],
		[new Response(config.LINEAR_CLIENT_SECRET, { status: 503 }), 'unavailable'],
		[new Error(`${config.LINEAR_CLIENT_SECRET} ${grant.access_token}`), 'unavailable'],
	] as const) {
		replies = [response];
		try {
			await createLinearClient(config).readIdentityAndTeam();
			throw new Error('Expected rejection');
		}
		catch (error) {
			expect(error).toBeInstanceOf(LinearError);
			expect((error as LinearError).category).toBe(category);
			expect(String(error)).not.toContain(config.LINEAR_CLIENT_SECRET);
			expect(String(error)).not.toContain(grant.access_token);
			expect((error as Error).cause).toBeUndefined();
		}
	}
});

test('401 discards the cached token; next call reauthenticates with the app only', async () => {
	const client = createLinearClient(config);
	await client.readIdentityAndTeam();
	replies.push(new Response('seeded-access-token', { status: 401 }));
	await expect(client.readIdentityAndTeam()).rejects.toThrow('Linear authentication failure.');
	replies.push(Response.json(grant), Response.json({ data: evidence }));
	await client.readIdentityAndTeam();
	expect(calls.filter(c => c.url.endsWith('/oauth/token'))).toHaveLength(2);
});

test('bounds token and GraphQL waits, including response body consumption', async () => {
	const originalTimeout = AbortSignal.timeout;
	const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(() => originalTimeout(1));
	try {
		for (const boundary of ['token', 'graphql', 'body']) {
			globalThis.fetch = (async (url, init) => {
				if (boundary !== 'token' && String(url).endsWith('/oauth/token'))
					return Response.json(grant);
				const wait = () => new Promise<never>((_, reject) => {
					init!.signal!.addEventListener('abort', () => reject(new Error('seeded-client-secret')), { once: true });
				});
				if (boundary === 'body')
					return { ok: true, status: 200, json: wait } as unknown as Response;
				return wait();
			}) as typeof fetch;
			await expect(createLinearClient(config).readIdentityAndTeam()).rejects.toThrow('Linear timeout failure.');
		}
		expect(timeout.mock.calls.every(([ms]) => ms === 10_000)).toBe(true);
	}
	finally {
		timeout.mockRestore();
	}
});
