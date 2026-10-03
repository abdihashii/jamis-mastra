import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createWorkspaceTools } from '@mastra/core/workspace';

import { cleanupProjectViews, prepareProjectView } from '../../scripts/prepare-project-view';
import { createProjectWorkspace } from './project-workspace';

let root: string;
const denied = [
	'.env.prod',
	'.env.prod.bak',
	'.envrc',
	'env.prod.backup',
	'credentials.json',
	'credentials.bak',
	'google-auth.json.old',
	'service-account.json',
	'access-token.yaml',
	'tls.pem',
	'memory.db',
	'memory.db-wal',
	'memory.db-shm',
	'memory.sqlite3-journal',
	'memory.duckdb',
	'memory.duckdb.wal',
	'data/private.json',
	'runtime/private.json',
	'memory/private.json',
	'private/state.json',
	'logs/private.log',
	'.git/config',
	'node_modules/private.ts',
	'.mastra/private.ts',
	'dist/private.ts',
	'.firecrawl/private.md',
	'.pplx/private.json',
	'.aws/credentials',
];

async function put(path: string, content: string) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'jam79-')));
	for (const dir of ['src', 'docs', 'scripts', 'infra'])
		await mkdir(join(root, dir));
	for (const path of ['package.json', 'Dockerfile', 'docker-compose.yml', 'docker-compose.prod.yml', 'tsconfig.json', 'eslint.config.mjs', 'clickhouse/memory.xml'])
		await put(join(root, path), `approved config ${path}`);
	await put(join(root, 'src/handler.ts'), 'approved handler\napproved second line\n');
	await chmod(join(root, 'src/handler.ts'), 0o600);
	for (const path of denied)
		await put(join(root, 'src/nested', path), 'SYNTHETIC_PRIVATE_MARKER');
	await put(join(root, 'data/private.json'), 'SYNTHETIC_OUTSIDE_MARKER');
	await symlink(join(root, 'data/private.json'), join(root, 'src/escape.ts'));
	await symlink(join(root, 'data'), join(root, 'src/outside-directory'));
	await symlink('nested/.env.prod', join(root, 'src/excluded.ts'));
	await symlink('missing.ts', join(root, 'src/broken.ts'));
	await symlink('handler.ts', join(root, 'src/alias.ts'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

test('prepared view enforces the approved native read boundary and refreshes without stale entries', async () => {
	expect(await createProjectWorkspace('')).toBeUndefined();
	expect(await createProjectWorkspace('.')).toBeUndefined();
	expect(await createProjectWorkspace(root)).toBeUndefined();
	expect(await createProjectWorkspace(join(root, 'missing'))).toBeUndefined();
	const view = await prepareProjectView(root);
	const workspace = (await createProjectWorkspace(view.path))!;
	expect(workspace).toBeDefined();
	expect(workspace.getInstructions()).toContain(view.preparedAt);
	expect(workspace.sandbox).toBeUndefined();
	const fs = workspace.filesystem!;
	const tools = await createWorkspaceTools(workspace);
	expect(Object.keys(tools).sort()).toEqual([
		'mastra_workspace_file_stat',
		'mastra_workspace_grep',
		'mastra_workspace_list_files',
		'mastra_workspace_read_file',
	]);
	const secondLine = await tools.mastra_workspace_read_file.execute({ path: 'src/handler.ts', offset: 2, limit: 1 }, {});
	expect(secondLine).toContain('approved second line');
	expect(secondLine).not.toContain('approved handler');
	expect(await tools.mastra_workspace_read_file.execute({ path: 'docker-compose.prod.yml' }, {})).toContain('approved config');
	expect(await fs.readFile('src/alias.ts', { encoding: 'utf8' })).toContain('approved handler');
	expect(await tools.mastra_workspace_file_stat.execute({ path: 'src/handler.ts' }, {})).toBeDefined();
	expect(await readlink(join(view.path, 'src/escape.ts'))).toBe(join(root, 'data/private.json'));
	const listing = await tools.mastra_workspace_list_files.execute({ path: 'src', showHidden: true, maxDepth: 10 }, {});
	expect(listing).toContain('handler.ts');
	const excludedListing = await tools.mastra_workspace_list_files.execute({ path: 'src/nested', showHidden: true, maxDepth: 10 }, {});
	for (const path of denied) {
		expect(await fs.exists(`src/nested/${path}`)).toBe(false);
		await expect(tools.mastra_workspace_read_file.execute({ path: `src/nested/${path}` }, {})).rejects.toThrow();
		expect(excludedListing).not.toContain(path.split('/').at(-1)!);
	}
	for (const path of ['../data/private.json', join(root, 'data/private.json'), 'src/escape.ts', 'src/excluded.ts', 'src/outside-directory/private.json']) {
		await expect(tools.mastra_workspace_read_file.execute({ path }, {})).rejects.toThrow();
		await expect(fs.stat(path)).rejects.toThrow();
	}
	await expect(fs.readdir('src/outside-directory')).rejects.toThrow();
	await expect(tools.mastra_workspace_read_file.execute({ path: 'missing.ts' }, {})).rejects.toThrow();
	const search = await tools.mastra_workspace_grep.execute({ pattern: 'approved|SYNTHETIC_', path: 'src', includeHidden: true }, {});
	expect(search).toContain('approved handler');
	expect(search).toContain('skipped: read error');
	expect(search).not.toContain('SYNTHETIC_PRIVATE_MARKER');
	expect(search).not.toContain('SYNTHETIC_OUTSIDE_MARKER');
	expect(await tools.mastra_workspace_grep.execute({ pattern: 'approved', path: 'missing' }, {})).toContain('target path not found: nothing searched');
	for (const operation of [
		() => fs.writeFile('src/handler.ts', 'changed'),
		() => fs.appendFile('src/handler.ts', 'changed'),
		() => fs.deleteFile('src/handler.ts'),
		() => fs.copyFile('src/handler.ts', 'copy.ts'),
		() => fs.moveFile('src/handler.ts', 'moved.ts'),
		() => fs.mkdir('new'),
		() => fs.rmdir('src'),
	])
		await expect(operation()).rejects.toThrow(/read.only/i);
	await put(join(view.path, 'src/stale.env'), 'stale approved entry');
	await put(join(view.path, 'src/nested/.env.stale'), 'SYNTHETIC_STALE_MARKER');
	await put(join(root, 'src/replacement.ts'), 'replacement handler');
	await rename(join(root, 'src/replacement.ts'), join(root, 'src/handler.ts'));
	const refreshed = await prepareProjectView(root);
	const refreshedFs = (await createProjectWorkspace(refreshed.path))!.filesystem!;
	expect(await refreshedFs.readFile('src/handler.ts', { encoding: 'utf8' })).toBe('replacement handler');
	expect(await refreshedFs.exists('src/stale.env')).toBe(false);
	expect(await refreshedFs.exists('src/nested/.env.stale')).toBe(false);
	const published = await realpath(refreshed.path);
	await rename(join(root, 'Dockerfile'), join(root, 'Dockerfile.saved'));
	await expect(prepareProjectView(root)).rejects.toThrow();
	expect(await realpath(refreshed.path)).toBe(published);
	await writeFile(join(refreshed.path, '.prepared-at'), 'invalid timestamp');
	expect(await createProjectWorkspace(refreshed.path)).toBeUndefined();
}, 15000);

test('failed deployment preparations and retries preserve the running workspace', async () => {
	const initial = await prepareProjectView(root);
	const initialPath = await realpath(initial.path);
	const running = (await createProjectWorkspace(initial.path))!.filesystem!;
	await put(join(root, 'src/handler.ts'), 'replacement handler');
	const failed = await prepareProjectView(root); // Build fails before the app is recreated.
	const failedPath = await realpath(failed.path);
	const retry = await prepareProjectView(root);
	expect(await running.readFile('src/handler.ts', { encoding: 'utf8' })).toContain('approved handler');
	const replacement = (await createProjectWorkspace(retry.path))!.filesystem!;
	expect(await replacement.readFile('src/handler.ts', { encoding: 'utf8' })).toBe('replacement handler');
	await cleanupProjectViews(root); // The replacement app now owns the current generation.
	await expect(lstat(initialPath)).rejects.toThrow();
	await expect(lstat(failedPath)).rejects.toThrow();
	expect(await replacement.readFile('src/handler.ts', { encoding: 'utf8' })).toBe('replacement handler');
});

test.skipIf(!process.env.PROJECT_VIEW_DOCKER_SMOKE)('Linux mount rejects non-root writes and app-only recreation sees replaced content', async () => {
	const project = `jam79-${crypto.randomUUID().slice(0, 8)}`;
	const composePath = join(root, 'smoke.yml');
	const compose = ['docker', 'compose', '-p', project, '-f', composePath];
	async function run(args: string[], success = true) {
		const result = Bun.spawn([...args], { stdout: 'pipe', stderr: 'pipe' });
		const output = await new Response(result.stdout).text();
		const error = await new Response(result.stderr).text();
		expect(await result.exited, error).toBe(success ? 0 : 1);
		return output.trim();
	}
	try {
		// Resolve the real production overlay using only synthetic env and fixture paths.
		await put(join(root, '.env.prod'), 'TUNNEL_TOKEN=synthetic\nOPERATOR_TIMEZONE=UTC\n');
		for (const path of ['docker-compose.yml', 'docker-compose.prod.yml'])
			await writeFile(join(root, path), await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'));
		const config = JSON.parse(await run(['docker', 'compose', '--project-directory', root, '--env-file', join(root, '.env.prod'), '-f', join(root, 'docker-compose.yml'), '-f', join(root, 'docker-compose.prod.yml'), 'config', '--format', 'json']));
		const mount = config.services.app.volumes.find((volume: { target: string }) => volume.target === '/project');
		expect(mount.read_only).toBe(true);
		expect(mount.bind.create_host_path).toBe(false);
		expect(config.services.app.environment.PROJECT_VIEW_PATH).toBe('/project');
		const image = 'oven/bun:1.3.14-alpine';
		const idle = { image, command: ['sleep', '3600'] };
		await writeFile(composePath, JSON.stringify({ services: {
			app: { ...idle, user: 'bun', volumes: [mount] },
			postgres: idle,
			clickhouse: idle,
			cloudflared: idle,
		} }));
		// Missing bind source fails rather than creating an empty view.
		await run([...compose, 'up', '-d', 'app'], false);
		await expect(lstat(join(root, '.project-view'))).rejects.toThrow();
		expect(await createProjectWorkspace(join(root, '.project-view/current'))).toBeUndefined();
		await writeFile(join(root, 'scripts/prepare-project-view.ts'), await readFile(new URL('../../scripts/prepare-project-view.ts', import.meta.url), 'utf8'));
		const prepare = ['docker', 'run', '--rm', '--mount', `type=bind,source=${root},target=/checkout`, '-w', '/checkout', image, 'bun', 'scripts/prepare-project-view.ts'];
		await run(prepare);
		await run([...compose, 'up', '-d']);
		expect(await run([...compose, 'exec', '-T', 'app', 'id', '-u'])).toBe('1000');
		expect(await run([...compose, 'exec', '-T', 'app', 'cat', '/project/src/handler.ts'])).toContain('approved handler');
		// Readable permissions ensure EROFS is the control, not ordinary file ownership.
		await run([...compose, 'exec', '-T', 'app', 'bun', '-e', 'try { require("fs").writeFileSync("/project/src/handler.ts", "changed"); process.exit(1); } catch (e) { if (e.code !== "EROFS") { console.error(e.code); process.exit(1); } }']);
		const appBefore = await run([...compose, 'ps', '-q', 'app']);
		const imageBefore = await run(['docker', 'inspect', '--format', '{{.Image}}', appBefore]);
		const othersBefore = await run([...compose, 'ps', '-q', 'postgres', 'clickhouse', 'cloudflared']);
		await put(join(root, 'src/atomic.ts'), 'replacement handler');
		await rename(join(root, 'src/atomic.ts'), join(root, 'src/handler.ts'));
		await run(prepare);
		// Simulate a failed build, then retry preparation without replacing the healthy app.
		await run(prepare);
		expect(await run([...compose, 'exec', '-T', 'app', 'cat', '/project/src/handler.ts'])).toContain('approved handler');
		const deploy = await readFile(new URL('../../infra/deploy.sh', import.meta.url), 'utf8');
		expect(deploy.indexOf('--cleanup')).toBeGreaterThan(deploy.indexOf('--force-recreate app'));
		const commands = [...deploy.matchAll(/^docker compose .* (up .+)$/gm)].map(match => match[1].split(' '));
		expect(commands).toHaveLength(3);
		for (const args of commands) {
			await run([...compose, ...args]);
			if (args.includes('--force-recreate'))
				await run([...prepare, '--cleanup']);
		}
		const appAfter = await run([...compose, 'ps', '-q', 'app']);
		expect(appAfter).not.toBe(appBefore);
		expect(await run(['docker', 'inspect', '--format', '{{.Image}}', appAfter])).toBe(imageBefore);
		expect(await run([...compose, 'ps', '-q', 'postgres', 'clickhouse', 'cloudflared'])).toBe(othersBefore);
		expect(await run([...compose, 'exec', '-T', 'app', 'cat', '/project/src/handler.ts'])).toBe('replacement handler');
		console.warn('Linux smoke: UID 1000, EROFS, unchanged image, fresh read, only app recreated.');
	}
	finally {
		await run([...compose, 'down', '--volumes', '--remove-orphans']);
	}
}, 120000);
