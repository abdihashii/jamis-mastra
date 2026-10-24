import type { FileHandle } from 'node:fs/promises';
import type { GenerationAttemptRef } from './generation-state';
import type { SqlLike } from './recaps';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';
import { readGenerationDebug } from './generation-runs';
import { GENERATION_STATE_VERSION, parseGenerationState } from './generation-state';

const version = 'fantasy-debug-export-v1';
const exportName = /^attempt-([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.json$/;

async function privateDirectory(directory: string, create: boolean): Promise<string | null> {
	const target = resolve(directory);
	let current = parse(target).root;
	for (const part of target.slice(current.length).split(sep).filter(Boolean)) {
		current = join(current, part);
		let stat;
		try {
			stat = await lstat(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
				throw error;
			if (!create)
				return null;
			try {
				await mkdir(current, { mode: 0o700 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
					throw error;
			}
			stat = await lstat(current);
		}
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error('generation_debug_directory_invalid');
	}
	const stat = await lstat(target);
	if ((stat.mode & 0o077) !== 0)
		throw new Error('generation_debug_directory_invalid');
	return target;
}

async function databaseNow(sql: SqlLike): Promise<number> {
	const [row] = await sql`SELECT clock_timestamp() AS db_now` as { db_now: Date }[];
	const now = row?.db_now.getTime();
	if (!Number.isFinite(now))
		throw new Error('generation_debug_clock_unavailable');
	return now;
}

/** Private local export only; neither successful reads nor exports authorize generation or publication. */
export async function exportGenerationDebug(
	ref: GenerationAttemptRef,
	sql: SqlLike,
	managedDirectory: string,
): Promise<{ attemptId: string; expiresAtUtc: string; path: string }> {
	let file: FileHandle | undefined;
	let path: string | undefined;
	try {
		const name = `attempt-${ref.attemptId}.json`;
		if (!exportName.test(name))
			throw new Error('generation_debug_reference_invalid');
		const debug = await readGenerationDebug(ref, sql);
		if (!debug || (debug.bundle.packetJson === null && !debug.bundle.outputs.length && !debug.bundle.notes.length))
			throw new Error('generation_debug_unavailable');
		const directory = await privateDirectory(managedDirectory, true);
		path = join(directory!, name);
		const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
		file = await open(path, flags, 0o600);
		try {
			await file.writeFile(JSON.stringify({ version, attempt: debug.attempt, bundle: debug.bundle }), 'utf8');
			await file.sync();
			if (await databaseNow(sql) >= Date.parse(debug.attempt.debugExpiresAtUtc))
				throw new Error('generation_debug_expired');
		} finally {
			await file.close();
		}
		return { attemptId: debug.attempt.id, expiresAtUtc: debug.attempt.debugExpiresAtUtc, path };
	} catch {
		// Close is attempted independently above, even if verification or cleanup fails.
		if (file && path) {
			try {
				await unlink(path);
			} catch {
				throw new Error('generation_debug_cleanup_failed');
			}
		}
		throw new Error('generation_debug_export_failed');
	}
}

/** Only validated, expired files in this managed directory belong to this purge; moved copies do not. */
export async function purgeGenerationDebugExports(sql: SqlLike, managedDirectory: string): Promise<number> {
	try {
		const directory = await privateDirectory(managedDirectory, false);
		if (!directory)
			return 0;
		const now = await databaseNow(sql);
		let removed = 0;
		for (const name of await readdir(directory)) {
			const match = exportName.exec(name);
			if (!match)
				continue;
			const path = join(directory, name);
			const before = await lstat(path);
			if (!before.isFile() || before.isSymbolicLink())
				continue;
			const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			let expired = false;
			try {
				const opened = await file.stat();
				if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
					continue;
				try {
					const envelope = JSON.parse(await file.readFile('utf8'));
					if (!envelope || envelope.version !== version || envelope.attempt?.id !== match[1]
						|| Object.keys(envelope).sort().join(',') !== 'attempt,bundle,version') {
						continue;
					}
					const state = parseGenerationState({
						version: GENERATION_STATE_VERSION,
						current: envelope.attempt,
						prior: [],
						debug: { [match[1]]: envelope.bundle },
					});
					expired = Date.parse(state.current.debugExpiresAtUtc) <= now;
				} catch {
					// Foreign or damaged payloads are not authority to delete a file.
					continue;
				}
			} finally {
				await file.close();
			}
			if (expired) {
				const current = await lstat(path);
				if (current.isFile() && current.dev === before.dev && current.ino === before.ino) {
					await unlink(path);
					removed++;
				}
			}
		}
		return removed;
	} catch {
		throw new Error('generation_debug_purge_failed');
	}
}
