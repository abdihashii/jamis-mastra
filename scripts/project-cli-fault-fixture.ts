// Disposable proof image only. Never copied into Dockerfile.project-cli or agent operations.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { readdir, readFile, readlink, unlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import process from 'node:process';

async function noControlDescriptors(pids: number[]) {
	const controls = new Set<string>();
	for (const entry of await readdir(`/proc/${process.ppid}/fd`)) {
		const link = await readlink(`/proc/${process.ppid}/fd/${entry}`).catch(() => '');
		if (link.startsWith('socket:'))
			controls.add(link);
	}
	const listener = (await readFile('/proc/net/unix', 'utf8')).split('\n').find(line => line.endsWith('/ipc/worker.sock'))?.trim().split(/\s+/)[6];
	assert.ok(listener && controls.has(`socket:[${listener}]`) && controls.size >= 2, 'must identify parent controls');
	for (const pid of pids) {
		for (const entry of await readdir(`/proc/${pid}/fd`)) {
			const link = await readlink(`/proc/${pid}/fd/${entry}`).catch(() => '');
			// Bun stdio uses socket pairs, sometimes with duplicate fds. Identify actual controls.
			assert.ok(!controls.has(link), 'query inherited a control socket');
		}
	}
}

const args = process.argv.slice(2);
const fault = args.at(-2);
if (!fault?.startsWith('__jam86_')) {
	const child = Bun.spawn(['/usr/bin/rg-real', ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
	process.exit(await child.exited);
}
if (fault === '__jam86_boundary') {
	let category = 'environment';
	try {
		assert.equal(process.env.APP_SECRET, undefined);
		assert.equal(process.env.RIPGREP_CONFIG_PATH, undefined);
		assert.equal(process.env.TZ, 'UTC');
		assert.equal(process.env.LC_ALL, 'C');
		category = 'filesystem visibility';
		for (const path of ['/app/.env', '/private/state.json', '/run/evidence.sock', '/var/run/docker.sock', '/project/src/.env'])
			await assert.rejects(readFile(path));
		category = 'inherited descriptors';
		await noControlDescriptors([process.pid]);
		category = 'read-only filesystems';
		for (const path of ['/project/src/send.ts', '/worker/new', '/usr/bin/new'])
			await assert.rejects(writeFile(path, 'changed'), (e: NodeJS.ErrnoException) => e.code === 'EROFS');
		category = 'network';
		await new Promise<void>((resolve, reject) => {
			const socket = createConnection({ host: '1.1.1.1', port: 53 });
			socket.setTimeout(200, () => socket.destroy(new Error('unreachable')));
			socket.on('error', () => resolve());
			socket.on('connect', () => {
				socket.destroy();
				reject(new Error('network available'));
			});
		});
		console.log('boundary checked');
	}
	catch { console.log(`FAIL: ${category}`); }
}
else if (fault === '__jam86_timeout') {
	process.on('SIGTERM', () => {});
	const child = spawn('/bin/sh', ['-c', 'trap "" TERM; sleep 60'], { stdio: 'inherit' });
	await writeFile('/ipc/descendant.pid', String(child.pid));
	await Bun.sleep(100);
	process.kill(child.pid!, 'SIGTERM');
	await Bun.sleep(100);
	await noControlDescriptors([process.pid, child.pid!]);
	assert.ok(await readFile(`/proc/${child.pid}/stat`), 'descendant must resist SIGTERM');
	await new Promise(() => {});
}
else if (fault === '__jam86_reaped') {
	const pid = (await readFile('/ipc/descendant.pid', 'utf8')).trim();
	await assert.rejects(readFile(`/proc/${pid}/stat`));
	await unlink('/ipc/descendant.pid');
	console.log('descendant reaped');
}
else if (fault === '__jam86_memory') {
	const buffers: Buffer[] = [];
	while (true) buffers.push(Buffer.alloc(16 * 1024 * 1024, 1));
}
else if (fault === '__jam86_pids') {
	while (true) {
		const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
		await new Promise<void>((resolve) => {
			child.once('spawn', resolve);
			child.once('error', () => process.exit(137));
		});
	}
}
else if (fault === '__jam86_stdout' || fault === '__jam86_stderr') {
	const stream = fault === '__jam86_stdout' ? process.stdout : process.stderr;
	for (let i = 0; i < 1000; i++) stream.write('x'.repeat(4096));
}
else { process.exit(2); }
