import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../../scripts/fantasy-recap.ts', import.meta.url));
const env = {
	PATH: process.env.PATH,
	HOME: '/tmp/jamis-stage3-cli-fixture',
	DO_NOT_TRACK: '1',
	DATABASE_URL: 'PRIVATE_DATABASE_SENTINEL',
	FANTASY_SENDBLUE_GROUP_ID: 'PRIVATE_GROUP_SENTINEL',
	FANTASY_SLEEPER_LEAGUE_ID: '111',
	FANTASY_MANAGER_MAP: '{"+15550001111":"u1"}',
	FANTASY_RECAP_TIMEZONE: 'America/Chicago',
};

const attemptId = '11111111-1111-4111-8111-111111111111';
const windowFlags = ['--week', '2', '--since', '2026-09-15T00:00:00Z', '--until', '2026-09-22T00:00:00Z'];
const restartFlags = ['restart', '--week', '2', '--attempt-id', attemptId];
let tempRoot: string;
let guard: string;

beforeAll(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), 'fantasy-cli-'));
	guard = join(tempRoot, 'guard.ts');
	await writeFile(guard, `
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { mock } from 'bun:test';
const deny = () => { process.stderr.write('CLI_EFFECT_DENIED\\n'); process.exit(86); };
globalThis.fetch = Object.assign(deny, { preconnect: deny });
for (const client of [http, https]) { client.request = deny; client.get = deny; }
net.Socket.prototype.connect = deny;
tls.connect = deny;
Bun.connect = deny;
if (process.env.CLI_FIXTURE_RESULT) {
  let opened = 0, closed = 0, invoked = 0, validated = 0;
  class SQL {
    constructor(url, options) {
      opened++;
      assert.equal(url, process.env.DATABASE_URL);
      assert.deepEqual(options, { connectionTimeout: 5, connection: { statement_timeout: '15s', lock_timeout: '5s' } });
    }
    async close() {
      closed++;
      if (process.env.CLI_FIXTURE_CLOSE_THROW) throw new Error('PRIVATE_CLOSE_SENTINEL');
    }
  }
  Bun.SQL = SQL;
  mock.module(${JSON.stringify(fileURLToPath(new URL('../daily.ts', import.meta.url)))}, () => ({
    runDailyRecap: async (config, parent, overrides) => {
      invoked++;
      assert.equal(config.sendblueGroupId, process.env.FANTASY_SENDBLUE_GROUP_ID);
      assert.deepEqual(Object.keys(parent.listAgents()), []);
      assert.deepEqual(Object.keys(parent.listWorkflows()), []);
      assert.deepEqual(Object.keys(parent.listTools() ?? {}), []);
      assert.equal(parent.getStorage()?.id, 'in-memory');
      // Mastra adds these three built-in gateways even to a bare parent.
      assert.deepEqual(Object.keys(parent.listGateways()).sort(), ['mastra', 'models.dev', 'netlify', 'openai-codex']);
      assert.equal(parent.getGateway('openai-codex').id, 'openai-codex');
      assert.equal(overrides.sql instanceof SQL, true);
      assert.equal(overrides.databaseUrl, process.env.DATABASE_URL);
      assert.deepEqual(Object.keys(overrides).sort(), process.env.CLI_FIXTURE_RESTART ? ['databaseUrl', 'restart', 'sql'] : ['databaseUrl', 'sql']);
      assert.deepEqual(overrides.restart, process.env.CLI_FIXTURE_RESTART ? JSON.parse(process.env.CLI_FIXTURE_RESTART) : undefined);
      validated++;
      if (process.env.CLI_FIXTURE_THROW) throw new Error('PRIVATE_SOURCE_SENTINEL ' + process.env.DATABASE_URL);
      return JSON.parse(process.env.CLI_FIXTURE_RESULT);
    }
  }));
  process.on('exit', () => {
    // CLI catches thrown assertions too; every fixture contract must finish before an expected failure.
    if (opened !== 1 || closed !== 1 || invoked !== 1 || validated !== 1) {
      process.stderr.write('CLI_LIFECYCLE_FAILED\\n');
      process.exitCode = 87;
    }
  });
}
`, { mode: 0o600 });
});

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

async function run(flags: string[], overrides: Record<string, string | undefined> = {}) {
	const child = Bun.spawn([process.execPath, '--no-install', '--no-env-file', '--preload', guard, script, ...flags], {
		env: { ...env, ...overrides },
		stdout: 'pipe',
		stderr: 'pipe',
		signal: AbortSignal.timeout(15_000),
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	for (const sentinel of ['PRIVATE_', '+15550001111', 'OpenAI login', 'CLI_EFFECT_DENIED', 'CLI_LIFECYCLE_FAILED'])
		expect(stdout + stderr).not.toContain(sentinel);
	return { code, stdout, stderr };
}

describe('evidence CLI isolation', () => {
	it('returns a safe database error without model, transport or operator credentials', async () => {
		const result = await run(['evidence', '--week', '2', '--since', '2026-09-15T00:00:00Z', '--until', '2026-09-22T00:00:00Z']);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('Evidence preview: blocked (invalid_preview_database_url)');
		expect(result.stdout).toContain('model calls: 0; sends: 0');
		for (const sentinel of ['PRIVATE_DATABASE_SENTINEL', 'PRIVATE_GROUP_SENTINEL', '+15550001111', 'SENDBLUE_API_KEY', 'OpenAI login'])
			expect(result.stdout + result.stderr).not.toContain(sentinel);
		expect(result.stderr).toBe('');
	});

	it('does not silently invent a missing UTC window or opt into paid NFL reads', async () => {
		const missingWindow = await run(['evidence', '--week', '2']);
		expect(missingWindow.code).toBe(1);
		expect(missingWindow.stderr).toContain('--since');
		const missingKey = await run([
			'evidence',
			'--week',
			'2',
			'--since',
			'2026-09-15T00:00:00Z',
			'--until',
			'2026-09-22T00:00:00Z',
			'--nfl',
		]);
		expect(missingKey.code).toBe(1);
		expect(missingKey.stderr).toContain('FIRECRAWL_API_KEY is required');
		expect(missingKey.stdout).not.toContain('Evidence preview:');
	});

	for (const command of ['preview-candidate', 'preview']) {
		it(`${command} fails safely before model loading when its read-only database is invalid`, async () => {
			const result = await run([command, ...windowFlags]);
			expect(result.code).toBe(1);
			expect(result.stdout).toContain('Candidate preview: blocked (invalid_preview_database_url)');
			expect(result.stdout).toContain('writer calls: 0; reviewer calls: 0; sends: 0');
			expect(result.stderr).toBe('');
		});

		it(`${command} refuses legacy options, duplicate flags and implicit evidence windows before effects`, async () => {
			for (const extra of [['--chat', '/PRIVATE_CHAT_SENTINEL'], ['--model', 'PRIVATE_MODEL_SENTINEL'], ['--send'], ['--week', '3'], ['--allow-incomplete'], ['--nfl', '--nfl']]) {
				const result = await run([command, ...windowFlags, ...extra]);
				expect(result.code).toBe(1);
				expect(result.stdout).toBe('');
				expect(result.stderr).toContain('bun run fantasy:recap');
			}
			for (const flags of [[], ['--week', '2'], [...windowFlags.slice(0, -1)], ['--since', windowFlags[3], '--until', windowFlags[5]]]) {
				const missing = await run([command, ...flags]);
				expect(missing.code).toBe(1);
				expect(missing.stdout).toBe('');
			}
			const paid = await run([command, ...windowFlags, '--nfl']);
			expect(paid.stderr).toContain('FIRECRAWL_API_KEY is required');
			expect(paid.stdout).toBe('');
		}, 30_000);
	}

	it('debug export fails privately without initializing storage, models or delivery', async () => {
		const result = await run(['debug-export', '--week', '2', '--attempt-id', '11111111-1111-4111-8111-111111111111']);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout)).toEqual({ status: 'blocked', reason: 'generation_debug_export_unavailable' });
		expect(result.stderr).toBe('');
		for (const sentinel of ['PRIVATE_DATABASE_SENTINEL', 'PRIVATE_GROUP_SENTINEL', '+15550001111', 'OpenAI login', 'packetJson'])
			expect(result.stdout + result.stderr).not.toContain(sentinel);
	});

	it('debug export rejects missing, duplicate and capability-bearing flags before opening storage', async () => {
		const base = ['debug-export', '--week', '2', '--attempt-id', '11111111-1111-4111-8111-111111111111'];
		for (const flags of [['debug-export'], ['debug-export', '--week', '0', '--attempt-id', 'bad'], ...[['--send'], ['--week', '3'], ['--output', '/tmp/unsafe'], ['--model', 'untrusted']].map(extra => [...base, ...extra])]) {
			const result = await run(flags);
			expect(result.code).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('Invalid debug export arguments.');
		}
	});

	it('run rejects every supplied flag or positional argument before operational imports', async () => {
		for (const flags of [['--week', '2'], ['--attempt-id', attemptId], ['--model', 'PRIVATE_MODEL_SENTINEL'], ['--allow-incomplete'], ['--nfl'], ['--chat', '/PRIVATE_CHAT_SENTINEL'], ['--'], ['unexpected']]) {
			const result = await run(['run', ...flags], { FANTASY_MANAGER_MAP: 'invalid' });
			expect(result).toEqual({ code: 1, stdout: '', stderr: 'Invalid run arguments.\n' });
		}
	}, 30_000);

	it('restart accepts only one week in 1..22 and one UUID attempt selector before effects', async () => {
		const invalid = [
			['restart'],
			['restart', '--week', '2'],
			['restart', '--attempt-id', attemptId],
			['restart', '--week=2', '--attempt-id', attemptId],
			['restart', '--week', '--attempt-id', attemptId],
			...['0', '23', '-1', '2.0', '2e0', '02', 'bad'].map(week => ['restart', '--week', week, '--attempt-id', attemptId]),
			...['bad', '', '11111111-1111-1111-1111-111111111111'].map(id => ['restart', '--week', '2', '--attempt-id', id]),
			...['--send', '--model', '--chat', '--allow-incomplete', '--nfl', '--week', '--attempt-id', '--report-id', '--unknown'].map(flag => [...restartFlags, flag, 'PRIVATE_FLAG_SENTINEL']),
		];
		for (const flags of invalid) {
			const result = await run(flags, { FANTASY_MANAGER_MAP: 'invalid' });
			expect(result).toEqual({ code: 1, stdout: '', stderr: 'Invalid restart arguments.\n' });
		}
	}, 30_000);

	it('valid run and restart arguments fail with safe JSON before effects on an invalid database URL', async () => {
		for (const flags of [['run'], restartFlags, ['restart', '--attempt-id', attemptId, '--week', '22']]) {
			const result = await run(flags);
			expect(result.code).toBe(1);
			expect(result.stderr).toBe('');
			expect(JSON.parse(result.stdout)).toEqual({ outcome: 'error', week: flags[0] === 'run' ? null : Number(flags[flags.indexOf('--week') + 1]), reason: 'recap_run_unavailable' });
		}
	});

	it('run and restart share the bare daily owner, bounded SQL lifetime and safe receipt projection', async () => {
		for (const flags of [['run'], restartFlags]) {
			for (const outcome of ['sent', 'noop-already-sent', 'failed', 'delivery_unknown', 'error', 'blocked-active-claim', 'blocked-delivery-unknown']) {
				const receipt = { outcome, week: 2, reason: 'fixture_reason', attemptId, reportId: `report-${'a'.repeat(64)}`, counts: { nfl: 0, drafts: 1, reviews: 1 } };
				const result = await run(flags, {
					DATABASE_URL: 'postgresql://fixture:PRIVATE_PASSWORD_SENTINEL@127.0.0.1:1/fixture',
					CLI_FIXTURE_RESULT: JSON.stringify({ ...receipt, error: 'PRIVATE_SOURCE_SENTINEL', source: 'PRIVATE_CHAT_SENTINEL', counts: { ...receipt.counts, secret: 'PRIVATE_COUNT_SENTINEL' } }),
					CLI_FIXTURE_RESTART: flags[0] === 'restart' ? JSON.stringify({ week: 2, attemptId }) : undefined,
					CLI_FIXTURE_CLOSE_THROW: '1',
				});
				expect(result.code).toBe(['sent', 'noop-already-sent'].includes(outcome) ? 0 : 1);
				expect(result.stderr).toBe('');
				expect(JSON.parse(result.stdout)).toEqual(receipt);
			}
		}
	}, 30_000);

	it('run and restart contain raw daily failures and still close their SQL client', async () => {
		for (const flags of [['run'], restartFlags]) {
			const result = await run(flags, {
				DATABASE_URL: 'postgresql://fixture:PRIVATE_PASSWORD_SENTINEL@127.0.0.1:1/fixture',
				CLI_FIXTURE_RESULT: '{}',
				CLI_FIXTURE_RESTART: flags[0] === 'restart' ? JSON.stringify({ week: 2, attemptId }) : undefined,
				CLI_FIXTURE_THROW: '1',
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toBe('');
			expect(JSON.parse(result.stdout)).toEqual({ outcome: 'error', week: flags[0] === 'run' ? null : 2, reason: 'recap_run_unavailable' });
		}
	});

	it('keeps operational and model composition out of static entrypoint imports and removes legacy writer entrypoints', async () => {
		const source = await readFile(script, 'utf8');
		const imports = source.match(/^import(?!\s+type\b)[^;]+;/gm)?.join('\n') ?? '';
		expect(imports).not.toMatch(/core\/mastra|mastra\/agents|mastra\/gateways|fantasy\/(?:daily|coordinator|recaps|runs|deliver)/);
		expect(source).not.toMatch(/cliMastra|shapingGenerator|loadChatFixture|recapRowCounts|PostgresStore|DEFAULT_RECAP_MODEL|FANTASY_GENERATOR_VERSION|buildRecapPrompt|generateWithRepair|renderWeekRecap/);
		expect(source).not.toMatch(/mastra\/index|fantasy-weekly-recap|addAgent|addWorkflow/);
	});
});
