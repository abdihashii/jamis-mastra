import type { AnySpan } from '@mastra/core/observability';

import { createTool } from '@mastra/core/tools';
import { Firecrawl } from 'firecrawl';
import process from 'node:process';
import { z } from 'zod';

import { requireEnv } from '../env';

const searchProvider = process.env.WEB_SEARCH_PROVIDER ?? 'perplexity';
if (searchProvider !== 'perplexity' && searchProvider !== 'firecrawl')
	throw new Error('Invalid WEB_SEARCH_PROVIDER. Use perplexity or firecrawl.');

const perplexityApiKey = searchProvider === 'perplexity' ? requireEnv('PERPLEXITY_API_KEY') : undefined;
const firecrawl = new Firecrawl({
	apiKey: requireEnv('FIRECRAWL_API_KEY'),
});
const searchOutputSchema = z.object({
	results: z.array(z.object({
		title: z.string().nullable(),
		url: z.string().url(),
	})).max(3),
});
const scrapeOutputSchema = z.object({
	markdown: z.string().refine(value => value.trim().length > 0),
});
const perplexityResponseSchema = z.object({
	results: z.array(searchOutputSchema.shape.results.element.extend({
		title: z.string().nullable().default(null),
	})),
});

async function searchPerplexity(query: string) {
	const response = await fetch('https://api.perplexity.ai/search', {
		method: 'POST',
		headers: { 'Authorization': `Bearer ${perplexityApiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ query, max_results: 3, search_context_size: 'medium' }),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok)
		throw new Error('Search request failed.');
	const { results } = perplexityResponseSchema.parse(await response.json());
	return { results: results.slice(0, 3) };
}

async function searchFirecrawl(query: string) {
	const response = await firecrawl.search(query, { limit: 3 });
	const results = (response.web ?? []).map((result) => {
		if ('url' in result) {
			return { title: result.title ?? null, url: result.url };
		}

		return { title: result.metadata?.title ?? null, url: result.metadata?.sourceURL };
	});

	return searchOutputSchema.parse({ results: results.slice(0, 3) });
}

// Provider failures and diagnostics never cross the research tool boundary.
async function runWebOperation<T>(operation: 'search' | 'scrape', run: () => Promise<T>, span?: AnySpan): Promise<T> {
	const started = performance.now();
	let outcome = 'error';
	try {
		const result = await run();
		outcome = 'success';
		return result;
	} catch {
		throw new Error(operation === 'search' ? 'Web search failed.' : 'Web scrape failed.');
	} finally {
		span?.update({
			metadata: { webOperation: {
				operation,
				provider: operation === 'search' ? searchProvider : 'firecrawl',
				durationMs: Math.round(performance.now() - started),
				outcome,
			} },
		});
	}
}

export const webSearch = createTool({
	id: 'web-search',
	description: 'Search the web and return up to three result titles and URLs.',
	inputSchema: z.object({
		query: z.string().trim().min(1),
	}),
	outputSchema: searchOutputSchema,
	execute: async ({ query }, context) => runWebOperation('search', () =>
		searchProvider === 'perplexity' ? searchPerplexity(query) : searchFirecrawl(query), context?.tracing?.currentSpan),
});

export const webScrape = createTool({
	id: 'web-scrape',
	description: 'Scrape a URL and return its fresh main-content markdown.',
	inputSchema: z.object({
		url: z.string().url(),
	}),
	outputSchema: scrapeOutputSchema,
	execute: async ({ url }, context) => runWebOperation('scrape', async () => {
		const response = await firecrawl.scrape(url, {
			formats: ['markdown'],
			autoResume: false,
			onlyMainContent: true,
			maxAge: 0,
			storeInCache: false,
		});

		return scrapeOutputSchema.parse({ markdown: response.markdown });
	}, context?.tracing?.currentSpan),
});
