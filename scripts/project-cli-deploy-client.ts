// Disposable Compose client only, never copied into the production app image.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import { createProjectCli } from '../src/mastra/project-cli';

const owner = await createProjectCli('/project');
const toolModule = '../project-query.js';
const { createProjectQueryTools } = await import(toolModule) as typeof import('../src/mastra/tools/project-query');
const tools = await createProjectQueryTools('/project');
const context = { observe: { span: async <T>(_name: string, fn: () => Promise<T> | T) => await fn(), log: () => {} } };
const count = { operation: 'count' as const, path: 'src', pattern: 'sendblue', ignoreCase: true, globs: ['*.ts'] };
const phase = process.argv[2];
if (phase === 'unavailable') {
	assert.equal(await owner.ready(), false);
	assert.deepEqual(await owner.query(count), { ok: false, error: 'unavailable' });
	assert.deepEqual(await tools.projectRg.execute!(count, context), { ok: false, error: 'unavailable' });
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
	const toolCount = await tools.projectRg.execute!({ operation: 'count', path: 'src', pattern: 'sendblue', ignoreCase: true, globs: ['*.ts'] }, context);
	assert.deepEqual(toolCount, result);
	assert.deepEqual(await tools.projectRg.execute!({ operation: 'files', path: 'src', pattern: 'sendblue', ignoreCase: true, globs: ['*.ts'] }, context), { ...result, operation: 'files', output: ['src/other.ts', 'src/send.ts'] });
	assert.deepEqual(await tools.projectRg.execute!({ operation: 'count', path: 'src', pattern: 'no-match-fixture' }, context), { ...result, output: 0 });
	assert.deepEqual(await tools.projectJq.execute!({ path: 'package.json', filter: '{scripts, dependencies}' }, context), jq);
	for (const [pattern, error] of [['[', 'invalid'], ['__jam86_stdout', 'limit']])
		assert.deepEqual(await tools.projectRg.execute!({ operation: 'count', path: 'src', pattern }, context), { ok: false, error });
	assert.deepEqual(await tools.projectJq.execute!({ path: 'missing.json', filter: '.' }, context), { ok: false, error: 'missing' });
	assert.deepEqual(await tools.projectJq.execute!({ path: '../private.json', filter: '.' }, context), { ok: false, error: 'denied' });
	for (const path of ['/run/project-rg/probe', '/run/project-jq/probe'])
		await assert.rejects(writeFile(path, 'x'), (e: NodeJS.ErrnoException) => e.code === 'EROFS');
	const importResult = await owner.query({ operation: 'jq', path: 'package.json', filter: 'import "second" as $x {search:"/project/docs"}; $x' });
	assert.deepEqual(importResult, { ok: false, error: 'invalid' });
	assert.deepEqual(await tools.projectJq.execute!({ path: 'package.json', filter: 'import "second" as $x {search:"/project/docs"}; $x' }, context), importResult);
}
console.log(`PASS: Compose client ${phase ?? 'queries'}`);
