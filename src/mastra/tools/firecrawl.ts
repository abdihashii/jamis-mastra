import { createTool } from '@mastra/core/tools';
import { Firecrawl } from 'firecrawl';
import { z } from 'zod';

import { requireEnv } from '../env';

const firecrawl = new Firecrawl({
	apiKey: requireEnv('FIRECRAWL_API_KEY'),
});

export const firecrawlSearch = createTool({
	id: 'firecrawl-search',
	description: 'Search the web and return up to three result titles and URLs.',
	inputSchema: z.object({
		query: z.string().trim().min(1),
	}),
	outputSchema: z.object({
		results: z.array(
			z.object({
				title: z.string().nullable(),
				url: z.string().url(),
			}),
		),
	}),
	execute: async ({ query }) => {
		const response = await firecrawl.search(query, { limit: 3 });
		const results = (response.web ?? []).flatMap((result) => {
			if ('url' in result) {
				return { title: result.title ?? null, url: result.url };
			}

			const url = result.metadata?.sourceURL;

			return url ? { title: result.metadata?.title ?? null, url } : [];
		});

		return { results };
	},
});

export const firecrawlScrape = createTool({
	id: 'firecrawl-scrape',
	description: 'Scrape a URL and return its fresh main-content markdown.',
	inputSchema: z.object({
		url: z.string().url(),
	}),
	outputSchema: z.object({
		markdown: z.string(),
	}),
	execute: async ({ url }) => {
		const response = await firecrawl.scrape(url, {
			formats: ['markdown'],
			onlyMainContent: true,
			maxAge: 0,
			storeInCache: false,
		});

		if (!response.markdown) {
			throw new Error(`Firecrawl returned no markdown for "${url}".`);
		}

		return { markdown: response.markdown };
	},
});
