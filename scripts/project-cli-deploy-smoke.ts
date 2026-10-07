import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { cleanupProjectViews, prepareProjectView } from './prepare-project-view';

const root = await realpath(await mkdtemp(join(tmpdir(), 'jam86-deploy-')));
const id = `jam86-deploy-${crypto.randomUUID().slice(0, 8)}`;
const image = `${id}:worker`;
const appImage = `${id}:app`;
const env: Record<string, string> = { ...process.env, COMPOSE_PROJECT_NAME: id };
const composeArgs = ['compose', '--env-file', '.env.prod', '-f', 'docker-compose.yml', '-f', 'docker-compose.prod.yml'];
async function run(args: string[], allowFailure = false, overrides = {}) {
	const child = Bun.spawn(args, { cwd: root, env: { ...env, ...overrides }, stdout: 'pipe', stderr: 'pipe' });
	const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (!allowFailure)
		assert.equal(exit, 0, `${args.slice(0, 3).join(' ')} failed: ${err.slice(-4000)}\n${out.slice(-2000)}`);
	return { exit, out: out.trim(), err };
}
const docker = (args: string[], allowFailure = false) => run(['docker', ...args], allowFailure);
const compose = (args: string[], allowFailure = false, overrides = {}) => run(['docker', ...composeArgs, ...args], allowFailure, overrides);
const deploy = (allowFailure = false) => run(['bash', 'infra/deploy-project-cli.sh'], allowFailure);
const client = (phase = 'queries') => compose(['exec', '-T', 'app', 'bun', '--no-env-file', 'project-cli/scripts/project-cli-deploy-client.ts', phase]);
const container = async (service: string) => (await compose(['ps', '-aq', service])).out;
const inspect = async (service: string) => JSON.parse((await docker(['inspect', await container(service)])).out)[0];
let backendAvailable = false;
try {
	await docker(['version']);
	backendAvailable = true;
	for (const dir of ['src/mastra', 'docs', 'scripts', 'infra', 'clickhouse'])
		await mkdir(join(root, dir), { recursive: true });
	for (const path of ['Dockerfile', 'Dockerfile.project-cli', 'docker-compose.yml', 'docker-compose.prod.yml', 'tsconfig.json', 'eslint.config.mjs', 'clickhouse/memory.xml', 'infra/deploy-project-cli.sh', 'scripts/prepare-project-view.ts', 'scripts/project-cli-check.ts', 'scripts/project-cli-deploy-client.ts', 'scripts/project-cli-fault-fixture.ts'])
		await cp(new URL(`../${path}`, import.meta.url), join(root, path));
	for (const name of ['project-cli.ts', 'project-cli-contract.ts', 'project-cli-worker.ts', 'project-workspace.ts'])
		await cp(new URL(`../src/mastra/${name}`, import.meta.url), join(root, 'src/mastra', name));
	await writeFile(join(root, '.env.prod'), 'TUNNEL_TOKEN=synthetic\nOPERATOR_TIMEZONE=UTC\n');
	await writeFile(join(root, 'src/send.ts'), 'Sendblue\n');
	await writeFile(join(root, 'src/other.ts'), 'sendblue\n');
	await writeFile(join(root, 'docs/second.json'), '{"private":"SYNTHETIC_SECOND"}');
	await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' }, dependencies: { '@mastra/core': '1.71.0' } }));
	// Resolve and inspect the real overlay before substituting only synthetic app/DB fixtures.
	const config = JSON.parse((await compose(['config', '--format', 'json'])).out);
	const services = config.services;
	assert.deepEqual(services['project-jq'].volumes.map((v: { target: string }) => v.target), ['/ipc']);
	for (const mode of ['rg', 'jq']) {
		const worker = services[`project-${mode}`];
		assert.equal(worker.network_mode, 'none');
		assert.equal(worker.read_only, true);
		assert.equal(Number(worker.mem_limit), 256 * 1024 * 1024);
		assert.equal(worker.memswap_limit, worker.mem_limit);
		assert.equal(worker.pids_limit, 64);
		assert.deepEqual(worker.cap_drop, ['ALL']);
		assert.deepEqual(worker.security_opt, ['no-new-privileges:true']);
		assert.equal(worker.stop_grace_period, '15s');
		assert.deepEqual(Object.keys(worker.environment ?? {}), mode === 'jq' ? ['PROJECT_CLI_VIEW'] : []);
		assert.equal(worker.ports, undefined);
		worker.image = image;
		worker.restart = 'no';
	}
	const projectMount = services.app.volumes.find((v: { target: string }) => v.target === '/project');
	assert.equal(projectMount.read_only, true);
	assert.equal(projectMount.bind.create_host_path, false);
	// eslint-disable-next-line no-template-curly-in-string -- Compose host interpolation.
	projectMount.source = '${PROJECT_VIEW_HOST_PATH:-./.project-view/current}';
	services['project-rg'].volumes.find((v: { target: string }) => v.target === '/project').source = projectMount.source;
	// eslint-disable-next-line no-template-curly-in-string -- Compose host interpolation.
	services['project-jq'].environment.PROJECT_CLI_VIEW = '${PROJECT_CLI_VIEW:-}';
	const ipc = services.app.volumes.filter((v: { target: string }) => v.target.startsWith('/run/project-'));
	assert.equal(ipc.length, 2);
	assert.ok(ipc.every((v: { read_only: boolean }) => v.read_only));
	services.app = { image: appImage, build: { context: root, dockerfile: 'Dockerfile' }, user: 'bun', init: true, command: ['sleep', '3600'], environment: { PROJECT_VIEW_PATH: '/project', APP_SECRET: 'SYNTHETIC_APP_SECRET' }, volumes: [projectMount, ...ipc] };
	for (const service of ['postgres', 'clickhouse', 'cloudflared'])
		services[service] = { image: 'oven/bun:1.3.14-alpine', command: ['sleep', '3600'] };
	// Named volumes stay project-scoped; the fixture never touches real production resources.
	await writeFile(join(root, 'docker-compose.yml'), JSON.stringify({ name: id, services: {} }));
	await writeFile(join(root, 'docker-compose.prod.yml'), JSON.stringify({ name: id, services, volumes: { 'project-rg-ipc': {}, 'project-jq-ipc': {} } }));
	await writeFile(join(root, 'Dockerfile'), 'FROM oven/bun:1.3.14-alpine\nWORKDIR /app\nCOPY src/mastra/project-cli.ts src/mastra/project-cli-contract.ts src/mastra/project-workspace.ts ./project-cli/src/mastra/\nCOPY scripts/project-cli-check.ts scripts/project-cli-deploy-client.ts ./project-cli/scripts/\nUSER bun\n');
	// Stage 1's resistant-descendant fixture overlays only the disposable worker image.
	await writeFile(join(root, 'wrapper'), '#!/bin/sh\nexec /usr/local/bin/bun --no-env-file /fault.ts "$@"\n');
	await writeFile(join(root, 'Dockerfile.project-cli'), `${await readFile(join(root, 'Dockerfile.project-cli'), 'utf8')}\nUSER root\nRUN mv /usr/bin/rg /usr/bin/rg-real\nCOPY scripts/project-cli-fault-fixture.ts /fault.ts\nCOPY wrapper /usr/bin/rg\nRUN chmod 755 /usr/bin/rg\nUSER bun\n`);
	await deploy();
	await compose(['up', '-d', '--no-deps', 'cloudflared']);
	console.log((await client()).out);
	const before = await inspect('app');
	const workerBefore = await inspect('project-rg');
	const others = await Promise.all(['postgres', 'clickhouse', 'cloudflared'].map(container));
	const initial = await realpath(join(root, '.project-view/current'));
	await mkdir(join(root, '.project-view/deploy.lock'));
	assert.notEqual((await deploy(true)).exit, 0);
	assert.equal(await realpath(join(root, '.project-view/current')), initial);
	assert.equal((await inspect('project-rg')).Id, workerBefore.Id);
	await rm(join(root, '.project-view/deploy.lock'), { recursive: true });
	await writeFile(join(root, 'src/new.ts'), 'replacement\n');
	// A real build failure after publication must preserve live IDs and generations.
	const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
	await writeFile(join(root, 'Dockerfile'), 'JAM86_BUILD_FAILURE\n');
	assert.notEqual((await deploy(true)).exit, 0);
	assert.equal((await inspect('app')).Id, before.Id);
	assert.equal((await inspect('project-rg')).Id, workerBefore.Id);
	assert.match(await readFile(join(initial, 'src/send.ts'), 'utf8'), /Sendblue/);
	console.log((await client()).out);
	await writeFile(join(root, 'Dockerfile'), dockerfile);
	const failedBuild = await realpath(join(root, '.project-view/current'));
	// A stopped socket and a descriptor mismatch leave ordinary native reads usable.
	await compose(['stop', 'project-jq']);
	console.log((await client('unavailable')).out);
	const descriptor = JSON.parse(await readFile(join(initial, '.project-view.json'), 'utf8'));
	await compose(['up', '-d', '--no-deps', '--force-recreate', 'project-jq'], false, { PROJECT_CLI_VIEW: JSON.stringify({ ...descriptor, generation: 'view-mismatch' }) });
	console.log((await client('unavailable')).out);
	// Missing bind source during recreation must not remove the old app's native mount.
	assert.notEqual((await compose(['up', '-d', '--no-deps', '--force-recreate', 'project-rg'], true, { PROJECT_VIEW_HOST_PATH: join(root, 'missing-view') })).exit, 0);
	assert.match((await compose(['exec', '-T', 'app', 'cat', '/project/src/send.ts'])).out, /Sendblue/);
	assert.ok((await readdir(join(root, '.project-view'))).includes(initial.split('/').at(-1)!));
	// CMD failure reaches readiness cleanup; missing ENTRYPOINT fails Docker start itself.
	for (const field of ['command', 'entrypoint']) {
		services.app[field] = ['/missing-jam86-entrypoint'];
		await writeFile(join(root, 'docker-compose.prod.yml'), JSON.stringify({ name: id, services, volumes: { 'project-rg-ipc': {}, 'project-jq-ipc': {} } }));
		assert.notEqual((await deploy(true)).exit, 0);
		for (const mode of ['rg', 'jq'])
			assert.equal((await inspect(`project-${mode}`)).State.Running, false);
		assert.match(await readFile(join(initial, 'src/send.ts'), 'utf8'), /Sendblue/);
		assert.ok(await readFile(join(failedBuild, '.prepared-at'), 'utf8'));
		delete services.app.entrypoint;
		services.app.command = ['sleep', '3600'];
	}
	await writeFile(join(root, 'docker-compose.prod.yml'), JSON.stringify({ name: id, services, volumes: { 'project-rg-ipc': {}, 'project-jq-ipc': {} } }));
	await deploy();
	assert.notEqual((await inspect('app')).Id, before.Id);
	assert.deepEqual(await Promise.all(['postgres', 'clickhouse', 'cloudflared'].map(container)), others);
	await assert.rejects(readFile(join(initial, '.prepared-at')));
	await assert.rejects(readFile(join(failedBuild, '.prepared-at')));
	console.log((await client()).out);
	console.log('PASS: failed build/recreation retain views; retry switches matching mounts; databases/tunnel preserved');
	// Unconfirmed/forced worker shutdown must refuse replacement and retain every view.
	const retryPath = await realpath(join(root, '.project-view/current'));
	const retryApp = await container('app');
	await docker(['kill', await container('project-rg')]);
	const failedStop = await deploy(true);
	assert.notEqual(failedStop.exit, 0);
	assert.match(failedStop.err, /Worker shutdown not confirmed/);
	assert.equal(await container('app'), retryApp);
	assert.ok(await readFile(join(retryPath, '.prepared-at'), 'utf8'));
	console.log((await client('unavailable')).out);
	// Operator-owned restart clears the abnormal instance; a graceful stop then proves cleanup.
	await compose(['start', 'project-rg', 'project-jq']);
	await compose(['exec', '-T', 'app', 'bun', '--no-env-file', 'project-cli/scripts/project-cli-check.ts']);
	await compose(['stop', 'project-rg', 'project-jq']);
	await deploy();
	console.log('PASS: forced shutdown retains views and CLI stays unavailable until Operator recovery');
	const drainingWorker = await container('project-rg');
	const pending = client('drain');
	void pending.catch(() => {});
	const until = Date.now() + 5000;
	while ((await docker(['exec', drainingWorker, 'test', '-s', '/ipc/descendant.pid'], true)).exit !== 0) {
		assert.ok(Date.now() < until, 'resistant descendant never started');
		await Bun.sleep(50);
	}
	// Admission closes while the real helper drains, before it replaces the pinned mount.
	await deploy();
	console.log((await pending).out);
	console.log((await client()).out);
	const processes = (await compose(['exec', '-T', 'project-rg', 'ps', '-o', 'pid,args'])).out;
	assert.ok(!processes.includes('sleep 60') && !processes.includes('/fault.ts'));
	for (const mode of ['rg', 'jq']) {
		const state = await inspect(`project-${mode}`);
		assert.equal(state.Config.User, 'bun');
		assert.equal(state.HostConfig.ReadonlyRootfs, true);
		assert.equal(state.HostConfig.NetworkMode, 'none');
		const logs = await compose(['logs', '--no-log-prefix', `project-${mode}`]);
		assert.equal(logs.out, '');
		assert.equal(logs.err.trim(), '');
	}
	console.log('PASS: deadline-bounded drain and descendant cleanup, cross-worker busy, fresh slot, bounded logs');
	// Prove a view-only switch with the exact same image IDs, without a build.
	const appImageBefore = (await inspect('app')).Image;
	const workerImageBefore = (await inspect('project-rg')).Image;
	const oldPath = await realpath(join(root, '.project-view/current'));
	const replacement = await prepareProjectView(root);
	const pinned = await realpath(replacement.path);
	const replacementEnv = { PROJECT_VIEW_HOST_PATH: pinned, PROJECT_CLI_VIEW: await readFile(join(pinned, '.project-view.json'), 'utf8') };
	await compose(['stop', 'project-rg', 'project-jq']);
	await compose(['up', '-d', '--no-deps', '--no-build', '--force-recreate', 'project-rg', 'project-jq', 'app'], false, replacementEnv);
	console.log((await client()).out);
	assert.equal((await inspect('app')).Image, appImageBefore);
	assert.equal((await inspect('project-rg')).Image, workerImageBefore);
	await cleanupProjectViews(root, replacement.generation);
	await assert.rejects(readFile(join(oldPath, '.prepared-at')));
	console.log('PASS: exact unchanged-image view switch, cleanup only after matching owner queries');
}
finally {
	try {
		if (backendAvailable) {
			await compose(['down', '--volumes', '--remove-orphans'], true);
			await docker(['image', 'rm', appImage, image], true);
			assert.equal((await docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${id}`, '--format', '{{.ID}}'])).out, '');
			assert.equal((await docker(['volume', 'ls', '--filter', `label=com.docker.compose.project=${id}`, '--format', '{{.Name}}'])).out, '');
			assert.equal((await docker(['network', 'ls', '--filter', `label=com.docker.compose.project=${id}`, '--format', '{{.Name}}'])).out, '');
			assert.equal((await docker(['image', 'ls', '--filter', `reference=${id}:*`, '--format', '{{.Repository}}:{{.Tag}}'])).out, '');
		}
	}
	finally { await rm(root, { recursive: true, force: true }); }
}
console.log('PASS: synthetic Compose deployment lifetime; disposable resources removed');
