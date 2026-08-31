/**
 * Interactive Codex device-flow login. Prints the verification URL and user
 * code (never a token) and writes data/openai-codex-auth.json.
 *
 * Local: bun scripts/openai-codex-login.ts
 * VPS:   docker run --rm -it --user 1000:1000 -v /root/jamis-mastra:/repo -w /repo \
 *          oven/bun:1.3.14-alpine bun scripts/openai-codex-login.ts
 */
import { defaultCredentialPath, runDeviceLogin } from '../src/mastra/gateways/openai-codex-auth.js';

await runDeviceLogin(({ url, userCode }) => {
	console.log(`Open ${url} and enter code: ${userCode}`);
});
const { stat } = await import('node:fs/promises');
const info = await stat(defaultCredentialPath());
console.log(`Codex credential saved to ${defaultCredentialPath()} (0${(info.mode & 0o777).toString(8)}). Re-login re-runs the same command.`);
