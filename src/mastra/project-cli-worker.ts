/* eslint-disable antfu/no-top-level-await -- Fixed worker process entrypoint. */
import type { Socket } from 'node:net';

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, readdir, readFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';

import type { Failure, Operation, ProjectView, Result } from './project-cli-contract';

import { checkedProjectPath, isView, limits, sameView, validOperation } from './project-cli-contract';

const mode = process.argv[2];
if (mode !== 'rg' && mode !== 'jq')
	throw new Error('Fixed worker mode required');
const view: unknown = JSON.parse(mode === 'rg' ? await readFile('/project/.project-view.json', 'utf8') : process.env.PROJECT_CLI_VIEW ?? 'null');
if (!isView(view))
	throw new Error('Pinned view required');
if (mode === 'rg' && (await readFile('/project/.prepared-at', 'utf8')).trim() !== view.preparedAt)
	throw new Error('Pinned view mismatch');
const instance = crypto.randomUUID();
let active = false;
let draining = false;
let activeSocket: Socket | undefined;
const sockets = new Set<Socket>();

async function scope(path: string, deadline: number, signal: AbortSignal) {
	const root = '/project';
	const target = await checkedProjectPath(root, path);
	// rg never follows symlinks. Reject them rather than silently produce an incomplete result.
	const entries = [target];
	for (const entry of entries) {
		if (Date.now() >= deadline || signal.aborted)
			throw new Error('limit');
		const stat = await lstat(entry);
		if (!(stat.isDirectory() || stat.isFile()))
			throw new Error('denied');
		await access(entry, constants.R_OK);
		if (stat.isDirectory())
			entries.push(...(await readdir(entry)).map(p => join(entry, p)));
	}
}

async function groupExists(pid: number) {
	for (const entry of await readdir('/proc')) {
		if (!/^\d+$/.test(entry))
			continue;
		try {
			const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
			if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) === pid)
				return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
				throw e;
		}
	}
	return false;
}

function decodeInput(value: unknown) {
	if (typeof value !== 'string' || value.length > Math.ceil(limits.jsonBytes / 3) * 4)
		return undefined;
	const buffer = Buffer.from(value, 'base64');
	return buffer.length <= limits.jsonBytes && buffer.toString('base64') === value ? buffer : undefined;
}

async function execute(op: Operation, input: Buffer | undefined, disconnected: AbortSignal): Promise<Result> {
	const deadline = Date.now() + limits.wallMs;
	const failure = (error: Failure): Result => ({ ok: false, error });
	if (op.operation !== 'jq') {
		try {
			await scope(op.path, deadline, disconnected);
		} catch (e) { return failure((e as Error).message === 'limit' ? 'limit' : (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'denied'); }
	}
	if (disconnected.aborted)
		return failure('unavailable');
	const args = op.operation === 'jq'
		? ['-c', '-M', '-L', '/nonexistent', '--', op.filter]
		: ['--no-config', '--no-ignore', '--text', '--hidden', '--color', 'never', '--sort', 'path', ...(op.operation === 'search' ? ['--line-number', '--with-filename', '--no-heading'] : ['--files-with-matches', '--null']), ...(op.ignoreCase ? ['--ignore-case'] : []), ...(op.literal ? ['--fixed-strings'] : []), ...(op.globs ?? []).flatMap(g => ['--glob', g]), '--', op.pattern, op.path];
	const child = spawn(op.operation === 'jq' ? '/usr/bin/jq' : '/usr/bin/rg', args, {
		cwd: op.operation === 'jq' ? '/' : '/project',
		detached: true,
		env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	let error: Failure | undefined;
	const chunks: Buffer[][] = [[], []];
	const sizes = [0, 0];
	const kill = () => {
		if (child.pid) {
			try {
				process.kill(-child.pid, 'SIGKILL');
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
					throw e;
			}
		}
	};
	const cancel = () => {
		error = 'unavailable';
		kill();
	};
	disconnected.addEventListener('abort', cancel, { once: true });
	const timer = setTimeout(() => {
		error = 'limit';
		kill();
	}, Math.max(0, deadline - Date.now()));
	for (const [index, stream] of [child.stdout, child.stderr].entries()) {
		stream.on('data', (data: Buffer) => {
			sizes[index] += data.length;
			if (sizes[index] > limits.streamBytes) {
				error = 'limit';
				kill();
			} else { chunks[index].push(data); }
		});
	}
	child.stdin.on('error', () => { /* EPIPE after a cancelled/failed command is expected. */ });
	child.stdin.end(input);
	const exit = await new Promise<number | null>((resolve) => {
		child.once('error', () => {
			error = 'unavailable';
			resolve(null);
		});
		child.once('close', code => resolve(code));
	});
	clearTimeout(timer);
	disconnected.removeEventListener('abort', cancel);
	kill();
	// Docker --init adopts orphan descendants. Do not acknowledge cleanup until they are reaped.
	if (child.pid) {
		const until = Date.now() + 1000;
		while (await groupExists(child.pid)) {
			if (Date.now() >= until)
				process.exit(1); // Ambiguous cleanup closes admission; never send a successful reply.
			await Bun.sleep(10);
		}
	}
	if (error)
		return failure(error);
	if (exit === null || (exit !== 0 && !(op.operation !== 'jq' && exit === 1)))
		return failure(exit === null || exit >= 128 ? 'limit' : 'invalid');
	if (op.operation !== 'jq' && sizes[1] > 0)
		return failure('invalid');
	const stdout = Buffer.concat(chunks[0]).toString('utf8');
	const files = stdout.split('\0').filter(Boolean);
	return { ok: true, operation: op.operation, path: op.path, view: view as ProjectView, output: op.operation === 'count' ? files.length : op.operation === 'files' ? files : stdout };
}

const socketPath = '/ipc/worker.sock';
await unlink(socketPath).catch((e) => {
	if (e.code !== 'ENOENT')
		throw e;
});
const server = createServer((socket) => {
	sockets.add(socket);
	let bytes = 0;
	let parts: Buffer[] = [];
	let received = false;
	const disconnected = new AbortController();
	socket.setTimeout(limits.wallMs + 2000, () => socket.destroy());
	socket.on('error', () => socket.destroy());
	socket.on('close', () => {
		sockets.delete(socket);
		disconnected.abort();
		finishDrain();
	});
	const reply = (result: unknown) => {
		if (!socket.destroyed)
			socket.end(`${JSON.stringify(result)}\n`);
	};
	socket.on('data', async (chunk: Buffer) => {
		if (received) {
			socket.destroy();
			return;
		}
		bytes += chunk.length;
		if (bytes > limits.requestBytes) {
			socket.destroy();
			return;
		}
		parts.push(chunk);
		if (!chunk.includes(10))
			return;
		received = true;
		const data = Buffer.concat(parts);
		parts = [];
		if (data.indexOf(10) !== data.length - 1) {
			socket.destroy();
			return;
		}
		let request;
		try {
			request = JSON.parse(data.toString('utf8'));
		} catch {
			reply({
				ok: false,
				error: 'denied',
			});
			return;
		}
		if (request && request.type === 'status' && Object.keys(request).length === 1) {
			reply({ instance, mode, view, idle: !active && !draining });
			return;
		}
		const input = mode === 'jq' ? decodeInput(request?.input) : undefined;
		if (!request || Object.keys(request).some(k => !['type', 'instance', 'view', 'op', 'input'].includes(k)) || request.type !== 'query' || request.instance !== instance || !isView(request.view) || !sameView(request.view, view as ProjectView) || !validOperation(request.op) || (mode === 'jq') !== (request.op.operation === 'jq')
			|| (mode === 'rg' ? request.input !== undefined : !input)) {
			reply({ ok: false, error: 'denied' });
			return;
		}
		if (draining) {
			reply({ ok: false, error: 'unavailable' });
			return;
		}
		if (active) {
			reply({
				ok: false,
				error: 'busy',
			});
			return;
		}
		active = true;
		activeSocket = socket;
		try {
			reply(await execute(request.op, input, disconnected.signal));
		} catch {
			// Unconfirmed cleanup requires container restart, never an idle acknowledgement.
			process.exit(1);
		} finally {
			active = false;
			activeSocket = undefined;
			finishDrain();
		}
	});
});
server.maxConnections = 8;
process.umask(0o117);
server.listen(socketPath);

// Stop admission first, preserving only the active query's connection and deadline.
function finishDrain() {
	if (draining && !active && sockets.size === 0)
		process.exit(0);
}
function drain() {
	if (draining)
		return;
	draining = true;
	server.close(finishDrain);
	for (const socket of sockets) {
		if (socket !== activeSocket)
			socket.destroy();
	}
}
process.on('SIGTERM', drain);
process.on('SIGINT', drain);
