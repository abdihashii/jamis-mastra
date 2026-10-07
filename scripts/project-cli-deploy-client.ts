// Disposable Compose client only, never copied into the production app image.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import { createProjectCli } from '../src/mastra/project-cli';

const owner = await createProjectCli('/project');
const count = { operation: 'count', path: 'src', pattern: 'sendblue', ignoreCase: true, globs: ['*.ts'] };
const phase = process.argv[2];
if (phase === 'unavailable') {
	assert.equal(await owner.ready(), false);
	assert.deepEqual(await owner.query(count), { ok: false, error: 'unavailable' });
	assert.match(await readFile('/project/src/send.ts', 'utf8'), /Sendblue/);
}
else if (phase === 'drain') {
	assert.ok(await owner.ready());
	const started = Date.now();
	const pending = owner.query({ operation: 'search', path: 'src', pattern: '__jam86_timeout' });
	assert.deepEqual(await owner.query({ operation: 'jq', path: 'package.json', filter: '.' }), { ok: false, error: 'busy' });
	const result = await pending;
	assert.equal(result.ok, false);
	assert.ok(Date.now() - started >= 9500, 'deployment cancelled the query before its deadline');
	assert.ok(Date.now() - started < 13000);
	assert.ok(!result.ok && ['limit', 'unavailable'].includes(result.error));
}
else {
	assert.ok(await owner.ready());
	const result = await owner.query(count);
	assert.ok(result.ok);
	assert.equal(result.output, 2);
	const jq = await owner.query({ operation: 'jq', path: 'package.json', filter: '{scripts, dependencies}' });
	assert.ok(jq.ok);
	assert.deepEqual(JSON.parse(String(jq.output)), { scripts: { test: 'bun test' }, dependencies: { '@mastra/core': '1.71.0' } });
	assert.deepEqual(jq.view, result.view);
	for (const path of ['/run/project-rg/probe', '/run/project-jq/probe'])
		await assert.rejects(writeFile(path, 'x'), (e: NodeJS.ErrnoException) => e.code === 'EROFS');
	const importResult = await owner.query({ operation: 'jq', path: 'package.json', filter: 'import "second" as $x {search:"/project/docs"}; $x' });
	assert.deepEqual(importResult, { ok: false, error: 'invalid' });
}
console.log(`PASS: Compose client ${phase ?? 'queries'}`);
