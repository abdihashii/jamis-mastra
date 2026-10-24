import { afterAll, expect, spyOn, test } from 'bun:test';

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
	} catch (error) {
		expect((error as Error).name).toBe('AbortError');
	}
});

test('preserves a caller-provided abort reason', async () => {
	const controller = new AbortController();
	const reason = new Error('cancelled');
	controller.abort(reason);
	await expect(fetchJson(`${base}/ok`, controller.signal)).rejects.toBe(reason);
});

test('aborts while consuming a response body, preserving the deadline reason', async () => {
	const stalled = Bun.serve({
		port: 0,
		fetch: () => new Response(new ReadableStream({
			start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
		})),
	});
	const signal = AbortSignal.timeout(30);
	try {
		await fetchJson(`http://localhost:${stalled.port}/stalled`, signal);
		expect.unreachable();
	} catch (error) {
		expect(signal.aborted).toBe(true);
		expect(error).toBe(signal.reason);
	} finally {
		await stalled.stop(true);
	}
});

test('lets source owners suppress raw connection-error logs', async () => {
	const closed = Bun.serve({ port: 0, fetch: () => new Response('fixture') });
	const url = `http://localhost:${closed.port}/closed`;
	await closed.stop(true);
	const log = spyOn(console, 'error').mockImplementation(() => {});
	try {
		await expect(fetchJson(url, undefined, undefined, false)).rejects.toThrow('Service unreachable.');
		expect(log).not.toHaveBeenCalled();
	} finally {
		log.mockRestore();
	}
});

test('wraps connection failures as a class, detail to the server log', async () => {
	const { port } = server;
	await server.stop(true);
	try {
		await fetchJson(`http://localhost:${port}/ok`);
		expect.unreachable();
	} catch (error) {
		expect((error as Error).message).toBe('Service unreachable.');
	}
});
