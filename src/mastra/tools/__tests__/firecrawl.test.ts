import { expect, test } from 'bun:test';

test('Firecrawl tools preserve fresh results and fail processing timeouts without resuming', async () => {
	let markdown: string | undefined = '# Public evidence';
	let processing = false;
	let scrapeCalls = 0;
	let body: Record<string, unknown> = {};
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			body = await request.json() as Record<string, unknown>;
			if (new URL(request.url).pathname === '/v2/search') {
				return Response.json({ success: true, data: { web: [
					{ title: 'Direct result', url: 'https://example.com/direct' },
					{ metadata: { title: 'Scraped result', sourceURL: 'https://example.com/scraped' } },
				] } });
			}
			scrapeCalls += 1;
			return processing
				? Response.json({ success: false, error: 'Still processing', details: { state: 'processing_continues', retryAfterSeconds: 0 } }, { status: 408 })
				: Response.json({ success: true, data: { markdown } });
		},
	});
	const apiUrl = process.env.FIRECRAWL_API_URL;
	const apiKey = process.env.FIRECRAWL_API_KEY;
	process.env.FIRECRAWL_API_URL = server.url.toString();
	process.env.FIRECRAWL_API_KEY = 'fc-local-test';
	try {
		const { firecrawlSearch, firecrawlScrape } = await import('../firecrawl');
		expect(await firecrawlSearch.execute!({ query: 'public query' }, {} as never)).toEqual({ results: [
			{ title: 'Direct result', url: 'https://example.com/direct' },
			{ title: 'Scraped result', url: 'https://example.com/scraped' },
		] });
		expect(body).toMatchObject({ query: 'public query', limit: 3 });
		expect(await firecrawlScrape.execute!({ url: 'https://example.com' }, {} as never)).toEqual({ markdown });
		expect(body).toMatchObject({ formats: ['markdown'], onlyMainContent: true, maxAge: 0, storeInCache: false });
		expect(body).not.toHaveProperty('autoResume');
		markdown = undefined;
		await expect(firecrawlScrape.execute!({ url: 'https://example.com' }, {} as never)).rejects.toThrow('no markdown');
		processing = true;
		const before = scrapeCalls;
		await expect(firecrawlScrape.execute!({ url: 'https://example.com' }, {} as never)).rejects.toThrow('Still processing');
		expect(scrapeCalls).toBe(before + 1);
	}
	finally {
		if (apiUrl === undefined)
			delete process.env.FIRECRAWL_API_URL;
		else
			process.env.FIRECRAWL_API_URL = apiUrl;
		if (apiKey === undefined)
			delete process.env.FIRECRAWL_API_KEY;
		else
			process.env.FIRECRAWL_API_KEY = apiKey;
		server.stop(true);
	}
}, 2000);
