import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { prepareProjectView } from './prepare-project-view';

const root = await realpath(await mkdtemp(join(tmpdir(), 'jam86-')));
const image = `jam86-isolation-${process.pid}`;

async function docker(args: string[]) {
	const child = Bun.spawn(['docker', ...args], { stdout: 'inherit', stderr: 'inherit' });
	return child.exited;
}

try {
	const checkout = join(root, 'checkout');
	for (const dir of ['src', 'docs', 'scripts', 'infra', 'clickhouse'])
		await mkdir(join(checkout, dir), { recursive: true });
	for (const path of ['Dockerfile', 'docker-compose.yml', 'docker-compose.prod.yml', 'tsconfig.json', 'eslint.config.mjs', 'clickhouse/memory.xml'])
		await writeFile(join(checkout, path), 'synthetic fixture\n');
	await writeFile(join(checkout, 'src/handler.ts'), 'Sendblue\n');
	await writeFile(join(checkout, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }));
	const view = await prepareProjectView(checkout);
	const context = join(root, 'image');
	await mkdir(context);
	// Copy only dependency manifests, patches, and the harness, never the checkout/env/data.
	for (const path of ['package.json', 'bun.lock'])
		await cp(new URL(`../${path}`, import.meta.url), join(context, path));
	await cp(new URL('../patches', import.meta.url), join(context, 'patches'), { recursive: true });
	await writeFile(join(context, 'probe.ts'), await readFile(new URL('./project-cli-linux-smoke.ts', import.meta.url)));
	await writeFile(join(context, 'Dockerfile'), [
		'FROM oven/bun:1.3.14-alpine',
		'WORKDIR /harness',
		'RUN apk add --no-cache bubblewrap ripgrep jq',
		'COPY package.json bun.lock ./',
		'COPY patches patches',
		'RUN bun install --frozen-lockfile --production',
		'COPY probe.ts ./',
		'USER bun',
		'CMD ["bun", "probe.ts"]',
		'',
	].join('\n'));
	assert.equal(await docker(['build', '--tag', image, context]), 0, 'Smoke image build failed');
	// Match production USER/init/supplementary group, read-only view and Docker defaults.
	// No privileged flag, added capabilities, custom seccomp, or app-wide memory limit.
	process.exitCode = await docker([
		'run',
		'--rm',
		'--init',
		'--user',
		'bun',
		'--group-add',
		'1000',
		'--mount',
		`type=bind,source=${await realpath(view.path)},target=/project,readonly`,
		image,
	]);
}
finally {
	try {
		await docker(['image', 'rm', image]);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
}
