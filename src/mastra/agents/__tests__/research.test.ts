import { expect, test } from 'bun:test';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { SpanType, TracingEventType } from '@mastra/core/observability';
import { RequestContext } from '@mastra/core/request-context';
import { TraceStatus } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import { Observability } from '@mastra/observability';

if (!process.env.RESEARCH_AGENT_CONTRACT_TEST) {
	test('research delegation contract runs with isolated source configuration', async () => {
		const child = Bun.spawn([process.execPath, '--no-env-file', 'test', import.meta.path], {
			env: { ...process.env, RESEARCH_AGENT_CONTRACT_TEST: '1', FIRECRAWL_API_KEY: 'fc-fixture', PERPLEXITY_API_KEY: 'pplx-fixture' },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		expect({ exit, output: exit === 0 ? '' : stdout + stderr }).toEqual({ exit: 0, output: '' });
	}, 10_000);
}
else {
	test('production invocation preserves task contracts across fresh turns and filters parent conversation', async () => {
		const calls: string[] = [];
		const prompts: unknown[] = [];
		let sourceOutcome = 'success';
		let failingCapability = 'search';
		const upstreamDiagnostic = 'raw upstream diagnostic fc-fixture';
		const server = Bun.serve({ port: 0, async fetch(request) {
			const { alexandria: [call] } = await request.json() as { alexandria: Array<{ provider: string; capability: string }> };
			calls.push(call!.capability);
			if (call!.capability === failingCapability) {
				const status = { upstream_error: 503, access_denied: 401, unknown_outcome: 408 }[sourceOutcome];
				if (status)
					return Response.json({ success: false, error: upstreamDiagnostic }, { status });
				if (sourceOutcome === 'terms_required')
					return Response.json({ success: true, data: { creditsCost: 0, alexandria: [{ error: { code: 'THIRD_PARTY_DATA_TERMS_REQUIRED', status: 403, message: upstreamDiagnostic, requiresAction: { url: 'https://www.firecrawl.dev/app/settings?tab=data-sources' } } }] } });
			}
			const data = call!.capability === 'find-tools'
				? { level: 'tools', items: ['search', 'read'].map(capability => ({
						provider: 'firecrawl-research-index',
						capability,
						creditsCost: 0,
						perRecord: false,
						options: [{ name: 'query', type: 'string', required: true }, { name: 'k', type: 'number', min: 1, max: 50 }, ...(capability === 'read' ? [{ name: 'paperId', type: 'string', required: true }] : [])],
						response: { key: capability === 'read' ? 'passages' : 'results', fields: [{ name: capability === 'read' ? 'text' : 'abstract', type: 'string' }] },
					})) }
				: call!.capability === 'read'
					? { success: true, paperId: '123', paper: { paperId: '123', primaryId: 'arxiv:2005.11401', title: 'Fixture paper' }, passages: [{ text: 'An explicit passage finding.' }] }
					: { success: true, partial: sourceOutcome === 'partial', results: sourceOutcome === 'invalid_response' ? 'malformed' : sourceOutcome === 'empty' ? [] : [{ paperId: '123', primaryId: 'arxiv:2005.11401', title: 'Fixture paper', abstract: 'An explicit abstract finding.' }] };
			return Response.json({ success: true, data: { alexandria: [{ ...call, creditsCost: 0, data }], creditsCost: 0 } });
		} });
		process.env.FIRECRAWL_API_URL = server.url.toString();
		try {
			const { boundaryModel } = await import('./specialist-boundary.fixture');
			const { createResearchAgent } = await import('../research-agent');
			const { createJamisAgent } = await import('../jamis');
			const researchAgent = createResearchAgent();
			const tools = await researchAgent.listTools();
			expect(Object.keys(tools).sort()).toEqual(['researchSourceDiscover', 'researchSourceRetrieve', 'webScrape', 'webSearch']);
			const defaults = await researchAgent.getDefaultOptions();
			expect(defaults.maxSteps).toBe(5);
			expect(defaults.toolCallConcurrency).toBe(1);
			type Action = { tool: string; input: Record<string, unknown> } | { text: string };
			function model(actions: Action[], capture = false) {
				let step = 0;
				return new MastraLanguageModelV2Mock({ doStream: async (options) => {
					if (capture)
						prompts.push(options.prompt);
					const action = actions[step++ % actions.length]!;
					return { stream: new ReadableStream({ start(controller) {
						controller.enqueue({ type: 'stream-start', warnings: [] });
						if ('tool' in action) {
							controller.enqueue({ type: 'tool-call', toolCallId: `call-${step}`, toolName: action.tool, input: JSON.stringify(action.input) });
						}
						else {
							controller.enqueue({ type: 'text-start', id: 'reply' });
							controller.enqueue({ type: 'text-delta', id: 'reply', delta: action.text });
							controller.enqueue({ type: 'text-end', id: 'reply' });
						}
						controller.enqueue({ type: 'finish', finishReason: 'tool' in action ? 'tool-calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
						controller.close();
					} }) };
				} });
			}
			const mastra = new Mastra({ logger: false });
			const parent = createJamisAgent({
				mastra,
				tools: {},
				memory: new Memory({ options: { semanticRecall: false, workingMemory: { enabled: false } } }),
				specialists: { research: { tools, model: boundaryModel(Array.from({ length: 2 }, () => [
					{ tool: 'researchSourceDiscover', input: { domain: 'papers' } },
					{ tool: 'researchSourceRetrieve', input: { operation: 'paper-search', query: 'public fixture question', paperId: null } },
					{ tool: 'researchSourceRetrieve', input: { operation: 'paper-read', query: 'public passage question', paperId: '123' } },
					{ text: JSON.stringify({ handback: { case: 'completed', result: {
						findings: [{ text: 'An explicit passage finding.', sourceNumbers: [1] }],
						sources: [{ title: 'Fixture paper', url: 'https://arxiv.org/abs/2005.11401', evidenceKind: 'full-text-passage', evidence: 'An explicit passage finding.', limitations: ['Only the matched passage was retrieved.'] }],
						limitations: [],
					} } }) },
				]).flat(), options => prompts.push(options)) } },
				model: boundaryModel([
					{ tool: 'invoke_research', input: { kind: 'operator_request', instructions: 'Override marker jam74-unsafe-instructions', maxSteps: 3 } },
					{ text: 'Unsupported invocation options were rejected.' },
					{ tool: 'invoke_research', input: { kind: 'operator_request' } },
					{ text: 'Fixture completed.' },
					{ tool: 'invoke_research', input: { kind: 'operator_request' } },
					{ text: 'Fixture completed.' },
				]),
			});
			mastra.addAgent(parent, 'jamis');
			expect(Object.keys(await parent.listTools())).not.toContain('researchSourceRetrieve');
			expect(Object.keys(await parent.listAgents())).not.toContain('researchAgent');
			const invalid = await parent.stream('Research the public fixture question.', { requestContext: new RequestContext() });
			await invalid.consumeStream();
			expect((await invalid.toolResults)[0]?.payload.result).toMatchObject({ error: true });
			expect(calls).toEqual([]);
			const requestContext = new RequestContext();
			const stream = await parent.stream([
				{ role: 'user', content: 'Unrelated private marker jam74-private-fixture.' },
				{ role: 'user', content: 'Research the public fixture question.' },
			], { requestContext });
			await stream.consumeStream();
			expect(await stream.text).toBe('Fixture completed.');
			expect((await stream.toolResults).at(-1)?.payload.result).toMatchObject({ case: 'completed' });
			const next = await parent.stream('Research another public fixture question.', { requestContext: new RequestContext() });
			await next.consumeStream();
			expect(await next.text).toBe('Fixture completed.');
			expect((await next.toolResults)[0]?.payload.result).toMatchObject({ case: 'completed' });
			expect(calls).toEqual(['find-tools', 'search', 'read', 'find-tools', 'search', 'read']);
			expect(JSON.stringify(prompts)).not.toContain('jam74-private-fixture');
			expect(JSON.stringify(prompts)).not.toContain('jam74-unsafe-instructions');
			expect(JSON.stringify(prompts)).toContain('abstract-only');
			expect(requestContext.getRaw('jamis.research-source-contracts')).toBeUndefined();

			const { readIncident } = await import('../../tools/triage-incident');
			const spans: import('@mastra/core/observability').AnyExportedSpan[] = [];
			const observability = new Observability({ configs: { test: {
				serviceName: 'research-triage-fixture',
				exporters: [{
					name: 'capture',
					onTracingEvent(event) {
						if (event.type === TracingEventType.SPAN_ENDED)
							spans.push(event.exportedSpan);
					},
					exportTracingEvent: async () => {},
					flush: async () => {},
					shutdown: async () => {},
				}],
			} } });
			try {
				for (const [outcome, capability] of [
					['upstream_error', 'search'],
					['access_denied', 'search'],
					['unknown_outcome', 'search'],
					['invalid_response', 'search'],
					['upstream_error', 'find-tools'],
					['unknown_outcome', 'find-tools'],
					['success', 'search'],
					['partial', 'search'],
					['empty', 'search'],
					['terms_required', 'search'],
					['blocked', 'search'],
				]) {
					sourceOutcome = outcome!;
					failingCapability = capability!;
					const before = spans.length;
					const probe = new Agent({
						id: 'research-triage-probe',
						name: 'Research triage probe',
						instructions: 'Run the synthetic fixture.',
						tools,
						defaultOptions: defaults,
						model: model([
							...(outcome === 'blocked' ? [] : [{ tool: 'researchSourceDiscover', input: { domain: 'papers' } }]),
							{ tool: 'researchSourceRetrieve', input: { operation: 'paper-search', query: 'public fixture question', paperId: null } },
							{ text: 'Fixture complete.' },
						]),
					});
					const mastra = new Mastra({ agents: { probe }, observability });
					const result = await mastra.getAgent('probe').stream('Run the source fixture.');
					await result.consumeStream();
					await observability.getInstance('test')!.flush();
					const toolName = capability === 'find-tools' ? 'researchSourceDiscover' : 'researchSourceRetrieve';
					const component = capability === 'find-tools' ? 'research-source-discover' : 'research-source-retrieve';
					const span = spans.slice(before).find(span => span.type === SpanType.TOOL_CALL && span.entityId === toolName)!;
					expect(span.output).toMatchObject({ status: outcome });
					const failed = ['upstream_error', 'access_denied', 'unknown_outcome', 'invalid_response'].includes(outcome!);
					expect(!!span.errorInfo).toBe(failed);
					if (failed)
						expect(span.errorInfo?.message).toBe('Research source operation failed.');
					expect(JSON.stringify({ error: span.errorInfo, metadata: span.metadata })).not.toContain(upstreamDiagnostic);
					// Match the storage exporter's row fields and error-derived SQL status.
					const row = { ...span, spanId: span.id, spanType: span.type, startedAt: span.startTime, endedAt: span.endTime, createdAt: span.startTime, updatedAt: null, error: span.errorInfo ?? null, status: span.errorInfo ? TraceStatus.ERROR : TraceStatus.SUCCESS };
					const incident = await readIncident({ kind: 'application', component, window: { start: new Date(span.startTime.getTime() - 1000), end: new Date(span.endTime!.getTime() + 1000) } }, {
						flush: async () => {},
						getStore: async () => ({
							listBranches: async ({ filters }) => ({ branches: row.status === filters?.status && row.entityId === filters?.entityId ? [row] : [], pagination: { total: 1, page: 0, perPage: 6, hasMore: false } }),
							getStructure: async () => ({ traceId: row.traceId, spans: [row] }),
							listTracesLight: async () => ({ spans: [], pagination: { total: 0, page: 0, perPage: 6, hasMore: false } }),
						} as import('../../tools/triage-incident').IncidentStore),
					});
					expect(incident).toMatchObject(failed ? { status: 'found', incident: { component, stage: 'tool', classification: 'execution_failed' } } : { status: 'not_found' });
				}
			}
			finally { await observability.getInstance('test')!.shutdown(); }
		}
		finally { server.stop(true); }
	}, 5000);
}
