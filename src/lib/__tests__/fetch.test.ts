import { afterAll, expect, test } from 'bun:test';

import { fetchJson } from '../fetch';

const server = Bun.serve({
	port: 0,
	fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === '/ok')
			return Response.json({ hello: 'world' });
		if (pathname === '/bad-json')
			return new Response('not json{', { status: 200 });
		if (pathname === '/error')
			return new Response('nope', { status: 404 });
		return new Response(null, { status: 500 });
	},
});
const base = `http://localhost:${server.port}`;

afterAll(() => server.stop(true));

test('returns parsed JSON for a 200 response', async () => {
	const res = await fetchJson(`${base}/ok`);
	expect(res.ok).toBe(true);
	expect(res.status).toBe(200);
	expect(res.json).toEqual({ hello: 'world' });
});

test('returns ok:false with the status for an error response', async () => {
	const res = await fetchJson(`${base}/error`);
	expect(res.ok).toBe(false);
	expect(res.status).toBe(404);
});

test('.json is null when the body is not JSON', async () => {
	const res = await fetchJson(`${base}/bad-json`);
	expect(res.ok).toBe(true);
	expect(res.json).toBeNull();
});

test('rethrows aborts instead of masking them', async () => {
	const controller = new AbortController();
	controller.abort();
	try {
		await fetchJson(`${base}/ok`, controller.signal);
		expect.unreachable();
	}
	catch (error) {
		expect((error as Error).name).toBe('AbortError');
	}
});

test('wraps connection failures as a class, detail to the server log', async () => {
	const { port } = server;
	await server.stop(true);
	try {
		await fetchJson(`http://localhost:${port}/ok`);
		expect.unreachable();
	}
	catch (error) {
		expect((error as Error).message).toBe('Service unreachable.');
	}
});
