import type { AnyExportedSpan } from '@mastra/core/observability';
import type { ToolExecutionContext } from '@mastra/core/tools';

import { expect, test } from 'bun:test';
import { createObservabilityContext, SpanType, TracingEventType } from '@mastra/core/observability';
import { noopObserve, validateToolInput, validateToolOutput } from '@mastra/core/tools';
import { Observability } from '@mastra/observability';

test('neutral web tools normalize Firecrawl results, hide failures, and preserve timeout behavior', async () => {
	let markdown: string | undefined = '# Public evidence';
	let web: unknown[] = [
		{ title: 'Direct result', url: 'https://example.com/direct', snippet: 'Not returned' },
		{ metadata: { title: 'Scraped result', sourceURL: 'https://example.com/scraped' } },
	];
	let failedOperation: 'search' | 'scrape' | undefined;
	let processing = false;
	let searchCalls = 0;
	let scrapeCalls = 0;
	let body: Record<string, unknown> = {};
	const rawError = 'fc-local-test public query upstream diagnostic https://example.com';
	const spans: AnyExportedSpan[] = [];
	let logs = 0;
	const observability = new Observability({
		configs: { test: {
			serviceName: 'web-test',
			exporters: [{
				name: 'capture',
				onTracingEvent(event) {
					if (event.type === TracingEventType.SPAN_ENDED)
						spans.push(event.exportedSpan);
				},
				onLogEvent() { logs += 1; },
				exportTracingEvent: async () => {},
				flush: async () => {},
				shutdown: async () => {},
			}],
		} },
	});
	const instance = observability.getInstance('test')!;
	async function traced<T>(toolId: string, run: (context: ToolExecutionContext) => Promise<T>): Promise<T> {
		const span = instance.startSpan({ name: toolId, type: SpanType.TOOL_CALL, metadata: { preserved: 'existing' } });
		const context = createObservabilityContext({ currentSpan: span });
		try {
			const result = await run({ ...context, observe: {
				...noopObserve,
				log: (level, message, data) => context.loggerVNext[level](message, data),
			} });
			span.end({ output: result });
			return result;
		}
		catch (error) {
			span.error({ error: error as Error, endSpan: true });
			throw error;
		}
	}
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			body = await request.json() as Record<string, unknown>;
			if (new URL(request.url).pathname === '/v2/search') {
				searchCalls += 1;
				return failedOperation === 'search'
					? Response.json({ success: false, error: rawError }, { status: 503 })
					: Response.json({ success: true, data: { web } });
			}
			scrapeCalls += 1;
			if (failedOperation === 'scrape')
				return Response.json({ success: false, error: rawError }, { status: 503 });
			return processing
				? Response.json({ success: false, code: 'SCRAPE_TIMEOUT', error: 'Still processing', details: { state: 'processing_continues', retryAfterSeconds: 0 } }, { status: 408 })
				: Response.json({ success: true, data: { markdown } });
		},
	});
	const apiUrl = process.env.FIRECRAWL_API_URL;
	const apiKey = process.env.FIRECRAWL_API_KEY;
	process.env.FIRECRAWL_API_URL = server.url.toString();
	process.env.FIRECRAWL_API_KEY = 'fc-local-test';
	try {
		const { webSearch, webScrape } = await import('../web');
		const search = (query = 'public query') => traced('webSearch', context => webSearch.execute!({ query }, context));
		const scrape = () => traced('webScrape', context => webScrape.execute!({ url: 'https://example.com' }, context));
		expect(webSearch.id).toBe('web-search');
		expect(webScrape.id).toBe('web-scrape');
		expect(await search()).toEqual({ results: [
			{ title: 'Direct result', url: 'https://example.com/direct' },
			{ title: 'Scraped result', url: 'https://example.com/scraped' },
		] });
		expect(body).toMatchObject({ query: 'public query', limit: 3 });
		expect(await scrape()).toEqual({ markdown });
		expect(body).toMatchObject({ formats: ['markdown'], onlyMainContent: true, maxAge: 0, storeInCache: false });
		expect(body).not.toHaveProperty('autoResume');

		const only = { title: null, url: 'https://example.com/only' };
		web = [only];
		expect(await search('X')).toEqual({ results: [only] });
		expect(body.query).toBe('X');
		expect(validateToolInput(webSearch.inputSchema, { query: ' ' }).error).toBeDefined();
		markdown = '0';
		expect(await scrape()).toEqual({ markdown: '0' });

		const candidates = Array.from({ length: 4 }, (_, index) => ({ title: null, url: `https://example.com/${index}` }));
		web = candidates;
		expect(validateToolOutput(webSearch.outputSchema, { results: candidates }).error).toBeDefined();
		expect(await search()).toEqual({ results: [
			{ title: null, url: 'https://example.com/0' },
			{ title: null, url: 'https://example.com/1' },
			{ title: null, url: 'https://example.com/2' },
		] });
		web = [];
		expect(await search()).toEqual({ results: [] });
		web = [{ title: 'Invalid', url: 'not a URL' }];
		await expect(search()).rejects.toThrow('Web search failed.');
		failedOperation = 'search';
		const searchesBefore = searchCalls;
		const searchError = await search().catch(error => error);
		expect(searchError.message).toBe('Web search failed.');
		expect(searchError).not.toHaveProperty('cause');
		expect(searchCalls).toBe(searchesBefore + 1);
		failedOperation = 'scrape';
		const scrapesBefore = scrapeCalls;
		await expect(scrape()).rejects.toThrow('Web scrape failed.');
		expect(scrapeCalls).toBe(scrapesBefore + 1);
		failedOperation = undefined;
		for (const missing of [undefined, '', ' \n\t']) {
			markdown = missing;
			await expect(scrape()).rejects.toThrow('Web scrape failed.');
		}
		processing = true;
		const before = scrapeCalls;
		await expect(scrape()).rejects.toThrow('Web scrape failed.');
		expect(scrapeCalls).toBe(before + 1);
		await instance.flush();
		expect(logs).toBe(0);
		expect(spans).toHaveLength(13);
		const operations = spans.map((span) => {
			expect(span.metadata?.preserved).toBe('existing');
			const operation = span.metadata?.webOperation as Record<string, unknown>;
			expect(Object.keys(operation).sort()).toEqual(['durationMs', 'operation', 'outcome', 'provider']);
			expect(operation.provider).toBe('firecrawl');
			expect(operation.operation).toBe(span.name === 'webSearch' ? 'search' : 'scrape');
			expect(operation.durationMs).toBeNumber();
			expect(Number.isFinite(operation.durationMs)).toBe(true);
			expect(operation.durationMs).toBeGreaterThanOrEqual(0);
			return operation;
		});
		expect(operations.filter(operation => operation.outcome === 'success')).toHaveLength(6);
		expect(operations.filter(operation => operation.outcome === 'error')).toHaveLength(7);
		const telemetry = JSON.stringify(operations);
		expect(telemetry).not.toContain(rawError);
		expect(telemetry).not.toContain('public query');
		expect(telemetry).not.toContain('https://example.com');
		for (const span of spans.filter(span => span.errorInfo)) {
			expect(span.errorInfo?.message).toMatch(/^Web (search|scrape) failed\.$/);
		}
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
		await instance.shutdown();
	}
}, 2000);
