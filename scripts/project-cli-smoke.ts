import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { limits } from '../src/mastra/project-cli-contract';
import { prepareProjectView } from './prepare-project-view';

const root = await realpath(await mkdtemp(join(tmpdir(), 'jam86-')));
const id = `jam86-${crypto.randomUUID().slice(0, 8)}`;
const image = `${id}:worker`;
const faultImage = `${id}:faults`;
const containers = [id, `${id}-rg`, `${id}-jq`];
const volumes = [`${id}-rg-ipc`, `${id}-jq-ipc`];
let backendAvailable = false;
async function docker(args: string[], allowFailure = false) {
	const child = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
	const [exit, out, err] = await Promise.all(
		[child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()],
	);
	if (!allowFailure)
		assert.equal(exit, 0, `docker ${args[0]} failed: ${err.slice(-2000)}`);
	return { exit, out, err };
}
try {
	await docker(['version']);
	backendAvailable = true;
	const checkout = join(root, 'checkout');
	for (const dir of ['src', 'docs', 'scripts', 'infra', 'clickhouse']) await mkdir(join(checkout, dir), { recursive: true });
	for (const path of ['Dockerfile', 'docker-compose.yml', 'docker-compose.prod.yml', 'tsconfig.json', 'eslint.config.mjs', 'clickhouse/memory.xml']) await writeFile(join(checkout, path), 'synthetic fixture\n');
	await writeFile(join(checkout, 'src/send.ts'), 'Sendblue\n');
	await writeFile(join(checkout, 'src/other.ts'), 'sendblue\n');
	await writeFile(join(checkout, 'src/.ignore'), 'other.ts\n');
	await writeFile(join(checkout, 'tsconfig.json'), '{}\n');
	await writeFile(join(checkout, 'src/.env'), 'SYNTHETIC_PRIVATE');
	await writeFile(join(checkout, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' }, dependencies: { '@mastra/core': '1.71.0', 'unrelated': '1' } }));
	await writeFile(join(checkout, 'docs/second.json'), '{"second":"SYNTHETIC_SECOND"}');
	await writeFile(join(checkout, 'docs/large.json'), JSON.stringify('x'.repeat(4 * 1024 * 1024)));
	await writeFile(join(checkout, 'docs/bounded.json'), `{}${' '.repeat(4 * 1024 * 1024 - 2)}`);
	await writeFile(join(checkout, 'docs/invalid.json'), '{');
	await writeFile(join(checkout, 'docs/helper.jq'), 'def helper: "SYNTHETIC_MODULE";');
	await mkdir(join(checkout, 'docs/links'));
	await mkdir(join(root, 'private'));
	await writeFile(join(root, 'private/secret.json'), '{"secret":"SYNTHETIC_PRIVATE"}');
	await symlink(join(root, 'private'), join(checkout, 'docs/escape'));
	await symlink(join(root, 'private/secret.json'), join(checkout, 'docs/escape.json'));
	await symlink(join(root, 'private'), join(checkout, 'docs/links/escape'));
	const view = await prepareProjectView(checkout);
	const generation = await realpath(view.path);
	// Make DAC permit the synthetic write, so the read-only mount is the enforcing control.
	await chmod(join(generation, 'src/send.ts'), 0o666);
	const context = join(root, 'image');
	await mkdir(join(context, 'src/mastra'), { recursive: true });
	for (const name of ['project-cli-contract.ts', 'project-cli-worker.ts']) await cp(new URL(`../src/mastra/${name}`, import.meta.url), join(context, 'src/mastra', name));
	await cp(new URL('../Dockerfile.project-cli', import.meta.url), join(context, 'Dockerfile'));
	await docker(['build', '--tag', image, context]);
	await cp(new URL('./project-cli-fault-fixture.ts', import.meta.url), join(context, 'fault.ts'));
	await writeFile(join(context, 'wrapper'), '#!/bin/sh\nexec /usr/local/bin/bun --no-env-file /fault.ts "$@"\n');
	await writeFile(join(context, 'Dockerfile.fault'), `FROM ${image}\nUSER root\nRUN mv /usr/bin/rg /usr/bin/rg-real\nCOPY fault.ts /fault.ts\nCOPY wrapper /usr/bin/rg\nRUN chmod 755 /usr/bin/rg && touch /worker/write-probe /usr/bin/write-probe && chmod 666 /worker/write-probe /usr/bin/write-probe\nUSER bun\n`);
	await docker(['build', '-f', join(context, 'Dockerfile.fault'), '--tag', faultImage, context]);
	const proof = join(root, 'proof');
	await mkdir(join(proof, 'src/mastra'), { recursive: true });
	await mkdir(join(proof, 'scripts'));
	for (const name of ['project-cli.ts', 'project-cli-contract.ts', 'project-workspace.ts']) await cp(new URL(`../src/mastra/${name}`, import.meta.url), join(proof, 'src/mastra', name));
	await cp(new URL('./project-cli-linux-smoke.ts', import.meta.url), join(proof, 'scripts/project-cli-linux-smoke.ts'));
	const isolated = ['--init', '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m'];
	for (const [index, mode] of ['rg', 'jq'].entries()) {
		await docker(['volume', 'create', volumes[index]]);
		await docker(['run', '-d', '--name', containers[index + 1], ...isolated, '--memory', '256m', '--memory-swap', '256m', '--pids-limit', '64', '--mount', `type=volume,source=${volumes[index]},target=/ipc`, ...(mode === 'rg' ? ['--mount', `type=bind,source=${generation},target=/project,readonly`] : ['--env', `PROJECT_CLI_VIEW=${JSON.stringify({ generation: view.generation, preparedAt: view.preparedAt })}`]), mode === 'rg' ? faultImage : image, mode]);
	}
	const client = (phase: string) => docker(['run', '--rm', '--name', id, ...isolated, '--env', 'APP_SECRET=SYNTHETIC_APP_SECRET', '--mount', `type=bind,source=${generation},target=/project,readonly`, '--mount', `type=bind,source=${proof},target=/proof,readonly`, '--mount', `type=volume,source=${volumes[0]},target=/rg-ipc,readonly`, '--mount', `type=volume,source=${volumes[1]},target=/jq-ipc,readonly`, '--entrypoint', 'bun', image, '--no-env-file', '/proof/scripts/project-cli-linux-smoke.ts', phase]);
	await Bun.sleep(500);
	for (const name of containers.slice(1)) {
		const inspection = JSON.parse((await docker(['inspect', name])).out)[0];
		assert.equal(inspection.Config.User, 'bun');
		assert.equal(inspection.HostConfig.Memory, 256 * 1024 * 1024);
		assert.equal(inspection.HostConfig.MemorySwap, inspection.HostConfig.Memory);
		assert.equal(inspection.HostConfig.PidsLimit, 64);
		assert.equal(inspection.HostConfig.NetworkMode, 'none');
		assert.equal(inspection.HostConfig.PidMode, '');
		assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
		assert.equal(inspection.HostConfig.Privileged, false);
		assert.deepEqual(inspection.HostConfig.CapDrop, ['ALL']);
		assert.ok(inspection.HostConfig.SecurityOpt.includes('no-new-privileges'));
		assert.ok(inspection.Mounts.every((m: { Destination: string }) => ['/project', '/ipc'].includes(m.Destination)));
	}
	console.log('PASS: non-root Docker isolation, private PID namespaces, 256 MiB including supervisor/swap, PID limits, no network/privileges, minimal mounts');
	// Positive controls prove the rejected jq expressions are valid when synthetic files are visible.
	for (const [filter, marker] of [
		['import "second" as $x {search:"/project/docs"}; $x', 'SYNTHETIC_SECOND'],
		['include "helper" {search:"/project/docs"}; helper', 'SYNTHETIC_MODULE'],
	]) {
		assert.ok((await docker(['exec', containers[1], '/usr/bin/jq', '-nc', '-L', '/nonexistent', '--', filter])).out.includes(marker));
	}
	assert.ok(Number((await docker(['exec', containers[1], '/usr/bin/jq', '-nc', '-L', '/nonexistent', '--', 'import "large" as $x {search:"/project/docs"}; $x | tostring | length'])).out) > 4 * 1024 * 1024);
	console.log('PASS: jq import/include metadata positive controls (synthetic fixtures only)');
	for (const phase of ['queries', 'limits', 'disconnect']) console.log((await client(phase)).out.trim());
	const pidEvents = (await docker(['exec', containers[1], 'cat', '/sys/fs/cgroup/pids.events'])).out;
	assert.ok(Number(pidEvents.match(/max (\d+)/)?.[1]) > 0);
	console.log((await client('memory')).out.trim());
	const memoryEvents = await docker(['exec', containers[1], 'cat', '/sys/fs/cgroup/memory.events'], true);
	const inspection = JSON.parse((await docker(['inspect', containers[1]])).out)[0];
	assert.ok(inspection.State.OOMKilled || Number(memoryEvents.out.match(/oom_kill (\d+)/)?.[1]) > 0, 'hard memory ceiling not exercised');
	await docker(['restart', containers[1]]);
	await Bun.sleep(300);
	console.log((await client('reuse')).out.trim());
	for (const crashKind of ['worker', 'container']) {
		await docker(['exec', containers[1], 'rm', '-f', '/ipc/descendant.pid']);
		const crash = client('crash');
		void crash.catch(() => {}); // The awaited failure below still fails the gate; cleanup may stop this client first.
		const until = Date.now() + 5000;
		while ((await docker(['exec', containers[1], '/bin/sh', '-c', 'test -s /ipc/descendant.pid'], true)).exit !== 0) {
			assert.ok(Date.now() < until, 'crash fixture never launched its descendant');
			await Bun.sleep(50);
		}
		if (crashKind === 'worker')
			await docker(['exec', containers[1], 'bun', '--no-env-file', '-e', 'const fs = require("fs"); const pid = fs.readdirSync("/proc").find(p => /^\\d+$/.test(p) && Number(p) > 1 && (() => { try { return fs.readFileSync("/proc/" + p + "/cmdline", "utf8").split("\\0").includes("/worker/project-cli-worker.ts"); } catch { return false; } })()); if (!pid) process.exit(1); process.kill(Number(pid), "SIGKILL");']);
		else await docker(['kill', containers[1]]);
		const observedBy = Date.now() + limits.wallMs + 3000;
		while ((await docker(['exec', id, '/bin/sh', '-c', 'test -s /tmp/failure-observed'], true)).exit !== 0) {
			if (Date.now() >= observedBy)
				await crash; // Surface the client's contract assertion rather than a secondary polling failure.
			assert.ok(Date.now() < observedBy, 'app never confirmed closed admission after crash');
			await Bun.sleep(50);
		}
		// Supervisor death alone does not prove descendant cleanup. The Operator owns restart.
		await docker(['restart', containers[1]]);
		console.log((await crash).out.trim());
	}
	const processes = (await docker(['exec', containers[1], 'ps', '-o', 'pid,comm,args'])).out;
	assert.ok(!processes.includes('sleep 60') && !processes.includes('/fault.ts'), 'descendant survived restart');
	for (const name of containers.slice(1)) {
		const logs = await docker(['logs', name]);
		assert.equal(logs.out.trim(), '');
		assert.equal(logs.err.trim(), '');
	}
	console.log('PASS: hard memory/OOM, crash/restart removes descendants, bounded logs, read-only app IPC');
} finally {
	try {
		for (const name of containers) await docker(['rm', '-f', name], true).catch(() => {});
		for (const volume of volumes) await docker(['volume', 'rm', volume], true).catch(() => {});
		await docker(['image', 'rm', faultImage, image], true).catch(() => {});
		if (backendAvailable) {
			assert.equal((await docker(['ps', '-a', '--filter', `name=${id}`, '--format', '{{.Names}}'])).out.trim(), '');
			assert.equal((await docker(['volume', 'ls', '--filter', `name=${id}`, '--format', '{{.Name}}'])).out.trim(), '');
			assert.equal((await docker(['image', 'ls', '--filter', `reference=${id}:*`, '--format', '{{.Repository}}:{{.Tag}}'])).out.trim(), '');
		}
	} finally { await rm(root, { recursive: true, force: true }); }
}
console.log('PASS: complete local worker boundary proof; disposable resources removed (target-server synthetic proof required before stage 2)');
