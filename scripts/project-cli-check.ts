import assert from 'node:assert/strict';
import process from 'node:process';

import { createProjectCli } from '../src/mastra/project-cli';

const cli = await createProjectCli(process.env.PROJECT_VIEW_PATH);
const until = Date.now() + 5000;
while (!await cli.ready()) {
	assert.ok(Date.now() < until, 'Matching idle project workers unavailable');
	await Bun.sleep(100);
}
for (const op of [
	{ operation: 'count', path: 'src', pattern: 'Sendblue', ignoreCase: true, globs: ['*.ts'] },
	{ operation: 'jq', path: 'package.json', filter: 'null' },
]) {
	const result = await cli.query(op);
	assert.ok(result.ok, `Project worker check failed: ${result.ok ? '' : result.error}`);
	console.log(`PASS: ${result.operation}, pinned generation ${result.view.generation}, prepared ${result.view.preparedAt}`);
}
