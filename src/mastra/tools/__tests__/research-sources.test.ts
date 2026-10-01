import type { ToolExecutionContext } from '@mastra/core/tools';

import { expect, test } from 'bun:test';
import { RequestContext } from '@mastra/core/request-context';
import { noopObserve, validateToolInput, validateToolOutput } from '@mastra/core/tools';

if (!process.env.RESEARCH_SOURCE_CONTRACT_TEST) {
	test('research source HTTP contracts run in an isolated process', async () => {
		const child = Bun.spawn([process.execPath, '--no-env-file', 'test', import.meta.path], {
			env: { ...process.env, RESEARCH_SOURCE_CONTRACT_TEST: '1', FIRECRAWL_API_KEY: 'fc-fixture' },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		expect({ exit, output: exit === 0 ? '' : stdout + stderr }).toEqual({ exit: 0, output: '' });
	}, 10_000);
}
else {
	test('bounded discovery, evidence, failures, identity, telemetry and delegation isolation', async () => {
		const query = 'public fixture question';
		const secret = 'raw upstream diagnostic fc-fixture';
		const paper = { paperId: '123', primaryId: 'arxiv:2005.11401', title: 'Paper', abstract: 'An explicit abstract finding.' };
		const document = { id: 'doc:https://example.com/docs', url: 'https://example.com/docs', title: 'Docs', passages: [{ text: 'A retrieved API contract.' }], license: 'MIT' };
		const web = { id: 'web:https://example.com/page', url: 'https://example.com/page', title: 'Web lead', passages: [{ text: 'Unread webpage snippet.' }] };
		function contract(provider: string, capability: string) {
			return {
				provider,
				capability,
				creditsCost: provider.includes('developer') ? 2 : 0,
				perRecord: provider.includes('developer'),
				recordsPerUnit: 10,
				options: [
					{ name: 'query', type: 'string', required: true },
					{ name: 'k', type: 'number', min: 1, max: 500 },
					...(capability === 'read' ? [{ name: 'paperId', type: 'string', required: true }] : []),
					...(provider.includes('developer') ? [{ name: 'passages', type: 'number', min: 1, max: 5 }] : []),
				],
				response: { key: capability === 'read' ? 'passages' : 'results', fields: [{ name: provider.includes('developer') ? 'passages' : capability === 'read' ? 'text' : 'abstract', type: provider.includes('developer') ? 'object[]' : 'string' }] },
			};
		}
		const papers = [contract('firecrawl-research-index', 'search'), contract('firecrawl-research-index', 'read')];
		const developer = [contract('firecrawl-developer-index', 'search')];
		let catalogue: unknown;
		let data: unknown;
		let itemError: unknown;
		let status = 200;
		let upstreamStatus = 200;
		let retries = 0;
		let missingCredits = false;
		let mismatch = false;
		let omitRouting = false;
		let multipleItems = false;
		let timeout = false;
		let actionUrl = 'https://www.firecrawl.dev/app/alexandria/firecrawl-developer-index';
		const requests: Array<{ id: string; body: { alexandria: Array<{ provider: string; capability: string; options: Record<string, unknown> }> } }> = [];
		const telemetry: Array<Record<string, unknown>> = [];
		const server = Bun.serve({ port: 0, async fetch(request) {
			const body = await request.json() as typeof requests[number]['body'];
			const id = request.headers.get('x-request-id')!;
			requests.push({ id, body });
			expect(new URL(request.url).pathname).toBe('/v2/scrape');
			expect(body.alexandria).toHaveLength(1);
			if (timeout)
				return Response.json({ success: false, code: 'SCRAPE_TIMEOUT', error: secret }, { status: 408 });
			if (retries > 0) {
				retries -= 1;
				return Response.json({ success: false, error: secret }, { status: 502 });
			}
			if (status !== 200)
				return Response.json({ success: false, error: secret, code: status === 403 ? 'THIRD_PARTY_DATA_TERMS_REQUIRED' : 'ACCESS_DENIED', requiresAction: { type: 'accept_terms', terms: 'fixture', version: '1', url: actionUrl } }, { status });
			const call = body.alexandria[0]!;
			const discovery = call.capability === 'find-tools';
			const result = {
				...(omitRouting ? {} : { provider: mismatch ? 'arbitrary-provider' : call.provider, capability: call.capability }),
				upstreamStatus,
				creditsCost: call.provider.includes('developer') ? 2 : 0,
				...(itemError
					? { error: itemError }
					: { data: discovery
							? { level: 'tools', items: catalogue ?? (String(call.options.providers).includes('developer') ? developer : papers) }
							: data ?? (call.provider.includes('developer')
								? { success: true, partial: false, results: [document, web] }
								: call.capability === 'read'
									? { success: true, paper: { ...paper, createdDate: 'Fri, 22 May 2020 21:34:34 GMT', updateDate: '2021-04-13' }, paperId: '123', passages: [{ text: 'Full-text finding.' }] }
									: { success: true, partial: false, results: [paper] }) }),
			};
			return Response.json({ success: true, scrape_id: 'fixture', data: { alexandria: multipleItems ? [result, result] : [result], ...(missingCredits ? {} : { creditsCost: call.provider.includes('developer') ? 2 : 0 }) } });
		} });
		process.env.FIRECRAWL_API_URL = server.url.toString();
		const { researchSourceDiscover: discoverTool, researchSourceRetrieve: retrieveTool } = await import('../research-sources');
		function context(requestContext = new RequestContext()): ToolExecutionContext {
			return { requestContext, observe: noopObserve, tracing: { currentSpan: { update: ({ metadata }: { metadata: Record<string, unknown> }) => telemetry.push(metadata.researchOperation as Record<string, unknown>) } } } as unknown as ToolExecutionContext;
		}
		const ctx = context();
		function unwrap(result: Awaited<ReturnType<NonNullable<typeof retrieveTool.execute>>>) {
			if (!result || !('evidence' in result))
				throw new Error('Tool validation failed.');
			return result;
		}
		const discover = async (domain: 'papers' | 'developer' = 'papers', target = ctx) => unwrap(await discoverTool.execute!({ domain }, target));
		const retrieve = async (operation: 'paper-search' | 'paper-read' | 'developer-search' = 'paper-search', target = ctx) => unwrap(await retrieveTool.execute!({ operation, query, paperId: operation === 'paper-read' ? '123' : null }, target));
		try {
			expect(await retrieve()).toMatchObject({ status: 'blocked', requestId: null, credits: null, gaps: ['contract_unavailable'] });
			expect(requests).toHaveLength(0);
			const discovery = await discover();
			expect(discovery).toMatchObject({ status: 'success', credits: 0, operations: [{ operation: 'paper-search', maximumCredits: 0 }, { operation: 'paper-read', maximumCredits: 0 }], evidence: [] });
			expect(requests.at(-1)!.body.alexandria[0]!.options).toEqual({ providers: ['firecrawl-research-index'], capabilities: ['search', 'read'], level: 'tools', expand: ['options', 'response'], limit: 3, offset: 0 });
			const result = await retrieve();
			expect(result).toMatchObject({ status: 'success', credits: 0, evidence: [{ originalId: 'arxiv:2005.11401', url: 'https://arxiv.org/abs/2005.11401', paperId: '123', evidenceKind: 'abstract-only', content: paper.abstract, createdAtUtc: null, updatedAtUtc: null }] });
			expect(requests.at(-1)!.id).toBe(result.requestId!);
			expect(requests.at(-1)!.body.alexandria[0]!.options).toEqual({ query, k: 10 });
			expect(validateToolOutput(retrieveTool.outputSchema, result).error).toBeUndefined();
			expect(result.evidence[0]!.retrievedAtUtc).toMatch(/Z$/);
			const read = await retrieve('paper-read');
			expect(read).toMatchObject({ status: 'success', evidence: [{ evidenceKind: 'full-text-passage', content: 'Full-text finding.', createdAtUtc: '2020-05-22T21:34:34.000Z', updatedAtUtc: '2021-04-13T00:00:00.000Z' }] });
			expect(requests.at(-1)!.body.alexandria[0]!.options).toEqual({ query, k: 3, paperId: '123' });

			// Match installed Mastra delegation: shallow-copy entries, then use a new task owner.
			const parentState = ctx.requestContext!.getRaw('jamis.research-source-contracts');
			const sibling = context(new RequestContext(ctx.requestContext!.entries()));
			expect(await retrieve('paper-search', sibling)).toMatchObject({ status: 'blocked', requestId: null });
			await discover('developer', sibling);
			const dev = await retrieve('developer-search', sibling);
			expect(dev).toMatchObject({ status: 'partial', credits: 2, evidence: [{ originalId: document.id, evidenceKind: 'developer-passage', license: 'MIT' }], candidates: [{ originalId: web.id, requiresScrape: true }] });
			expect(JSON.stringify(dev.evidence)).not.toContain('Unread webpage snippet');
			expect(requests.at(-1)!.body.alexandria[0]!.options).toEqual({ query, k: 3, passages: 3 });
			expect(ctx.requestContext!.getRaw('jamis.research-source-contracts')).toBe(parentState);
			expect(JSON.stringify(ctx.requestContext)).not.toContain('research-source-contracts');
			expect(await retrieve()).toMatchObject({ status: 'success' });
			expect(await discoverTool.execute!({ domain: 'papers' }, { observe: noopObserve })).toMatchObject({ status: 'success' });

			for (const [primaryId, url] of [['pmid:123', 'https://pubmed.ncbi.nlm.nih.gov/123/'], ['pmcid:PMC123', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC123/'], ['doi:10.1234/test', 'https://doi.org/10.1234/test'], ['arxiv:hep-th/9901001', 'https://arxiv.org/abs/hep-th/9901001']]) {
				data = { success: true, results: [{ ...paper, primaryId }] };
				expect(await retrieve()).toMatchObject({ evidence: [{ originalId: primaryId, url }] });
			}
			for (const invalid of [null, { ...paper, primaryId: '123' }, { ...paper, primaryId: 'doi:bad' }, { ...paper, primaryId: 'doi:10.1234/../bad' }, { ...paper, paperId: 'not-an-index-id' }, { ...paper, abstract: ' ' }, { ...paper, abstract: 1 }, { ...paper, success: false }, { ...paper, error: { message: secret } }]) {
				data = { success: true, results: [paper, invalid], partial: true };
				const partial = await retrieve();
				expect(partial.status).toBe('partial');
				expect(partial.evidence).toHaveLength(1);
				expect(partial.gaps).toContain('partial_results');
				expect(JSON.stringify(partial)).not.toContain(secret);
			}
			data = { success: true, results: [{ paperId: 'web:https://example.com/lead', title: 'Lead', abstract: 'Not evidence.' }] };
			expect(await retrieve()).toMatchObject({ evidence: [], candidates: [{ requiresScrape: true }] });
			data = { success: true, results: [] };
			expect(await retrieve()).toMatchObject({ status: 'empty', evidence: [], gaps: ['empty_results'] });
			for (const invalid of [{ success: true, partial: 'maybe', results: [paper] }, { success: true, results: {} }, { success: true, results: Array.from({ length: 11 }).fill(paper) }]) {
				data = invalid;
				expect(await retrieve()).toMatchObject({ status: 'invalid_response', evidence: [] });
			}
			data = { success: true, paper, paperId: '124', passages: [{ text: 'Mismatched paper.' }] };
			expect(await retrieve('paper-read')).toMatchObject({ evidence: [], gaps: ['unsupported_provenance', 'empty_results'] });
			data = { success: true, paper, paperId: '123', passages: [] };
			expect(await retrieve('paper-read')).toMatchObject({ evidence: [], gaps: ['missing_content', 'empty_results'] });
			data = { success: false, code: 'THIRD_PARTY_DATA_TERMS_REQUIRED', requiresAction: { url: actionUrl } };
			expect(await retrieve()).toMatchObject({ status: 'terms_required', evidence: [], adminActionUrl: actionUrl });
			data = { success: true, results: [{ ...paper, createdDate: '2026-02-30', updateDate: '09/30/2026' }] };
			expect(await retrieve()).toMatchObject({ evidence: [{ createdAtUtc: null, updatedAtUtc: null }] });
			for (const malformed of ['2026-02-30T00:00:00Z', '2026-02-30T00:00:00-05:00', 'Mon, 30 Feb 2026 00:00:00 GMT', '2025-02-29T00:00:00Z']) {
				data = { success: true, results: [{ ...paper, createdDate: malformed, updateDate: malformed }] };
				expect(await retrieve()).toMatchObject({ evidence: [{ createdAtUtc: null, updatedAtUtc: null }] });
			}
			data = { success: true, results: [{ ...paper, createdDate: '2024-02-29T23:30:00-05:00', updateDate: 'Thu, 29 Feb 2024 23:30:00 GMT' }] };
			expect(await retrieve()).toMatchObject({ evidence: [{ createdAtUtc: '2024-03-01T04:30:00.000Z', updatedAtUtc: '2024-02-29T23:30:00.000Z' }] });
			data = undefined;

			await discover('developer');
			for (const record of [
				{ id: 'issue:owner/repo#1', url: 'https://github.com/owner/repo/issues/1', license: { state: 'licensed', spdx_id: 'MIT' } },
				{ id: 'pull_request:owner/repo#2', url: 'https://github.com/owner/repo/pull/2', license: { state: 'known_absent' } },
				{ id: 'readme:owner/repo', url: 'https://github.com/owner/repo', title: null, license: { state: 'unknown' } },
			]) {
				data = { success: true, results: [{ ...record, passages: [{ text: 'Repo evidence.', citation_url: `${record.url}#comment` }] }] };
				expect(await retrieve('developer-search')).toMatchObject({ status: 'success', evidence: [{ originalId: record.id, title: record.url, attribution: `${record.url}#comment` }] });
			}
			for (const invalid of [{ ...document, id: '123' }, { ...document, id: 'readme:owner/repo', url: 'https://github.com/owner/repo/blob/../../other' }, { ...document, url: 'https://example.com/other' }, { ...document, passages: [] }, { ...document, passages: [{ text: ' ' }] }, { ...document, passages: [{ text: 'failed passage', success: false }] }, { ...document, passages: [{ text: 'failed passage', error: secret }] }, { ...document, passages: Array.from({ length: 4 }, () => ({ text: 'Too many' })) }, { ...web, url: 'javascript:alert(1)' }]) {
				data = { success: true, results: [invalid] };
				expect(await retrieve('developer-search')).toMatchObject({ evidence: [], candidates: [] });
			}
			data = undefined;

			for (const change of [{ creditsCost: undefined }, { creditsCost: 3 }, { perRecord: undefined }, { recordsPerUnit: 0 }, { recordsPerUnit: 1.5 }, { creditsCost: -1 }, { creditsCost: 0.5 }, { response: undefined }, { options: [] }, { options: [...developer[0]!.options, { name: 'write', type: 'boolean', required: true }] }]) {
				catalogue = [{ ...developer[0], ...change }];
				expect(await discover('developer')).toMatchObject({ status: 'blocked', operations: [] });
				const count = requests.length;
				expect(await retrieve('developer-search')).toMatchObject({ status: 'blocked', requestId: null });
				expect(requests).toHaveLength(count);
			}
			catalogue = developer;
			expect(await discover('developer')).toMatchObject({ operations: [{ operation: 'developer-search', maximumCredits: 6 }] });
			catalogue = [{ ...developer[0], perRecord: false }];
			expect(await discover('developer')).toMatchObject({ operations: [{ operation: 'developer-search', maximumCredits: 2 }] });
			catalogue = [...developer, ...developer];
			expect(await discover('developer')).toMatchObject({ status: 'blocked' });
			catalogue = [];
			expect(await discover()).toMatchObject({ status: 'blocked', operations: [] });
			for (const invalid of [{}, [null], [{ provider: 'unapproved', capability: 'write' }]]) {
				catalogue = invalid;
				expect(await discover()).toMatchObject({ operations: [] });
				expect(await retrieve()).toMatchObject({ status: 'blocked', requestId: null });
			}
			catalogue = undefined;
			await discover();
			for (const field of ['mismatch', 'multiple', 'credits']) {
				mismatch = field === 'mismatch';
				multipleItems = field === 'multiple';
				missingCredits = field === 'credits';
				const bad = await retrieve();
				expect(bad).toMatchObject({ status: field === 'credits' ? 'unknown_outcome' : 'invalid_response', evidence: [] });
				if (missingCredits)
					expect(bad.credits).toBeNull();
			}
			mismatch = false;
			multipleItems = false;
			missingCredits = false;
			itemError = { code: 'THIRD_PARTY_DATA_TERMS_REQUIRED', message: secret, requiresAction: { url: actionUrl } };
			expect(await retrieve()).toMatchObject({ status: 'terms_required', adminActionUrl: actionUrl, evidence: [] });
			itemError = { code: 'ACCESS_DENIED', status: 401, message: secret };
			expect(await retrieve()).toMatchObject({ status: 'access_denied' });
			omitRouting = true;
			itemError = { code: 'THIRD_PARTY_DATA_TERMS_REQUIRED', status: 403, message: secret, requiresAction: { url: actionUrl } };
			expect(await retrieve()).toMatchObject({ status: 'terms_required', adminActionUrl: actionUrl, credits: 0, evidence: [] });
			itemError = { code: 'ACCESS_DENIED', status: 403, message: secret };
			expect(await retrieve()).toMatchObject({ status: 'access_denied', evidence: [] });
			itemError = undefined;
			expect(await retrieve()).toMatchObject({ status: 'invalid_response', evidence: [] });
			omitRouting = false;
			mismatch = true;
			itemError = { code: 'ACCESS_DENIED', status: 403, message: secret };
			expect(await retrieve()).toMatchObject({ status: 'invalid_response', evidence: [] });
			mismatch = false;
			itemError = undefined;
			upstreamStatus = 503;
			expect(await retrieve()).toMatchObject({ status: 'upstream_error', evidence: [] });
			upstreamStatus = 200;
			status = 403;
			for (const url of [actionUrl, 'https://www.firecrawl.dev/app/settings?tab=data-sources', 'https://evil.example/terms', 'https://www.firecrawl.dev.evil.example/app/settings?tab=data-sources', 'https://secret@www.firecrawl.dev/app/settings?tab=data-sources', 'https://www.firecrawl.dev/app/settings?tab=data-sources&token=private']) {
				actionUrl = url;
				const terms = await retrieve();
				expect(terms).toMatchObject({ status: 'terms_required', adminActionUrl: url.includes('secret@') || url.includes('evil') || url.includes('token=') ? null : url });
			}
			status = 401;
			const before = requests.length;
			expect(await retrieve()).toMatchObject({ status: 'access_denied', credits: null });
			expect(requests).toHaveLength(before + 1);
			status = 503;
			expect(await retrieve()).toMatchObject({ status: 'upstream_error' });
			status = 200;
			retries = 2;
			const retryStart = requests.length;
			const retried = await retrieve();
			expect(retried.status).toBe('success');
			expect(requests.slice(retryStart)).toHaveLength(3);
			expect(new Set(requests.slice(retryStart).map(request => request.id))).toEqual(new Set([retried.requestId!]));
			expect(new Set(requests.slice(retryStart).map(request => JSON.stringify(request.body))).size).toBe(1);

			timeout = true;
			const timeoutStart = requests.length;
			const uncertain = await retrieve();
			expect(uncertain).toMatchObject({ status: 'unknown_outcome', credits: null });
			expect(requests).toHaveLength(timeoutStart + 1);
			expect(requests.at(-1)!.id).toBe(uncertain.requestId!);
			timeout = false;

			const noCalls = requests.length;
			for (const input of [{ operation: 'arbitrary-execute', query }, { operation: 'paper-search', query: ' ' }, { operation: 'paper-read', query, paperId: 'web:https://example.com' }, { operation: 'paper-search', query, paperId: null, credits: 0 }]) {
				expect(validateToolInput(retrieveTool.inputSchema, input).error !== undefined || input.operation === 'paper-read').toBe(true);
				const invalid = await retrieveTool.execute!(input as never, ctx);
				if (input.operation === 'paper-read')
					expect(invalid).toMatchObject({ status: 'blocked', gaps: ['invalid_input'] });
				else
					expect(invalid).toHaveProperty('error');
			}
			expect(requests).toHaveLength(noCalls);
			for (const entry of telemetry) {
				expect(Object.keys(entry).sort()).toEqual(['capability', 'credits', 'durationMs', 'outcome', 'requestId', 'source']);
				expect(entry.durationMs).toBeGreaterThanOrEqual(0);
			}
			const safe = JSON.stringify(telemetry);
			expect(safe).not.toContain(query);
			expect(safe).not.toContain(secret);
			expect(safe).not.toContain('retrieved API contract');
			expect(telemetry.some(entry => entry.outcome === 'partial')).toBe(true);
			expect(telemetry.some(entry => entry.outcome === 'unknown_outcome' && entry.credits === 'unknown')).toBe(true);
			const state = ctx.requestContext!.getRaw('jamis.research-source-contracts') as { requests: Array<{ requestId: string }> };
			expect(state.requests.at(-1)!.requestId).toBe(requests.at(-1)!.id);
		}
		finally { server.stop(true); }
	}, 5000);
}
