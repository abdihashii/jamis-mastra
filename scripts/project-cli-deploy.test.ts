import { afterEach, beforeEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

let root: string;
const helper = fileURLToPath(new URL('../infra/deploy-project-cli.sh', import.meta.url));
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'jam86-deploy-test-'));
	await mkdir(join(root, 'bin'));
	await mkdir(join(root, '.project-view/view-synthetic'), { recursive: true });
	await symlink('view-synthetic', join(root, '.project-view/current'));
	await writeFile(join(root, '.project-view/view-synthetic/.project-view.json'), '{"generation":"view-synthetic","preparedAt":"2026-10-07T00:00:00.000Z"}');
	await writeFile(join(root, 'commands'), '');
	// Stub only host Docker calls. Exercise the exact production Bash helper.
	await writeFile(join(root, 'bin/docker'), `#!/bin/sh
echo "$*" >> "$REVIEW_COMMANDS"
case "$*" in
  *" stop project-rg project-jq")
    if [ "$REVIEW_FAULT" = cleanup-stop ] && [ -e "$REVIEW_STARTED" ]; then exit 19; fi;;
  *" ps -aq "*) echo synthetic-worker;;
  inspect*) echo 'false 0 0';;
  *" up -d --no-deps --force-recreate project-rg project-jq") touch "$REVIEW_STARTED";;
  *" up -d --no-deps --force-recreate app")
    if [ "$REVIEW_FAULT" = recreate ]; then exit 17; fi;;
  run*--cleanup*)
    if [ "$REVIEW_FAULT" = cleanup ] || [ "$REVIEW_FAULT" = cleanup-stop ]; then exit 18; fi;;
esac
if [ "$1" = run ] && [ "$REVIEW_FAULT" = signal ]; then
  echo $$ > "$REVIEW_CHILD"
  while [ ! -e "$REVIEW_RELEASE" ]; do sleep 0.05; done
fi
`);
	await chmod(join(root, 'bin/docker'), 0o755);
});
afterEach(async () => rm(root, { recursive: true, force: true }));

function deploy(fault: string) {
	return Bun.spawn(['bash', helper], {
		cwd: root,
		detached: true,
		env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, REVIEW_FAULT: fault, REVIEW_COMMANDS: join(root, 'commands'), REVIEW_CHILD: join(root, 'child.pid'), REVIEW_RELEASE: join(root, 'release'), REVIEW_STARTED: join(root, 'workers-started') },
		stdout: 'ignore',
		stderr: 'ignore',
	});
}

test.each(['recreate', 'cleanup'])('Docker %s failure stops replacement workers before releasing deployment admission', async (fault) => {
	const child = deploy(fault);
	assert.notEqual(await child.exited, 0);
	const commands = (await readFile(join(root, 'commands'), 'utf8')).trim().split('\n');
	assert.match(commands.at(-1)!, / stop project-rg project-jq$/);
	assert.ok(commands.some(command => command.endsWith(' up -d --no-deps --force-recreate project-rg project-jq')));
	await assert.rejects(lstat(join(root, '.project-view/deploy.lock')));
});

test('failed error-path worker stop retains deployment admission', async () => {
	assert.notEqual(await deploy('cleanup-stop').exited, 0);
	assert.ok(await lstat(join(root, '.project-view/deploy.lock')));
	const before = await readFile(join(root, 'commands'), 'utf8');
	assert.notEqual(await deploy('recreate').exited, 0);
	assert.equal(await readFile(join(root, 'commands'), 'utf8'), before);
});

test.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)('%s retains deployment admission while Docker work is outstanding', async (signal) => {
	const child = deploy('signal');
	try {
		const until = Date.now() + 3000;
		let pid: number | undefined;
		while (!pid) {
			pid = Number(await readFile(join(root, 'child.pid'), 'utf8').catch(() => '')) || undefined;
			assert.ok(Date.now() < until, 'Docker stub did not start');
			if (!pid)
				await Bun.sleep(10);
		}
		child.kill(signal);
		await Bun.sleep(50);
		process.kill(pid, 0); // Outstanding Docker client is still alive.
		const before = await readFile(join(root, 'commands'), 'utf8');
		assert.notEqual(await deploy('recreate').exited, 0);
		assert.equal(await readFile(join(root, 'commands'), 'utf8'), before);
		await writeFile(join(root, 'release'), 'released');
		assert.notEqual(await child.exited, 0);
		assert.notEqual(await deploy('recreate').exited, 0); // Interrupted lock requires Operator recovery.
		assert.equal(await readFile(join(root, 'commands'), 'utf8'), before);
	} finally {
		try {
			process.kill(-child.pid, 'SIGKILL');
		} catch (e) {
			assert.equal((e as NodeJS.ErrnoException).code, 'ESRCH');
		}
		await child.exited;
	}
}, 10000);
