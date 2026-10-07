import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProjectCli } from './project-cli';
import { limits } from './project-cli-contract';

test('owner fails closed on mismatched identities, oversized IPC and malformed query results', async () => {
	const root = await mkdtemp(join(tmpdir(), 'jam86-owner-'));
	const view = { generation: 'view-synthetic', preparedAt: '2026-10-04T00:00:00.000Z' };
	const sockets = { rg: join(root, 'rg.sock'), jq: join(root, 'jq.sock') };
	let bad = '';
	let queries = 0;
	const servers = (['rg', 'jq'] as const).map(mode => createServer((socket) => {
		socket.on('error', () => {});
		socket.once('data', async (data) => {
			const request = JSON.parse(data.toString());
			if (request.type === 'status') {
				if (bad === 'slow')
					await Bun.sleep(30);
				if (bad === 'oversized') {
					socket.end('x'.repeat(limits.responseBytes + 1));
					return;
				}
				socket.end(`${JSON.stringify({ instance: '00000000-0000-0000-0000-000000000000', mode, idle: bad !== 'active', view: bad === 'view' ? { ...view, generation: 'view-wrong' } : view })}\n`);
			}
			else {
				queries++;
				socket.end(`${JSON.stringify({ ok: true, operation: 'count', path: '.', view, output: bad === 'result' ? -1 : 0 })}\n`);
			}
		});
	}).listen(sockets[mode]));
	try {
		await writeFile(join(root, '.prepared-at'), `${view.preparedAt}\n`);
		await writeFile(join(root, '.project-view.json'), JSON.stringify(view));
		const owner = await createProjectCli(root, sockets);
		const op = { operation: 'count', path: '.', pattern: 'x' };
		for (const fault of ['view', 'oversized', 'active']) {
			bad = fault;
			assert.equal(await owner.ready(), false);
			assert.deepEqual(await owner.query(op), { ok: false, error: 'unavailable' });
		}
		assert.equal(queries, 0);
		bad = '';
		assert.ok(await owner.ready());
		bad = 'result';
		assert.deepEqual(await owner.query(op), { ok: false, error: 'unavailable' });
		bad = 'active';
		assert.deepEqual(await owner.query(op), { ok: false, error: 'unavailable' });
		assert.equal(queries, 1);
		bad = '';
		assert.deepEqual(await owner.query(op), { ok: true, operation: 'count', path: '.', view, output: 0 });
		bad = 'slow';
		const checking = owner.ready();
		assert.deepEqual(await owner.query(op), { ok: false, error: 'busy' });
		assert.ok(await checking);
		bad = '';
		assert.deepEqual(await owner.query(op), { ok: true, operation: 'count', path: '.', view, output: 0 });
		assert.deepEqual(await owner.query({ ...op, argv: ['sh'] }), { ok: false, error: 'denied' });
	}
	finally {
		for (const server of servers) server.close();
		await rm(root, { recursive: true, force: true });
	}
});
