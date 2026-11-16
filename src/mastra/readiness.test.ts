import type { Socket } from 'node:net';

import { Mastra } from '@mastra/core/mastra';
import { createHonoServer } from '@mastra/deployer/server';
import { PostgresStore } from '@mastra/pg';
import { describe, expect, spyOn, test } from 'bun:test';
import { createConnection, createServer } from 'node:net';
import process from 'node:process';

import { createReadinessServer } from './readiness';

const token = 'readiness-test-token';
const authorized = { headers: { Authorization: `Bearer ${token}` } };

async function fixture(connectionString: string) {
	const store = new PostgresStore({ id: 'readiness-test', connectionString, max: 1, disableInit: true });
	const mastra = new Mastra({ logger: false, storage: store, server: createReadinessServer(store, token) });
	const app = await createHonoServer(mastra, { tools: {} });
	return { store, app };
}

async function unavailable(response: Response) {
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ status: 'unavailable' });
	expect(response.headers.get('cache-control')).toBe('no-store');
}

test('native HTTP middleware rejects missing/wrong credentials before pool checkout and preserves API auth', async () => {
	const { store, app } = await fixture('postgres://fixture:PRIVATE_PASSWORD@127.0.0.1:1/jamis_sessions_test');
	const connect = spyOn(store.pool, 'connect');
	try {
		for (const path of ['/readyz', '/readyz?token=readiness-test-token', '/api/agents']) {
			for (const headers of [new Headers(), new Headers({ Authorization: 'Bearer wrong' })]) {
				const response = await app.request(path, { headers });
				expect(response.status).toBe(401);
			}
		}
		expect(connect).not.toHaveBeenCalled();
		for (const path of ['/api', '/api/auth/capabilities'])
			expect((await app.request(path)).status).not.toBe(401);
		const response = await app.request('/api/agents', authorized);
		expect(response.status).toBe(200);
		const started = performance.now();
		await unavailable(await app.request('/readyz', authorized));
		expect(performance.now() - started).toBeLessThan(4_750);
		expect(store.pool.totalCount).toBe(0);
	} finally {
		connect.mockRestore();
		await store.close();
	}
});

const databaseUrl = process.env.JAMIS_TEST_DATABASE_URL;
if (databaseUrl) {
	const url = new URL(databaseUrl);
	if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)
		|| url.port !== '15458' || url.pathname !== '/jamis_sessions_test' || url.search || url.hash) {
		throw new Error('Disposable loopback port 15458 jamis_sessions_test URL required');
	}
}

describe.skipIf(!databaseUrl)('readiness with native writer pool and HTTP middleware', () => {
	test('each authenticated success queries the writer and releases its client', async () => {
		const { store, app } = await fixture(databaseUrl!);
		const client = await store.pool.connect();
		const query = spyOn(client, 'query');
		client.release();
		try {
			for (let i = 0; i < 2; i++) {
				const response = await app.request('/readyz', authorized);
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ status: 'ready' });
				expect(response.headers.get('cache-control')).toBe('no-store');
			}
			expect(query).toHaveBeenCalledTimes(2);
			expect(query).toHaveBeenCalledWith('SELECT 1');
			expect(store.pool.idleCount).toBe(1);
			expect(store.pool.waitingCount).toBe(0);
		} finally {
			query.mockRestore();
			await store.close();
		}
	});

	test('saturated checkout expires, retains only one waiter, and discards late checkout without querying', async () => {
		const { store, app } = await fixture(databaseUrl!);
		const held = await store.pool.connect();
		const query = spyOn(held, 'query');
		let released = false;
		try {
			const started = performance.now();
			const pending = app.request('/readyz', authorized);
			await Bun.sleep(20);
			await unavailable(await app.request('/readyz', authorized));
			expect(store.pool.waitingCount).toBe(1);
			await unavailable(await pending);
			expect(performance.now() - started).toBeLessThan(4_750);
			for (let i = 0; i < 5; i++)
				await unavailable(await app.request('/readyz', authorized));
			expect(store.pool.waitingCount).toBe(1);
			expect(store.pool.totalCount).toBe(1);
			held.release();
			released = true;
			await Bun.sleep(30);
			expect(query).not.toHaveBeenCalled();
			expect(store.pool.waitingCount).toBe(0);
			expect(store.pool.totalCount).toBe(0);
			expect((await app.request('/readyz', authorized)).status).toBe(200);
		} finally {
			if (!released)
				held.release();
			query.mockRestore();
			await store.close();
		}
	}, 10_000);

	test('SQL failure is sanitized, discards the connection, and a fresh probe recovers', async () => {
		const { store, app } = await fixture(databaseUrl!);
		const client = await store.pool.connect();
		await client.query('BEGIN');
		await client.query('SELECT PRIVATE_ERROR_SENTINEL').catch(() => {});
		client.release();
		try {
			await unavailable(await app.request('/readyz', authorized));
			expect(store.pool.totalCount).toBe(0);
			expect((await app.request('/readyz', authorized)).status).toBe(200);
		} finally {
			await store.close();
		}
	});

	test('stalled response destroys the checked-out connection before subsequent probes', async () => {
		const target = new URL(databaseUrl!);
		const port = Number(target.port);
		const upstreams = new Set<Socket>();
		const sockets = new Set<Socket>();
		const proxy = createServer((incoming) => {
			const upstream = createConnection({ host: target.hostname, port });
			upstreams.add(upstream);
			sockets.add(incoming);
			sockets.add(upstream);
			incoming.on('error', () => {});
			upstream.on('error', () => {});
			incoming.on('close', () => upstream.destroy());
			upstream.on('close', () => {
				upstreams.delete(upstream);
				incoming.destroy();
			});
			incoming.pipe(upstream).pipe(incoming);
		});
		await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
		const address = proxy.address();
		if (!address || typeof address === 'string')
			throw new Error('Expected loopback address');
		target.port = String(address.port);
		const { store, app } = await fixture(target.toString());
		try {
			for (let i = 0; i < 2; i++) {
				expect((await app.request('/readyz', authorized)).status).toBe(200);
				for (const upstream of upstreams)
					upstream.pause();
				const started = performance.now();
				await unavailable(await app.request('/readyz', authorized));
				expect(performance.now() - started).toBeLessThan(4_750);
				expect(store.pool.totalCount).toBe(0);
				expect(store.pool.waitingCount).toBe(0);
				await Bun.sleep(30);
				expect(upstreams.size).toBe(0);
			}
			expect((await app.request('/readyz', authorized)).status).toBe(200);
		} finally {
			await store.close();
			for (const socket of sockets)
				socket.destroy();
			await new Promise<void>(resolve => proxy.close(() => resolve()));
		}
	}, 15_000);
});
