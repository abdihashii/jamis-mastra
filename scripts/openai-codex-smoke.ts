/**
 * One-shot Codex protocol smoke: loads the credential (refreshing if
 * expired), performs one real generation through the subscription backend,
 * and prints only the reply text. Optional argv[2] overrides the model for
 * catalog-availability checks.
 *
 * Local: bun scripts/openai-codex-smoke.ts [model]
 */
import process from 'node:process';

import { codexGenerate, getUsableCredential } from '../src/mastra/gateways/openai-codex-auth.js';

const model = process.argv[2] ?? 'gpt-5.6-terra';
const cred = await getUsableCredential();
const reply = await codexGenerate({
	cred,
	model,
	prompt: 'Reply with exactly one word: ok',
	effort: 'max',
});
console.log(`${model}: ${reply}`);
