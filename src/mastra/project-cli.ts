import type { Operation, Result, Status } from './project-cli-contract';
import { Buffer } from 'node:buffer';
import { open } from 'node:fs/promises';
import { createConnection } from 'node:net';

import { checkedProjectPath, isView, limits, sameView, validOperation } from './project-cli-contract';
import { pinProjectView } from './project-workspace';

// One slot across rg/jq and across accidental duplicate owners in this app process.
let active = false;

async function rpc(path: string, request: unknown, signal?: AbortSignal): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		const parts: Buffer[] = [];
		let bytes = 0;
		let complete = false;
		const cancel = () => socket.destroy(new Error('unavailable'));
		const timer = setTimeout(cancel, (request as { type: string }).type === 'status' ? 2000 : limits.wallMs + 2000);
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', cancel);
		};
		signal?.addEventListener('abort', cancel, { once: true });
		if (signal?.aborted)
			cancel();
		socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on('data', (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > limits.responseBytes || complete) {
				cancel();
				return;
			}
			parts.push(chunk);
		});
		socket.once('end', () => {
			try {
				const data = Buffer.concat(parts);
				if (data.indexOf(10) !== data.length - 1)
					throw new Error('unavailable');
				const response: unknown = JSON.parse(data.toString('utf8'));
				complete = true;
				finish();
				resolve(response);
			}
			catch { cancel(); }
		});
		socket.once('error', (e) => {
			finish();
			reject(e);
		});
		socket.once('close', () => {
			finish();
			if (!complete)
				reject(new Error('unavailable'));
		});
	});
}

// Transport and cleanup stay here. Callers see only bounded operations and typed outcomes.
export async function createProjectCli(path: string | undefined, sockets = { rg: '/run/project-rg/worker.sock', jq: '/run/project-jq/worker.sock' }) {
	const pinned = await pinProjectView(path);
	let identities: { rg: Status; jq: Status } | undefined;
	const unavailable: Result = { ok: false, error: 'unavailable' };
	async function status() {
		if (!pinned)
			throw new Error('unavailable');
		const statuses = await Promise.all((['rg', 'jq'] as const).map(async (mode) => {
			const value = await rpc(sockets[mode], { type: 'status' }) as Status;
			if (!value || typeof value.instance !== 'string' || !/^[a-f0-9-]{36}$/.test(value.instance) || value.mode !== mode || !value.idle || !isView(value.view) || !sameView(value.view, pinned.view))
				throw new Error('unavailable');
			return value;
		}));
		return { rg: statuses[0], jq: statuses[1] };
	}
	async function ready() {
		if (active)
			return false;
		active = true;
		try {
			identities = await status();
			return true;
		}
		catch {
			identities = undefined;
			return false;
		}
		finally { active = false; }
	}
	async function query(value: unknown, signal?: AbortSignal): Promise<Result> {
		if (!validOperation(value))
			return { ok: false, error: 'denied' };
		if (active)
			return { ok: false, error: 'busy' };
		if (!pinned || !identities || signal?.aborted)
			return unavailable;
		active = true;
		const op: Operation = value;
		try {
			let input: string | undefined;
			if (op.operation === 'jq') {
				let resolved: string;
				try {
					resolved = await checkedProjectPath(pinned.basePath, op.path);
				}
				catch (e) { return { ok: false, error: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'denied' }; }
				const file = await open(resolved, 'r');
				try {
					const stat = await file.stat();
					if (!stat.isFile())
						return { ok: false, error: 'denied' };
					if (stat.size > limits.jsonBytes)
						return { ok: false, error: 'limit' };
					const buffer = Buffer.alloc(limits.jsonBytes + 1);
					let size = 0;
					while (size < buffer.length) {
						const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
						if (bytesRead === 0)
							break;
						size += bytesRead;
					}
					if (size > limits.jsonBytes)
						return { ok: false, error: 'limit' };
					input = buffer.subarray(0, size).toString('base64');
				}
				finally { await file.close(); }
			}
			const mode = op.operation === 'jq' ? 'jq' : 'rg';
			const result = await rpc(sockets[mode], { type: 'query', instance: identities[mode].instance, view: pinned.view, op, ...(input === undefined ? {} : { input }) }, signal) as Result;
			if (!result || typeof result.ok !== 'boolean' || (result.ok
				? result.operation !== op.operation || result.path !== op.path || !isView(result.view) || !sameView(result.view, pinned.view) || (op.operation === 'count' ? !Number.isSafeInteger(result.output) || Number(result.output) < 0 : op.operation === 'files' ? !Array.isArray(result.output) || !result.output.every(p => typeof p === 'string') : typeof result.output !== 'string')
				: !['denied', 'missing', 'unavailable', 'invalid', 'limit', 'busy'].includes(result.error))) {
				throw new Error('unavailable');
			}
			const current = await status();
			if (current.rg.instance !== identities.rg.instance || current.jq.instance !== identities.jq.instance)
				throw new Error('unavailable');
			return result;
		}
		catch {
			identities = undefined; // No reconnect shortcut: both current instances must prove idle.
			return unavailable;
		}
		finally { active = false; }
	}
	await ready();
	return { query, ready };
}
