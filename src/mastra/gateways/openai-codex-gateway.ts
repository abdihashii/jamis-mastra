import type { OpenAIProviderSettings } from '@ai-sdk/openai';

import type { GatewayAuthResult, GatewayLanguageModel, ProviderConfig } from '@mastra/core/llm';
import process from 'node:process';
/**
 * Custom Mastra model gateway for the `openai-codex/*` namespace: Jamis's
 * OpenAI models resolve through the operator's ChatGPT/Codex subscription
 * OAuth credential instead of an OpenAI API key.
 *
 * Auth story (see docs/adrs/0014-openai-codex-model-auth.md):
 * - The gateway id is the namespace prefix, so `GatewayManager` claims
 *   `openai-codex/*` unconditionally; `handlesModel` stays at its false
 *   default so bare `openai/*` ids keep their ordinary models.dev path.
 * - With a credential file present, `resolveAuth()` refreshes near expiry
 *   (single-flight, rotated pair persisted before use — openai-codex-auth.ts)
 *   and returns the bearer token plus account-id header. A failed refresh
 *   propagates loudly; recovery is always re-login.
 * - With no credential file, `resolveAuth()` reports nothing and the manager
 *   falls back to `getApiKey()`, which throws the login-required error.
 *   There is no API-key fallback, by operator choice.
 * - Live tokens flow only through the custom `fetch` closure below, never
 *   through `createOpenAI`'s apiKey parameter.
 */
import { createOpenAI } from '@ai-sdk/openai';
import {

	MastraModelGateway,

} from '@mastra/core/llm';

import {
	applyCodexBodyRules,
	buildCodexHeaders,
	CODEX_API_ENDPOINT,
	getUsableCredential,
	loadCredential,
	MODEL_AUTH_FAILURE,
} from './openai-codex-auth.js';

/** `createOpenAI` takes a base URL and appends `/responses` itself. */
const CODEX_BASE_URL = CODEX_API_ENDPOINT.replace(/\/responses$/, '');

/**
 * The backend always answers over SSE, even for what the SDK thinks is a
 * non-streaming call (`doGenerate` sends no `stream` field, which the backend
 * would reject). The terminal `response.completed` event carries only a
 * skeleton response (`output: []`) plus usage — the actual output items
 * arrive in `response.output_item.done` events — so a non-streaming request
 * is answered by assembling both into a plain JSON body.
 */
async function sseResponseAsJson(response: Response): Promise<Response> {
	const events = await response.text();
	let final: Record<string, unknown> | undefined;
	const outputs = new Map<number, Record<string, unknown>>();
	for (const block of events.split('\n\n')) {
		const data = block
			.split('\n')
			.filter(line => line.startsWith('data:'))
			.map(line => line.slice(5).trim())
			.join('');
		if (!data)
			continue;
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(data) as Record<string, unknown>;
		}
		catch {
			continue;
		}
		if (payload.type === 'response.output_item.done' && typeof payload.output_index === 'number') {
			outputs.set(payload.output_index, payload.item as Record<string, unknown>);
		}
		else if (payload.type === 'response.completed') {
			final = payload.response as Record<string, unknown>;
		}
	}
	if (!final) {
		// No terminal event: surface the raw SSE for the SDK to fail on, loudly.
		return new Response(events, { status: 502, headers: { 'content-type': 'text/event-stream' } });
	}
	final.output = [...outputs.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, item]) => item);
	return new Response(JSON.stringify(final), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

/**
 * `CODEX_SMOKE_DEBUG=1` prints the response fingerprint so the operator can
 * confirm requests are served by the chatgpt.com codex backend
 * (`cf-ray` + `x-openai-proxy-wasm` present, `openai-*` absent) and not by
 * an api.openai.com API-key path (which would carry `openai-organization`).
 */
function debugFingerprint(url: string, response: Response): void {
	if (!process.env.CODEX_SMOKE_DEBUG)
		return;
	console.warn(`[openai-codex] ${url} -> ${response.status} ${JSON.stringify({
		'cf-ray': response.headers.get('cf-ray'),
		'x-openai-proxy-wasm': response.headers.get('x-openai-proxy-wasm'),
		'openai-organization': response.headers.get('openai-organization'),
		'openai-project': response.headers.get('openai-project'),
	})}`);
}

/**
 * The wire-protocol fetch: the live credential is read per request (so
 * rotation and refresh apply mid-flight), OpenAI-style auth headers are
 * replaced with the codex ones, and the undocumented body rules are
 * enforced. The placeholder apiKey never survives as a real header.
 * Exported for direct testing at the fetch boundary.
 */
export function codexFetch() {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const { cred } = await getUsableCredential();
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		const headers = new Headers(init?.headers);
		headers.delete('authorization');
		headers.delete('api-key');
		headers.delete('x-api-key');
		for (const [key, value] of Object.entries(buildCodexHeaders(cred))) {
			headers.set(key, value);
		}
		let body = init?.body;
		let wasStreaming = true;
		if (typeof body === 'string') {
			try {
				// Responses wire format is JSON; apply the backend's undocumented rules.
				const parsed = JSON.parse(body) as Record<string, unknown>;
				wasStreaming = parsed.stream === true;
				body = JSON.stringify(applyCodexBodyRules(parsed));
			}
			catch {
				// Not JSON: pass through; the backend rejects it, loudly.
			}
		}
		const response = await globalThis.fetch(url as RequestInfo | URL, { ...init, headers, body });
		debugFingerprint(url, response);
		// The SDK's non-streaming call still gets an SSE stream; translate it.
		if (!wasStreaming && response.ok && response.body) {
			return sseResponseAsJson(response);
		}
		return response;
	};
}

export class OpenAICodexGateway extends MastraModelGateway {
	readonly id = 'openai-codex';
	readonly name = 'OpenAI Codex (subscription)';

	fetchProviders(): Promise<Record<string, ProviderConfig>> {
		return Promise.resolve({
			'openai-codex': {
				name: 'OpenAI Codex (subscription)',
				gateway: 'openai-codex',
				/** No env var serves these models; auth is the OAuth credential. */
				apiKeyEnvVar: '',
				models: ['gpt-5.6-terra'],
				url: CODEX_API_ENDPOINT,
				npm: '@ai-sdk/openai',
			},
		});
	}

	buildUrl(_modelId: string, _envVars: Record<string, string>): Promise<string | undefined> {
		return Promise.resolve(CODEX_API_ENDPOINT);
	}

	/** OAuth auth when the credential file exists (refreshing near expiry); `undefined` when it does not. */
	async resolveAuth(): Promise<GatewayAuthResult | undefined> {
		const existing = await loadCredential();
		if (!existing)
			return undefined;
		const { cred } = await getUsableCredential();
		return {
			bearerToken: cred.access,
			headers: {
				'ChatGPT-Account-ID': cred.accountId,
				'originator': 'jamis',
			},
		};
	}

	/* No env var exists to return; the credential is the only auth path. */
	async getApiKey(_modelId: string): Promise<string> {
		/* Thrown errors reach the operator's phone; keep specifics in logs. */
		console.error('[openai-codex] No Codex credential. Log in with `bun scripts/openai-codex-login.ts`.');
		throw new Error(MODEL_AUTH_FAILURE);
	}

	async resolveLanguageModel({ modelId, providerId }: {
		modelId: string;
		providerId: string;
		apiKey: string;
		headers?: Record<string, string>;
	}): Promise<GatewayLanguageModel> {
		const provider = createOpenAI({
			name: providerId,
			baseURL: CODEX_BASE_URL,
			// Placeholder only: the real Bearer token is injected per request in codexFetch.
			apiKey: 'oauth',
			// Cast: bun's `typeof fetch` carries a `preconnect` member the SDK does not require.
			fetch: codexFetch() as unknown as NonNullable<OpenAIProviderSettings['fetch']>,
		});
		return forcingStoreFalse(provider.responses(modelId));
	}
}

/**
 * The backend never persists items, but the SDK's input converter defaults
 * `store` to true and then replays previous turns as `item_reference` ids,
 * which 404 on a store-less backend. Forcing the provider option to false
 * makes the converter send reasoning/text/tool calls by value instead (and
 * requests `reasoning.encrypted_content`). The wire-level `body rules`
 * remain the belt to this suspenders for bypassing callers.
 */
export function forcingStoreFalse(model: GatewayLanguageModel): GatewayLanguageModel {
	interface AnyCall { providerOptions?: Record<string, any> }
	const withStoreFalse = (args: AnyCall): AnyCall => ({
		...args,
		providerOptions: {
			...args.providerOptions,
			openai: { ...args.providerOptions?.openai, store: false },
		},
	});
	const inner = model as unknown as Record<'doGenerate' | 'doStream', (args: AnyCall) => Promise<unknown>>;
	const wrapped = Object.create(
		Object.getPrototypeOf(model),
		Object.getOwnPropertyDescriptors(model),
	) as GatewayLanguageModel;
	const target = wrapped as unknown as Record<'doGenerate' | 'doStream', (args: AnyCall) => Promise<unknown>>;
	target.doGenerate = args => inner.doGenerate(withStoreFalse(args));
	target.doStream = args => inner.doStream(withStoreFalse(args));
	return wrapped;
}

export const openAICodexGateway = new OpenAICodexGateway();
