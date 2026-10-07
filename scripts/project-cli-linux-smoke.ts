import type { Status } from '../src/mastra/project-cli-contract';
// Synthetic app: no Docker authority, dependencies, or writable IPC mounts.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';

import process from 'node:process';
import { createProjectCli } from '../src/mastra/project-cli';
import { limits } from '../src/mastra/project-cli-contract';
import { pinProjectView } from '../src/mastra/project-workspace';

const sockets = { rg: '/rg-ipc/worker.sock', jq: '/jq-ipc/worker.sock' };
const owner = await createProjectCli('/project', sockets);
const search = (pattern: string) => ({ operation: 'search', path: 'src', pattern });
const count = { operation: 'count', path: 'src', pattern: 'sendblue', ignoreCase: true, globs: ['*.ts'] };
const jq = (filter: string, path = 'package.json') => ({ operation: 'jq', path, filter });
async function success(op: unknown, expected?: unknown) {
	const result = await owner.query(op);
	assert.equal(result.ok, true, `${JSON.stringify(op)}: ${JSON.stringify(result)}`);
	if (result.ok && expected !== undefined)
		assert.deepEqual(result.output, expected);
	return result;
}
async function failure(op: unknown, error: string) {
	assert.deepEqual(await owner.query(op), {
		ok: false,
		error,
	});
}
async function wire(data: string, mode: 'rg' | 'jq' = 'rg'): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(sockets[mode]);
		const parts: Buffer[] = [];
		socket.on('connect', () => socket.write(data));
		socket.on('data', (chunk: Buffer) => parts.push(chunk));
		socket.on('error', reject);
		socket.on('close', () => resolve(Buffer.concat(parts).toString()));
	});
}

const phase = process.argv[2] ?? 'queries';
if (phase === 'queries') {
	assert.ok(await owner.ready());
	await success(count, 2);
	await success({ ...count, operation: 'files' }, ['src/other.ts', 'src/send.ts']);
	const text = await success(search('Sendblue'));
	assert.ok(text.ok && String(text.output).includes('src/send.ts:1:Sendblue'));
	await success(jq('{scripts, dependencies: .dependencies | with_entries(select(.key | startswith("@mastra/")))}'), '{"scripts":{"test":"bun test"},"dependencies":{"@mastra/core":"1.71.0"}}\n');
	await success({ ...count, pattern: 'never_matches' }, 0);
	await success(jq('null'), 'null\n');
	await success(jq('false'), 'false\n');
	await success(jq('empty'), '');
	await success(jq('env.APP_SECRET'), 'null\n');
	await success(jq('type', 'docs/bounded.json'), '"object"\n');
	await failure(search('['), 'invalid');
	await failure(jq('['), 'invalid');
	await failure(jq('.', 'docs/invalid.json'), 'invalid');
	await failure(jq('.', 'missing.json'), 'missing');
	await failure({ ...count, path: 'missing' }, 'missing');
	await failure(jq('.', 'docs/large.json'), 'limit');
	for (const op of [{ ...count, path: '../private' }, { ...count, path: '/etc/passwd' }, { ...count, env: {} }, { ...count, command: 'sh' }, { ...count, globs: ['../*'] }, search('x'.repeat(limits.expressionBytes + 1)), jq('x'.repeat(limits.expressionBytes + 1)), { ...count, path: 'docs/escape' }, jq('.', 'docs/escape.json'), { ...count, path: 'docs/links' }])
		await failure(op, 'denied');
	await success({ ...count, pattern: '--pre=/bin/sh' }, 0);
	await success({ ...count, pattern: '$(touch /project/INJECTED); Sendblue', literal: true }, 0);
	await success({ ...count, globs: ['--pre=/bin/sh'] }, 0);
	await success(search('__jam86_boundary'), 'boundary checked\n');
	for (const file of ['second', 'large']) {
		for (const keyword of ['import', 'include'])
			await failure(jq(`${keyword} "${file}" ${keyword === 'import' ? 'as $x ' : ''}{search:"/project/docs"}; .`), 'invalid');
		await failure(jq(`import "${file}" as $x {search:"/project/docs"}; $x`), 'invalid');
	}
	await failure(jq('include "helper" {search:"/project/docs"}; helper'), 'invalid');
	await failure(jq('import "/project/docs/second" as $x; $x'), 'invalid');
	assert.deepEqual(JSON.parse(await wire('{bad}\n')), { ok: false, error: 'denied' });
	assert.equal(await wire(`${'x'.repeat(limits.requestBytes + 1)}\n`), '');
	const status = JSON.parse(await wire('{"type":"status"}\n')) as Status;
	const pinned = (await pinProjectView('/project'))!;
	for (const request of [{ type: 'query', instance: status.instance, view: pinned.view, op: jq('.'), input: 'e30=' }, { type: 'query', instance: status.instance, view: pinned.view, op: { ...count, cwd: '/' } }, { type: 'query', instance: 'stale', view: pinned.view, op: count }])
		assert.deepEqual(JSON.parse(await wire(`${JSON.stringify(request)}\n`)), { ok: false, error: 'denied' });
	const jqStatus = JSON.parse(await wire('{"type":"status"}\n', 'jq')) as Status;
	assert.deepEqual(JSON.parse(await wire(`${JSON.stringify({ type: 'query', instance: jqStatus.instance, view: pinned.view, op: jq('.'), input: 'invalid-base64' })}\n`, 'jq')), { ok: false, error: 'denied' });
	const missing = await createProjectCli('/project', { rg: '/absent', jq: sockets.jq });
	assert.deepEqual(await missing.query(count), { ok: false, error: 'unavailable' });
	console.log('PASS: results, no-match/invalid/missing, paths/symlinks, injection, jq visibility/import metadata, credentials/env/socket/fd, writes/network, bounded/malformed IPC, missing backend');
}
else if (phase === 'limits') {
	for (const fault of ['stdout', 'stderr', 'pids']) {
		await failure(search(`__jam86_${fault}`), 'limit');
		await success(count, 2);
	}
	await failure({ ...count, pattern: '__jam86_stdout' }, 'limit');
	await failure(jq('range(0; 1000000)'), 'limit');
	await failure(jq('def loop: loop; loop'), 'limit');
	const start = Date.now();
	const running = owner.query(search('__jam86_timeout'));
	await Bun.sleep(200);
	await failure(jq('.'), 'busy');
	await failure(count, 'busy');
	assert.deepEqual(await running, { ok: false, error: 'limit' });
	assert.ok(Date.now() - start >= limits.wallMs && Date.now() - start < limits.wallMs + 2000);
	await success(count, 2);
	await success(search('__jam86_reaped'), 'descendant reaped\n');
	console.log('PASS: stdout/stderr ceilings, PID ceiling, deadline, resistant descendant cleanup, cross-worker busy/slot reuse');
}
else if (phase === 'disconnect') {
	const cancellation = new AbortController();
	const running = owner.query(search('__jam86_timeout'), cancellation.signal);
	await Bun.sleep(300);
	cancellation.abort();
	assert.deepEqual(await running, { ok: false, error: 'unavailable' });
	assert.deepEqual(await owner.query(count), { ok: false, error: 'unavailable' });
	await Bun.sleep(300);
	assert.ok(await owner.ready());
	await success(search('__jam86_reaped'), 'descendant reaped\n');
	await success(count, 2);
	console.log('PASS: disconnect cancels/reaps, lost IPC fails closed, both idle instances required for reuse');
}
else if (phase === 'memory' || phase === 'crash') {
	const result = await owner.query(search(phase === 'memory' ? '__jam86_memory' : '__jam86_timeout'));
	assert.ok(!result.ok && ['limit', 'unavailable'].includes(result.error));
	if (!result.ok && result.error === 'unavailable')
		assert.deepEqual(await owner.query(count), { ok: false, error: 'unavailable' });
	if (phase === 'crash') {
		assert.deepEqual(await owner.query(count), { ok: false, error: 'unavailable' });
		await writeFile('/tmp/failure-observed', 'closed');
		const until = Date.now() + 10000;
		while (!await owner.ready()) {
			assert.ok(Date.now() < until, 'restarted worker did not establish idle');
			await Bun.sleep(50);
		}
		await success(count, 2);
	}
	console.log(`PASS: ${phase} never returns partial success`);
}
else if (phase === 'reuse') {
	assert.ok(await owner.ready());
	await success(count, 2);
	console.log('PASS: restarted instances establish idle before query reuse');
}
else { throw new Error('Unknown synthetic phase'); }
await assert.rejects(import('node:fs/promises').then(fs => fs.writeFile('/rg-ipc/app-write', 'denied')), (e: NodeJS.ErrnoException) => e.code === 'EROFS');
assert.equal((await readFile('/project/src/send.ts', 'utf8')).trim(), 'Sendblue');
