import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test.each(['project-cli-smoke', 'project-cli-deploy-smoke'])('%s removes temporary fixtures when Docker is missing', async (script) => {
	const root = await mkdtemp(join(tmpdir(), 'jam86-cleanup-'));
	try {
		const child = Bun.spawn([
			process.execPath,
			'--no-env-file',
			fileURLToPath(new URL(`./${script}.ts`, import.meta.url)),
		], {
			env: { PATH: '', TMPDIR: root },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [exit, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		assert.notEqual(exit, 0);
		assert.match(stderr, /docker/);
		assert.deepEqual(await readdir(root), []);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});
