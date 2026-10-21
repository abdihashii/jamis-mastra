import type { AnyExportedSpan } from '@mastra/core/observability';
import type { ToolExecutionContext } from '@mastra/core/tools';

import { expect, spyOn, test } from 'bun:test';
import { createObservabilityContext, SpanType, TracingEventType } from '@mastra/core/observability';
import { noopObserve, validateToolInput, validateToolOutput } from '@mastra/core/tools';
import { Observability } from '@mastra/observability';

const contractProvider = process.env.WEB_CONTRACT_PROVIDER;

if (!contractProvider) {
	for (const provider of ['perplexity', 'firecrawl']) {
		test(`${provider} web contracts run with isolated startup configuration`, async () => {
			const env: Record<string, string | undefined> = { ...process.env, WEB_CONTRACT_PROVIDER: provider, FIRECRAWL_API_KEY: 'fc-local-test' };
			delete env.WEB_SEARCH_PROVIDER;
			delete env.PERPLEXITY_API_KEY;
			if (provider === 'firecrawl')
				env.WEB_SEARCH_PROVIDER = provider;
			else
				env.PERPLEXITY_API_KEY = 'pplx-local-test';
			const child = Bun.spawn([process.execPath, '--no-env-file', 'test', import.meta.path], { env, stdout: 'pipe', stderr: 'pipe' });
			const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
			expect({ exit, output: exit === 0 ? '' : stdout + stderr }).toEqual({ exit: 0, output: '' });
		}, 10_000);
	}

	test('startup validates provider selection and selected credentials', async () => {
		const cases = [
			{ provider: undefined, firecrawl: true, perplexity: true, error: undefined },
			{ provider: 'perplexity', firecrawl: true, perplexity: true, error: undefined },
			{ provider: 'firecrawl', firecrawl: true, perplexity: false, error: undefined },
			{ provider: undefined, firecrawl: true, perplexity: false, error: 'Missing required env var: PERPLEXITY_API_KEY' },
			{ provider: 'perplexity', firecrawl: false, perplexity: true, error: 'Missing required env var: FIRECRAWL_API_KEY' },
			{ provider: 'firecrawl', firecrawl: false, perplexity: false, error: 'Missing required env var: FIRECRAWL_API_KEY' },
			...['invalid', '', 'Perplexity'].map(provider => ({ provider, firecrawl: true, perplexity: true, error: 'Invalid WEB_SEARCH_PROVIDER. Use perplexity or firecrawl.' })),
		];
		for (const config of cases) {
			const env = { ...process.env };
			delete env.WEB_SEARCH_PROVIDER;
			delete env.FIRECRAWL_API_KEY;
			delete env.PERPLEXITY_API_KEY;
			if (config.provider !== undefined)
				env.WEB_SEARCH_PROVIDER = config.provider;
			if (config.firecrawl)
				env.FIRECRAWL_API_KEY = 'fc-local-test';
			if (config.perplexity)
				env.PERPLEXITY_API_KEY = 'pplx-local-test';
			const source = `try { await import(${JSON.stringify(new URL('../web.ts', import.meta.url).pathname)}); console.log('ready'); } catch (error) { console.log(error.message); process.exit(1); }`;
			const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', source], { env, stdout: 'pipe', stderr: 'pipe' });
			const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
			expect({ exit, stdout: stdout.trim(), stderr }).toEqual({ exit: config.error ? 1 : 0, stdout: config.error ?? 'ready', stderr: '' });
		}
	}, 10_000);
}
async function verifyWebContract() {
	let markdown: string | undefined = '# Public evidence';
	let web: unknown = [
		{ title: 'Direct result', url: 'https://example.com/direct', snippet: 'Not returned' },
		contractProvider === 'firecrawl'
			? { metadata: { title: 'Scraped result', sourceURL: 'https://example.com/scraped' } }
			: { title: 'Scraped result', url: 'https://example.com/scraped', date: '2026-09-27', last_updated: '2026-09-27' },
	];
	let failedOperation: 'search' | 'scrape' | undefined;
	let invalidJson = false;
	let timeout = false;
	let timeoutMs = 0;
	let processing = false;
	let searchCalls = 0;
	let scrapeCalls = 0;
	let body: Record<string, unknown> = {};
	const rawError = 'fc-local-test pplx-local-test public query upstream diagnostic https://example.com';
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
		} catch (error) {
			span.error({ error: error as Error, endSpan: true });
			throw error;
		}
	}
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			body = await request.json() as Record<string, unknown>;
			const path = new URL(request.url).pathname;
			if (path === '/v2/search' || path === '/search') {
				searchCalls += 1;
				if (timeout)
					return new Promise<Response>(() => {});
				if (invalidJson)
					return new Response('{invalid');
				return failedOperation === 'search'
					? Response.json({ success: false, error: rawError }, { status: 503 })
					: Response.json(path === '/search' ? { results: web } : { success: true, data: { web } });
			}
			scrapeCalls += 1;
			if (invalidJson)
				return new Response('{invalid');
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
	const originalFetch = globalThis.fetch;
	const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input, init) => {
		expect(String(input)).toBe('https://api.perplexity.ai/search');
		expect(contractProvider).toBe('perplexity');
		expect(init?.method).toBe('POST');
		expect(init?.headers).toEqual({ 'Authorization': 'Bearer pplx-local-test', 'Content-Type': 'application/json' });
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		return originalFetch(new URL('/search', server.url), init);
	}) as typeof fetch);
	const originalTimeout = AbortSignal.timeout;
	const timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
		timeoutMs = ms;
		return originalTimeout(timeout ? 10 : ms);
	});
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
		expect(body).toMatchObject(contractProvider === 'perplexity'
			? { query: 'public query', max_results: 3, search_context_size: 'medium' }
			: { query: 'public query', limit: 3 });
		if (contractProvider === 'perplexity')
			expect(timeoutMs).toBe(30_000);
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
		for (const malformed of [[null], [{ title: 17, url: 'https://example.com' }], [{ title: 'Missing URL' }], {}]) {
			web = malformed;
			await expect(search()).rejects.toThrow('Web search failed.');
		}
		invalidJson = true;
		await expect(search()).rejects.toThrow('Web search failed.');
		await expect(scrape()).rejects.toThrow('Web scrape failed.');
		invalidJson = false;
		if (contractProvider === 'perplexity') {
			web = undefined;
			await expect(search()).rejects.toThrow('Web search failed.');
			web = [{ url: 'https://example.com/untitled', snippet: 'not evidence' }];
			expect(await search()).toEqual({ results: [{ title: null, url: 'https://example.com/untitled' }] });
			timeout = true;
			const beforeTimeout = searchCalls;
			await expect(search()).rejects.toThrow('Web search failed.');
			expect(searchCalls).toBe(beforeTimeout + 1);
			timeout = false;
		}
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
		expect(spans).toHaveLength(contractProvider === 'perplexity' ? 22 : 19);
		const operations = spans.map((span) => {
			expect(span.metadata?.preserved).toBe('existing');
			const operation = span.metadata?.webOperation as Record<string, unknown>;
			expect(Object.keys(operation).sort()).toEqual(['durationMs', 'operation', 'outcome', 'provider']);
			expect(operation.provider).toBe(span.name === 'webSearch' ? contractProvider : 'firecrawl');
			expect(operation.operation).toBe(span.name === 'webSearch' ? 'search' : 'scrape');
			expect(operation.durationMs).toBeNumber();
			expect(Number.isFinite(operation.durationMs)).toBe(true);
			expect(operation.durationMs).toBeGreaterThanOrEqual(0);
			return operation;
		});
		expect(operations.filter(operation => operation.outcome === 'success')).toHaveLength(contractProvider === 'perplexity' ? 7 : 6);
		expect(operations.filter(operation => operation.outcome === 'error')).toHaveLength(contractProvider === 'perplexity' ? 15 : 13);
		const telemetry = JSON.stringify(operations);
		expect(telemetry).not.toContain(rawError);
		expect(telemetry).not.toContain('public query');
		expect(telemetry).not.toContain('https://example.com');
		for (const span of spans.filter(span => span.errorInfo)) {
			expect(span.errorInfo?.message).toMatch(/^Web (search|scrape) failed\.$/);
		}
	} finally {
		fetchSpy.mockRestore();
		timeoutSpy.mockRestore();
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
}

if (contractProvider)
	test('neutral web tools normalize results, hide failures, and preserve timeout behavior', verifyWebContract, 3000);
