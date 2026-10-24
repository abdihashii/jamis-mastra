import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../../scripts/fantasy-recap.ts', import.meta.url));
const env = {
	PATH: process.env.PATH,
	HOME: '/tmp/jamis-stage3-cli-fixture',
	DATABASE_URL: 'PRIVATE_DATABASE_SENTINEL',
	FANTASY_SENDBLUE_GROUP_ID: 'PRIVATE_GROUP_SENTINEL',
	FANTASY_SLEEPER_LEAGUE_ID: '111',
	FANTASY_MANAGER_MAP: '{"+15550001111":"u1"}',
	FANTASY_RECAP_TIMEZONE: 'America/Chicago',
};

async function run(flags: string[]) {
	const child = Bun.spawn([process.execPath, '--no-install', '--no-env-file', script, ...flags], {
		env,
		stdout: 'pipe',
		stderr: 'pipe',
		signal: AbortSignal.timeout(15_000),
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
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
			'recap-evidence',
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

	it('keeps operational and model composition out of static entrypoint imports', async () => {
		const source = await readFile(script, 'utf8');
		const imports = source.match(/^import(?!\s+type\b)[^;]+;/gm)?.join('\n') ?? '';
		expect(imports).not.toMatch(/core\/mastra|mastra\/agents|mastra\/gateways|fantasy\/(?:daily|coordinator|recaps|runs|deliver)/);
	});
});
