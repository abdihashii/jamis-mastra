import assert from 'node:assert/strict';
import process from 'node:process';

import { LocalSandbox } from '@mastra/core/workspace';

// Harness only. Never attach this sandbox or these commands to an agent.
assert.equal(process.platform, 'linux');
assert.equal(process.getuid?.(), 1000);
for (const binary of ['bwrap', 'rg', 'jq'])
	assert.equal(Bun.spawnSync([binary, '--version']).exitCode, 0);
console.log('PASS: Linux UID 1000 and real Bubblewrap/rg/jq binaries');

const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
const policies = [
	{
		name: 'Mastra generated read-only rg policy',
		command: '/usr/bin/rg',
		args: ['--no-config', '--files', '--sort', 'path', 'src'],
		nativeSandbox: { readOnly: true, allowNetwork: false },
	},
	{
		name: 'Mastra selected-input jq policy',
		command: '/usr/bin/jq',
		args: ['.scripts', '/input.json'],
		nativeSandbox: {
			bwrapArgs: [
				'--unshare-all',
				'--die-with-parent',
				'--clearenv',
				'--setenv',
				'PATH',
				env.PATH,
				'--setenv',
				'LANG',
				env.LANG,
				'--setenv',
				'LC_ALL',
				env.LC_ALL,
				'--setenv',
				'TZ',
				env.TZ,
				'--ro-bind',
				'/usr',
				'/usr',
				'--ro-bind',
				'/lib',
				'/lib',
				'--ro-bind',
				'/bin',
				'/bin',
				'--ro-bind',
				'/project/package.json',
				'/input.json',
				'--chdir',
				'/',
			],
		},
	},
];

let failed = false;
for (const policy of policies) {
	const sandbox = new LocalSandbox({
		workingDirectory: '/project',
		isolation: 'bwrap',
		env,
		nativeSandbox: policy.nativeSandbox,
	});
	try {
		const result = await sandbox.executeCommand!(policy.command, policy.args, { timeout: 1000, maxRetainedBytes: 4096 });
		if (result.exitCode !== 0) {
			failed = true;
			console.error(`BLOCKED: ${policy.name} (exit ${result.exitCode})`);
			console.error(result.stderr.trim());
		}
		else {
			console.log(`PASS: ${policy.name} namespace preflight`);
		}
	}
	finally {
		await sandbox.stop();
	}
}

console.error(failed
	? 'Isolation unavailable. Stop stage 1; no executor or agent capability enabled.'
	: 'Namespace preflight passed. Full boundary/resource/lifecycle proof still required before stage 1 can pass.');
console.error('UNPROVEN: credential/env/socket exclusion, writes/network, input validation, jq imports, deadlines/cleanup, output/memory limits, busy/slot reuse.');
// A namespace preflight alone must never report the full stage as passing.
process.exitCode = 1;
