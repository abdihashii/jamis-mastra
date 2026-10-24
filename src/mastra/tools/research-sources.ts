import type { RequestContext } from '@mastra/core/request-context';
import type { ToolExecutionContext } from '@mastra/core/tools';

import { createTool } from '@mastra/core/tools';
import { Firecrawl } from 'firecrawl';
import { z } from 'zod';

import { requireEnv } from '../env';

const firecrawl = new Firecrawl({ apiKey: requireEnv('FIRECRAWL_API_KEY') });
const text = z.string().trim().min(1);
const creditsSchema = z.number().int().nonnegative();
const operationSchema = z.enum(['paper-search', 'paper-read', 'developer-search']);
type Operation = z.infer<typeof operationSchema>;
const routes = {
	'paper-search': { provider: 'firecrawl-research-index', capability: 'search', k: 10, key: 'results' },
	'paper-read': { provider: 'firecrawl-research-index', capability: 'read', k: 3, key: 'passages' },
	'developer-search': { provider: 'firecrawl-developer-index', capability: 'search', k: 3, key: 'results' },
} as const;
const contractSchema = z.object({
	provider: text,
	capability: text,
	creditsCost: creditsSchema,
	perRecord: z.boolean(),
	recordsPerUnit: z.number().int().positive().optional(),
	options: z.array(z.object({
		name: text,
		type: text,
		required: z.boolean().optional(),
		min: z.number().optional(),
		max: z.number().optional(),
	})),
	response: z.object({ key: text, fields: z.array(z.object({ name: text, type: text })) }),
});
type Contract = z.infer<typeof contractSchema>;
const stateKey = 'jamis.research-source-contracts';
interface TaskState {
	owner: RequestContext;
	contracts: Partial<Record<Operation, Contract>>;
	requests: Array<{ requestId: string; operation: Operation | 'discovery' }>;
	toJSON: () => undefined;
}
function taskState(context?: ToolExecutionContext) {
	const owner = context?.requestContext;
	const state = owner?.getRaw(stateKey) as TaskState | undefined;
	return state?.owner === owner ? state : undefined;
}
function retain(context: ToolExecutionContext | undefined, contracts: TaskState['contracts'], requestId: string, operation: Operation | 'discovery') {
	const owner = context?.requestContext;
	if (!owner)
		return;
	// Mastra shallow-copies delegation entries. Never mutate or reuse inherited state.
	owner.setRaw(stateKey, {
		owner,
		contracts,
		requests: [...(taskState(context)?.requests ?? []), { requestId, operation }],
		// Contracts and task-local identities are runtime-only, not exported context.
		toJSON: () => undefined,
	} satisfies TaskState);
}

const httpUrl = text.refine((value) => {
	try {
		const url = new URL(value);
		return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
	} catch { return false; }
});
const sourceSchema = z.object({
	originalId: text,
	url: httpUrl,
	title: text,
	content: text,
	evidenceKind: z.enum(['abstract-only', 'full-text-passage', 'developer-passage']),
	retrievedAtUtc: z.string().datetime(),
	paperId: text.nullable(),
	createdAtUtc: z.string().datetime().nullable(),
	updatedAtUtc: z.string().datetime().nullable(),
	license: text.nullable(),
	licenseState: z.enum(['licensed', 'known_absent', 'unknown']).nullable(),
	attribution: text.nullable(),
});
const outputSchema = z.object({
	status: z.enum(['success', 'partial', 'empty', 'blocked', 'terms_required', 'access_denied', 'upstream_error', 'unknown_outcome', 'invalid_response']),
	requestId: text.nullable(),
	credits: creditsSchema.nullable(),
	adminActionUrl: httpUrl.nullable(),
	operations: z.array(z.object({ operation: operationSchema, maximumCredits: creditsSchema })).max(3),
	evidence: z.array(sourceSchema).max(10),
	candidates: z
		.array(z.object({ originalId: text, url: httpUrl, title: text, requiresScrape: z.literal(true) }))
		.max(10),
	gaps: z.array(z.enum(['contract_unavailable', 'pricing_or_contract_unsupported', 'empty_results', 'malformed_record', 'unsupported_provenance', 'missing_content', 'partial_results', 'webpage_requires_scrape', 'record_failure', 'context_required', 'invalid_input'])),
});
type Output = z.infer<typeof outputSchema>;
function emptyOutput(): Output {
	return { status: 'blocked', requestId: null, credits: null, adminActionUrl: null, operations: [], evidence: [], candidates: [], gaps: [] };
}

function maximumCredits(operation: Operation, contract: Contract) {
	const route = routes[operation];
	const expected: Record<string, { type: string; value?: number }> = {
		query: { type: 'string' },
		k: { type: 'number', value: route.k },
		...(operation === 'paper-read' ? { paperId: { type: 'string' } } : {}),
		...(operation === 'developer-search' ? { passages: { type: 'number', value: 3 } } : {}),
	};
	for (const [name, { type, value }] of Object.entries(expected)) {
		const options = contract.options.filter(option => option.name === name);
		if (options.length !== 1 || options[0]!.type !== type)
			return null;
		const option = options[0]!;
		if (
			value !== undefined && (
				option.min === undefined || option.max === undefined || value < option.min || value > option.max)
		) {
			return null;
		}
	}
	if (
		contract.options.some(
			option => option.required && !Object.hasOwn(expected, option.name),
		) || contract.response.key !== route.key
	) {
		return null;
	}
	const contentField = operation === 'paper-search' ? 'abstract' : operation === 'paper-read' ? 'text' : 'passages';
	if (!contract.response.fields.some(field => field.name === contentField && field.type === (operation === 'developer-search' ? 'object[]' : 'string')))
		return null;
	// ponytail: overestimates unit billing; use verified unit rounding if it blocks needed searches.
	const maximum = contract.creditsCost * (contract.perRecord ? route.k : 1);
	return Number.isSafeInteger(maximum) && maximum <= (operation === 'developer-search' ? 6 : 0) ? maximum : null;
}

function adminUrl(value: unknown) {
	const parsed = httpUrl.safeParse(value);
	if (!parsed.success)
		return null;
	const url = new URL(parsed.data);
	return url.origin === 'https://www.firecrawl.dev' && ((url.pathname === '/app/settings' && url.search === '?tab=data-sources') || (/^\/app\/alexandria\/firecrawl-(?:developer|research)-index$/.test(url.pathname) && !url.search)) && !url.hash ? url.href : null;
}
function failure(error: unknown, output: Output) {
	const parsed = z
		.object({
			code: z.string().optional(),
			status: z.number().optional(),
			requiresAction: z.object({ url: z.unknown() }).optional(),
		})
		.safeParse(error);
	if (parsed.success && parsed.data.code === 'THIRD_PARTY_DATA_TERMS_REQUIRED') {
		output.status = 'terms_required';
		output.adminActionUrl = adminUrl(parsed.data.requiresAction?.url);
	} else if (parsed.success && [401, 403].includes(parsed.data.status ?? 0)) {
		output.status = 'access_denied';
	} else {
		output.status = parsed.success && parsed.data.status && parsed.data.status !== 408 ? 'upstream_error' : 'unknown_outcome';
	}
}

async function executeCall(operation: Operation | 'discovery', options: Record<string, unknown>, context: ToolExecutionContext | undefined, output: Output) {
	const route = operation === 'discovery' ? { provider: 'firecrawl', capability: 'find-tools' } : routes[operation];
	output.requestId = crypto.randomUUID();
	retain(context, taskState(context)?.contracts ?? {}, output.requestId, operation);
	try {
		const response = await firecrawl.scrape({
			alexandria: { provider: route.provider, capability: route.capability, options },
			requestId: output.requestId,
		});
		output.credits = response.creditsCost;
		const item = z.object({
			provider: z.literal(route.provider).optional(),
			capability: z.literal(route.capability).optional(),
			creditsCost: creditsSchema.optional(),
			upstreamStatus: z.number().int().min(100).max(599).optional(),
			data: z.unknown().optional(),
			error: z.unknown().optional(),
		}).parse(z.array(z.unknown()).length(1).parse(response.alexandria)[0]);
		if (item.error !== undefined) {
			failure(item.error, output);
			return;
		}
		z.object({ provider: z.literal(route.provider), capability: z.literal(route.capability) }).parse(item);
		if (item.upstreamStatus !== undefined && (item.upstreamStatus < 200 || item.upstreamStatus >= 300)) {
			failure({ status: item.upstreamStatus }, output);
			return;
		}
		creditsSchema.parse(item.creditsCost);
		const contract = operation === 'discovery' ? undefined : taskState(context)?.contracts[operation];
		const maximum = operation === 'discovery' ? 0 : contract ? maximumCredits(operation, contract) : null;
		if (item.creditsCost !== response.creditsCost || maximum === null || response.creditsCost > maximum) {
			output.status = 'invalid_response';
			return;
		}
		if (item.data === undefined) {
			output.status = 'invalid_response';
			return;
		}
		return item.data;
	} catch (error) {
		if (error instanceof z.ZodError)
			output.status = 'invalid_response';
		else
			failure(error, output);
	}
}

async function runOperation(operation: Operation | 'discovery', context: ToolExecutionContext | undefined, run: (output: Output) => Promise<Output>) {
	const output = emptyOutput();
	const started = performance.now();
	try {
		return await run(output);
	} finally {
		context?.tracing?.currentSpan?.update({ metadata: { researchOperation: {
			source: operation === 'discovery' ? 'catalogue' : operation.startsWith('paper-') ? 'papers' : 'developer',
			capability: operation === 'discovery' ? 'find-tools' : routes[operation].capability,
			durationMs: Math.round(performance.now() - started),
			outcome: output.status,
			requestId: output.requestId,
			credits: output.credits ?? 'unknown',
		} } });
		if (['upstream_error', 'access_denied', 'unknown_outcome', 'invalid_response'].includes(output.status))
			context?.tracing?.currentSpan?.error({ error: new Error('Research source operation failed.'), endSpan: false });
	}
}

const provenanceSchema = z.object({ primaryId: text.optional(), ids: z.record(z.string(), z.array(text)).optional() });
function paperProvenance(record: z.infer<typeof provenanceSchema>) {
	const identifiers = [record.primaryId, ...Object.entries(record.ids ?? {}).flatMap(([namespace, ids]) => ids.map(id => `${namespace}:${id}`))];
	for (const id of identifiers) {
		if (!id)
			continue;
		const match = /^(arxiv|pmid|pmcid|doi):(.+)$/i.exec(id);
		if (!match)
			continue;
		const [, namespace, value] = match;
		if (namespace!.toLowerCase() === 'arxiv' && /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.test(value!))
			return { originalId: `arxiv:${value}`, url: `https://arxiv.org/abs/${value}` };
		if (namespace!.toLowerCase() === 'pmid' && /^[1-9]\d*$/.test(value!))
			return { originalId: `pmid:${value}`, url: `https://pubmed.ncbi.nlm.nih.gov/${value}/` };
		if (namespace!.toLowerCase() === 'pmcid' && /^PMC[1-9]\d*$/i.test(value!))
			return { originalId: `pmcid:${value!.toUpperCase()}`, url: `https://pmc.ncbi.nlm.nih.gov/articles/${value!.toUpperCase()}/` };
		if (namespace!.toLowerCase() === 'doi' && /^10\.\d{4,9}\/\S+$/.test(value!) && !/[?#]/.test(value!) && !value!.split('/').some(part => part === '.' || part === '..'))
			return { originalId: `doi:${value}`, url: `https://doi.org/${value!.split('/').map(encodeURIComponent).join('/')}` };
	}
	return null;
}
function developerProvenance(id?: string, url?: string) {
	if (!id || !url || new URL(url).href !== url)
		return null;
	if (id.startsWith('doc:') && id.slice(4) === url)
		return { originalId: id, url };
	const github = /^(issue|pull_request):([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(id);
	if (github && url === `https://github.com/${github[2]}/${github[1] === 'issue' ? 'issues' : 'pull'}/${github[3]}`)
		return { originalId: id, url };
	const readme = /^readme:([\w.-]+\/[\w.-]+)$/.exec(id);
	if (readme && (url === `https://github.com/${readme[1]}` || url.startsWith(`https://github.com/${readme[1]}/blob/`)))
		return { originalId: id, url };
	return null;
}

const passageSchema = z.object({
	text,
	citation_url: httpUrl.optional(),
	success: z.literal(true).optional(),
	error: z.never().optional(),
});

const recordSchema = provenanceSchema.extend({
	title: text.nullish(),
	paperId: text.optional(),
	id: text.optional(),
	url: httpUrl.optional(),
	abstract: z.string().optional(),
	passages: z.array(passageSchema).max(3).optional(),
	createdDate: text.optional(),
	updateDate: text.optional(),
	license: z.union([text, z.object({ state: z.enum(['licensed', 'known_absent', 'unknown']), spdx_id: text.optional() })]).optional(),
	attribution: text.optional(),
	success: z.boolean().optional(),
	error: z.unknown().optional(),
});
function date(value?: string) {
	// Only unambiguous source dates, never host-local dates or invented freshness.
	if (!value || !/^(?:\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?|[A-Za-z]{3}, .* GMT)$/.test(value))
		return null;
	const ms = Date.parse(value);
	if (!Number.isFinite(ms))
		return null;
	const iso = new Date(ms).toISOString();
	const calendarDate = /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0];
	if (calendarDate)
		return new Date(calendarDate).toISOString().slice(0, 10) === calendarDate ? iso : null;
	return new Date(ms).toUTCString().toLowerCase() === value.replace(/, (\d) /, ', 0$1 ').toLowerCase() ? iso : null;
}
function normalize(operation: Operation, data: unknown, output: Output, requestedPaperId?: string) {
	const innerFailure = z.object({ success: z.literal(false) }).safeParse(data);
	if (innerFailure.success) {
		failure(data, output);
		return;
	}
	const envelope = z.object({
		success: z.literal(true),
		partial: z.boolean().optional(),
		results: z.array(z.unknown()).optional(),
		paper: z.unknown().optional(),
		paperId: text.optional(),
		passages: z.array(passageSchema).max(3).optional(),
	}).parse(data);
	const records = operation === 'paper-read' ? [envelope.paper] : z.array(z.unknown()).max(routes[operation].k).parse(envelope.results);
	if (envelope.partial)
		output.gaps.push('partial_results');
	for (const raw of records) {
		const parsed = recordSchema.safeParse(raw);
		if (!parsed.success) {
			output.gaps.push('malformed_record');
			continue;
		}
		const record = parsed.data;
		const title = record.title ?? (operation === 'developer-search' ? record.url : undefined);
		if (!title) {
			output.gaps.push('malformed_record');
			continue;
		}
		if (record.success === false || record.error !== undefined) {
			output.gaps.push('record_failure');
			continue;
		}
		const id = operation === 'developer-search' ? record.id : record.paperId;
		if (id?.startsWith('web:')) {
			const url = httpUrl.safeParse(id.slice(4));
			if (!url.success || (record.url && record.url !== url.data)) {
				output.gaps.push('unsupported_provenance');
				continue;
			}
			output.candidates.push({ originalId: id, url: url.data, title, requiresScrape: true });
			output.gaps.push('webpage_requires_scrape');
			continue;
		}
		const provenance = operation === 'developer-search'
			? developerProvenance(id, record.url)
			: paperProvenance(record);
		if (!provenance || (operation !== 'developer-search' && !/^\d+$/.test(record.paperId ?? '')) || (operation === 'paper-read' && (record.paperId !== requestedPaperId || envelope.paperId !== requestedPaperId))) {
			output.gaps.push('unsupported_provenance');
			continue;
		}
		const content = operation === 'paper-search' ? record.abstract?.trim() : (operation === 'paper-read' ? envelope.passages : record.passages)?.map(passage => passage.text).join('\n\n');
		if (!content) {
			output.gaps.push('missing_content');
			continue;
		}
		output.evidence.push(sourceSchema.parse({
			...provenance,
			title,
			content,
			evidenceKind: operation === 'paper-search' ? 'abstract-only' : operation === 'paper-read' ? 'full-text-passage' : 'developer-passage',
			retrievedAtUtc: new Date().toISOString(),
			paperId: operation === 'developer-search' ? null : record.paperId,
			createdAtUtc: date(record.createdDate),
			updatedAtUtc: date(record.updateDate),
			license: typeof record.license === 'string' ? record.license : record.license?.spdx_id ?? null,
			licenseState: typeof record.license === 'string' ? 'licensed' : record.license?.state ?? null,
			attribution: record.attribution ?? ((operation === 'paper-read' ? envelope.passages : record.passages)?.map(passage => passage.citation_url).filter(Boolean).join('\n') || null),
		}));
	}
	output.gaps = [...new Set(output.gaps)];
	output.status = output.gaps.length ? 'partial' : output.evidence.length ? 'success' : 'empty';
	if (!output.evidence.length && !output.candidates.length)
		output.gaps.push('empty_results');
}

const discoveryInput = z.object({ domain: z.enum(['papers', 'developer']) }).strict();
export const researchSourceDiscover = createTool({
	id: 'research-source-discover',
	description: 'Inspect supported paper or developer source operations and verified maximum costs for this task. Discovery is not evidence.',
	inputSchema: discoveryInput,
	outputSchema,
	execute: async (input, context) => runOperation('discovery', context, async (output) => {
		const parsed = discoveryInput.safeParse(input);
		if (!parsed.success || !context?.requestContext) {
			output.gaps.push(parsed.success ? 'context_required' : 'invalid_input');
			return output;
		}
		const operations: Operation[] = parsed.data.domain === 'papers' ? ['paper-search', 'paper-read'] : ['developer-search'];
		// Clear any old contracts before inspection, including failed or empty discovery.
		const previous = taskState(context);
		context.requestContext.setRaw(stateKey, previous ? { ...previous, contracts: {} } : undefined);
		const data = await executeCall('discovery', {
			providers: [routes[operations[0]!].provider],
			capabilities: operations.map(operation => routes[operation].capability),
			level: 'tools',
			expand: ['options', 'response'],
			limit: 3,
			offset: 0,
		}, context, output);
		if (data === undefined)
			return output;
		try {
			const catalogue = z.object({ level: z.literal('tools'), items: z.array(z.unknown()).max(3) }).parse(data);
			const contracts: TaskState['contracts'] = {};
			for (const operation of operations) {
				const route = routes[operation];
				const matching = catalogue
					.items
					.filter(item => z.object({
						provider: z.literal(route.provider),
						capability: z.literal(route.capability),
					}).safeParse(item).success);
				const contract = matching.length === 1 ? contractSchema.safeParse(matching[0]) : null;
				const maximum = contract?.success ? maximumCredits(operation, contract.data) : null;
				if (maximum === null || !contract?.success) {
					output.gaps.push(matching.length ? 'pricing_or_contract_unsupported' : 'contract_unavailable');
					continue;
				}
				contracts[operation] = contract.data;
				output.operations.push({ operation, maximumCredits: maximum });
			}
			const state = taskState(context)!;
			context.requestContext.setRaw(stateKey, { ...state, contracts });
			output.gaps = [...new Set(output.gaps)];
			output.status = output.operations.length ? output.gaps.length ? 'partial' : 'success' : 'blocked';
		} catch { output.status = 'invalid_response'; }
		return output;
	}),
});

const retrievalInput = z.object({
	operation: operationSchema,
	query: text.max(2000),
	paperId: text.max(128).nullable().default(null),
}).strict();
export const researchSourceRetrieve = createTool({
	id: 'research-source-retrieve',
	description: 'Retrieve up to ten paper abstracts, three relevant paper passages, or three developer records with three passages each. Requires task-local source discovery. Webpage candidates still require scraping.',
	inputSchema: retrievalInput,
	outputSchema,
	execute: async (input, context) => runOperation(operationSchema.safeParse(input.operation).data ?? 'paper-search', context, async (output) => {
		const parsed = retrievalInput.safeParse(input);
		if (!parsed.success || (parsed.data.operation === 'paper-read' ? !/^\d+$/.test(parsed.data.paperId ?? '') : parsed.data.paperId !== null)) {
			output.gaps.push('invalid_input');
			return output;
		}
		const { operation, query, paperId } = parsed.data;
		const contract = taskState(context)?.contracts[operation];
		if (!contract || maximumCredits(operation, contract) === null) {
			output.gaps.push('contract_unavailable');
			return output;
		}
		const data = await executeCall(operation, {
			query,
			k: routes[operation].k,
			...(operation === 'paper-read' ? { paperId } : {}),
			...(operation === 'developer-search' ? { passages: 3 } : {}),
		}, context, output);
		if (data !== undefined) {
			try {
				normalize(operation, data, output, paperId ?? undefined);
			} catch { output.status = 'invalid_response'; }
		}
		return output;
	}),
});
