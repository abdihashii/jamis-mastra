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
		for (const path of await readdir(fresh, { recursive: true })) {
			const stat = await lstat(join(fresh, path));
			if (excluded(path) || !(stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()))
				throw new Error(`Invalid prepared entry: ${path}`);
			if (!stat.isSymbolicLink())
				await chmod(join(fresh, path), stat.isDirectory() ? 0o755 : 0o644);
		}
		await chmod(fresh, 0o755);
		const preparedAt = new Date().toISOString();
		await writeFile(join(fresh, '.prepared-at'), `${preparedAt}\n`, { mode: 0o644 });
		await chmod(join(fresh, '.prepared-at'), 0o644);
		const current = join(store, 'current');
		const previous = await readlink(current).catch(() => undefined);
		await symlink(basename(fresh), pointer);
		await rename(pointer, current);
		published = true;
		// ponytail: retain one retired view for existing bind mounts; deploy recreates app.
		for (const entry of await readdir(store)) {
			if (entry.startsWith('view-') && entry !== basename(fresh) && entry !== previous)
				await rm(join(store, entry), { recursive: true, force: true });
		}
		return { path: current, preparedAt };
	}
	catch (error) {
		await rm(pointer, { force: true });
		// Never remove a generation that was already published.
		if (!published)
			await rm(fresh, { recursive: true, force: true });
		throw error;
	}
}

if (import.meta.main) {
	const view = await prepareProjectView(resolve(process.argv[2] ?? '.'));
	console.log(`Project view prepared at ${view.preparedAt}\nPROJECT_VIEW_PATH=${view.path}`);
}
