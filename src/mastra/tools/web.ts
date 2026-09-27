import type { AnySpan } from '@mastra/core/observability';

import { createTool } from '@mastra/core/tools';
import { Firecrawl } from 'firecrawl';
import { z } from 'zod';

import { requireEnv } from '../env';

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

// Provider failures and diagnostics never cross the research tool boundary.
async function runWebOperation<T>(operation: 'search' | 'scrape', run: () => Promise<T>, span?: AnySpan): Promise<T> {
	const started = performance.now();
	let outcome = 'error';
	try {
		const result = await run();
		outcome = 'success';
		return result;
	}
	catch {
		throw new Error(operation === 'search' ? 'Web search failed.' : 'Web scrape failed.');
	}
	finally {
		span?.update({
			metadata: { webOperation: {
				operation,
				provider: 'firecrawl',
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
	execute: async ({ query }, context) => runWebOperation('search', async () => {
		const response = await firecrawl.search(query, { limit: 3 });
		const results = (response.web ?? []).flatMap((result) => {
			if ('url' in result) {
				return { title: result.title ?? null, url: result.url };
			}

			const url = result.metadata?.sourceURL;

			return url ? { title: result.metadata?.title ?? null, url } : [];
		});

		return searchOutputSchema.parse({ results: results.slice(0, 3) });
	}, context?.tracing?.currentSpan),
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
