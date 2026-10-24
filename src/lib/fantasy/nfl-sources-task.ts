import { Firecrawl } from 'firecrawl';
import { z } from 'zod';

import type { NflSourceInput } from './nfl-sources.schema';
import type { NflSourceResult } from './nfl-sources.types';

import { admitNflSourceRequest, nflSourceCatalogueOptions, normalizeNflSourceResult } from './nfl-sources';
import { nflSourceInputSchema, season } from './nfl-sources.schema';

const credits = z.number().int().nonnegative();
function empty(): NflSourceResult {
	return {
		status: 'blocked',
		trust: 'untrusted-source-data',
		requestId: null,
		catalogueRequestId: null,
		quotedCredits: null,
		credits: null,
		adminActionUrl: null,
		chargeIdPresent: false,
		gaps: [],
		source: null,
		records: [],
	};
}
function failure(error: unknown, output: NflSourceResult) {
	const details = z.object({
		code: z.string().optional(),
		status: z.number().optional(),
		chargeId: z.string().optional(),
		requiresAction: z.object({ url: z.string() }).optional(),
	}).safeParse(error);
	output.chargeIdPresent = details.success && Boolean(details.data.chargeId);
	if (details.success && details.data.code === 'THIRD_PARTY_DATA_TERMS_REQUIRED') {
		output.status = 'terms_required';
		const url = details.data.requiresAction?.url;
		if (url === 'https://www.firecrawl.dev/app/settings?tab=data-sources')
			output.adminActionUrl = url;
	} else if (details.success && [401, 403].includes(details.data.status ?? 0)) {
		output.status = 'access_denied';
	} else {
		output.status = output.credits === null ? 'unknown_outcome' : 'upstream_error';
	}
}

/** One fresh public-NFL task: one catalogue, at most three distinct reads, no automatic retries. */
export function createNflSourceTask(config: {
	currentSeason: number;
	apiKey: string;
	apiUrl?: string;
	now?: () => Date;
}) {
	const currentSeason = season.parse(config.currentSeason);
	if (!config.apiKey.trim())
		throw new Error('NFL research credentials unavailable.');
	const client = new Firecrawl({ apiKey: config.apiKey, apiUrl: config.apiUrl ?? 'https://api.firecrawl.dev', maxRetries: 1 });
	const now = config.now ?? (() => new Date());
	let halted = false;
	let catalogueId: string | null = null;
	let contracts: Promise<unknown[] | NflSourceResult> | undefined;
	const reads = new Map<string, Promise<NflSourceResult>>();
	async function execute(
		provider: string,
		capability: string,
		options: Record<string, unknown>,
		price: number,
		output: NflSourceResult,
	) {
		output.requestId = crypto.randomUUID();
		output.quotedCredits = price;
		try {
			const response = await client.scrape({
				alexandria: { provider, capability, options },
				requestId: output.requestId,
				timeout: 20_000,
			});
			output.credits = credits.parse(response.creditsCost);
			const item = z.object({
				provider: z.literal(provider),
				capability: z.literal(capability),
				creditsCost: credits,
				upstreamStatus: z.number().int().optional(),
				error: z.unknown().optional(),
				data: z.unknown().optional(),
			}).parse(z.array(z.unknown()).length(1).parse(response.alexandria)[0]);
			if (item.creditsCost !== output.credits || output.credits > price)
				throw new Error('Unexpected charge');
			if (item.error !== undefined) {
				failure(item.error, output);
			} else if (item.upstreamStatus !== undefined && (item.upstreamStatus < 200 || item.upstreamStatus >= 300)) {
				failure({ status: item.upstreamStatus }, output);
			} else if (item.data === undefined) {
				throw new Error('Missing source data');
			} else {
				return item.data;
			}
		} catch (error) {
			if (output.credits === null)
				failure(error, output);
			else
				output.status = 'invalid_response';
		}
		if (output.status !== 'upstream_error')
			halted = true;
		return undefined;
	}
	async function inspect() {
		const output = empty();
		const data = await execute('firecrawl', 'find-tools', nflSourceCatalogueOptions, 0, output);
		catalogueId = output.requestId;
		if (data === undefined) {
			halted = true;
			return output;
		}
		try {
			return z.object({ items: z.array(z.unknown()).max(3) }).parse(data).items;
		} catch {
			halted = true;
			output.status = 'invalid_response';
			return output;
		}
	}
	async function run(input: NflSourceInput) {
		const output = empty();
		const inspected = await (contracts ??= inspect());
		if (!Array.isArray(inspected))
			return inspected;
		output.catalogueRequestId = catalogueId;
		if (halted) {
			output.gaps.push('task_stopped');
			return output;
		}
		let request: ReturnType<typeof admitNflSourceRequest>;
		try {
			request = admitNflSourceRequest(inspected, input);
		} catch {
			output.gaps.push('pricing_or_contract_unsupported');
			return output;
		}
		const data = await execute(request.provider, request.capability, request.options, 5, output);
		if (data !== undefined) {
			try {
				normalizeNflSourceResult(data, input, output, now().toISOString());
			} catch {
				output.status = 'invalid_response';
				output.records = [];
				output.source = null;
			}
		}
		if (output.status === 'invalid_response') {
			halted = true;
			output.gaps.push('invalid_response');
		}
		return output;
	}
	return async (raw: unknown): Promise<NflSourceResult> => {
		const parsed = nflSourceInputSchema.safeParse(raw);
		const output = empty();
		if (!parsed.success) {
			output.gaps.push('invalid_public_projection');
			return output;
		}
		if (parsed.data.operation === 'weekly-results' && parsed.data.season !== currentSeason) {
			output.gaps.push('older_season_projections_unsupported');
			return output;
		}
		const key = JSON.stringify(parsed.data);
		const previous = reads.get(key);
		if (previous)
			return previous;
		if (halted || reads.size >= 3) {
			output.gaps.push(halted ? 'task_stopped' : 'request_budget_exhausted');
			return output;
		}
		const result = run(parsed.data);
		reads.set(key, result);
		return result;
	};
}
