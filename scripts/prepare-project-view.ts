import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';

const directories = ['src', 'docs', 'scripts', 'infra'];
const files = ['package.json', 'Dockerfile', 'docker-compose.yml', 'docker-compose.prod.yml', 'tsconfig.json', 'eslint.config.mjs', 'clickhouse/memory.xml'];
const excludedDirectories = new Set([
	'.git',
	'node_modules',
	'.mastra',
	'dist',
	'build',
	'coverage',
	'.firecrawl',
	'.pplx',
	'.project-view',
	'data',
	'runtime',
	'memory',
	'logs',
	'private',
	'credentials',
	'secrets',
	'.aws',
	'.ssh',
	'.codex',
	'.claude',
	'.agents',
	'.cache',
]);

function excluded(path: string) {
	const name = basename(path).toLowerCase();
	return excludedDirectories.has(name)
		|| name.startsWith('.env') || /^env(?:[._-]|$)/.test(name)
		|| /(?:credential|secret|token|auth|service[-_]account).*\.(?:json|ya?ml|toml|ini|conf)(?:[.~_-]|$)/.test(name)
		|| /\.(?:bak|backup|old|orig|save)(?:[.~_-]|$)/.test(name)
		|| /\.(?:pem|key|p12|pfx|db|sqlite3?|duckdb)(?:[.~_-]|$)/.test(name);
}

// Owns selection, recursive exclusion, validation, and publication for dev and prod.
export async function prepareProjectView(checkout = process.cwd()) {
	const root = await realpath(checkout);
	const store = join(root, '.project-view');
	await mkdir(store, { recursive: true });
	const fresh = await mkdtemp(join(store, 'view-'));
	const pointer = join(store, `${basename(fresh)}.link`);
	let published = false;
	try {
		for (const path of [...directories, ...files]) {
			const source = join(root, path);
			const stat = await lstat(source);
			if (directories.includes(path) ? !stat.isDirectory() : !stat.isFile())
				throw new Error(`Approved path has the wrong type: ${path}`);
			if (await realpath(dirname(source)) !== dirname(source))
				throw new Error(`Approved path has a symlink ancestor: ${path}`);
			await mkdir(dirname(join(fresh, path)), { recursive: true });
			await cp(source, join(fresh, path), {
				recursive: true,
				dereference: false,
				verbatimSymlinks: true,
				filter: path => !excluded(path),
			});
		}
		// Validate the staged tree without following symlinks or reading file contents.
		const entries = await readdir(fresh);
		for (const path of entries) {
			const stat = await lstat(join(fresh, path));
			if (excluded(path) || !(stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()))
				throw new Error(`Invalid prepared entry: ${path}`);
			if (!stat.isSymbolicLink())
				await chmod(join(fresh, path), stat.isDirectory() ? 0o755 : 0o644);
			if (stat.isDirectory())
				entries.push(...(await readdir(join(fresh, path))).map(entry => join(path, entry)));
		}
		await chmod(fresh, 0o755);
		const preparedAt = new Date().toISOString();
		await writeFile(join(fresh, '.prepared-at'), `${preparedAt}\n`, { mode: 0o644 });
		await chmod(join(fresh, '.prepared-at'), 0o644);
		const generation = basename(fresh);
		await writeFile(join(fresh, '.project-view.json'), `${JSON.stringify({ generation, preparedAt })}\n`, { mode: 0o644 });
		await chmod(join(fresh, '.project-view.json'), 0o644);
		const current = join(store, 'current');
		await symlink(basename(fresh), pointer);
		await rename(pointer, current);
		published = true;
		return { path: current, generation, preparedAt };
	}
	catch (error) {
		await rm(pointer, { force: true });
		// Never remove a generation that was already published.
		if (!published)
			await rm(fresh, { recursive: true, force: true });
		throw error;
	}
}

// Call only after app and workers have switched; preparation cannot retire live mounts.
export async function cleanupProjectViews(checkout = process.cwd(), generation?: string) {
	const store = join(await realpath(checkout), '.project-view');
	const current = await readlink(join(store, 'current'));
	if (generation !== undefined && current !== generation)
		throw new Error('Prepared view changed during deployment; retain all generations');
	for (const entry of await readdir(store)) {
		if (entry.startsWith('view-') && entry !== current)
			await rm(join(store, entry), { recursive: true, force: true });
	}
}

if (import.meta.main) {
	if (process.argv[2] === '--cleanup') {
		await cleanupProjectViews(resolve(process.argv[3] ?? '.'), process.argv[4]);
	}
	else {
		const view = await prepareProjectView(resolve(process.argv[2] ?? '.'));
		console.log(`Project view prepared at ${view.preparedAt}\nPROJECT_VIEW_PATH=${view.path}`);
	}
}
