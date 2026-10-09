import type { SpecialistHandback } from './specialist-handback';

import { z } from 'zod';

const text = z.string().trim().min(1);
export const researchResultSchema = z.object({
	findings: z.array(z.object({ text, sourceNumbers: z.array(z.number().int().min(1).max(3)).min(1).max(3) }).strict()).min(1).max(10),
	sources: z.array(z.object({
		title: text,
		url: z.string().url(),
		evidenceKind: z.enum(['scraped-webpage', 'abstract-only', 'full-text-passage', 'developer-passage']),
		evidence: text,
		limitations: z.array(text).max(10),
	}).strict()).min(1).max(3),
	limitations: z.array(text).max(10),
}).strict().refine(result => result.findings.every(finding => finding.sourceNumbers.every(number => number <= result.sources.length)), 'Finding references an absent source.');

export const insufficientResearchReason = 'Evidence status: insufficient. I could not verify the requested factual answer.';

const retrievedSchema = z.object({
	status: z.string(),
	adminActionUrl: z.string().url().nullable(),
	gaps: z.array(z.string()),
	evidence: z.array(z.object({
		title: text,
		url: z.string().url(),
		content: text,
		evidenceKind: z.enum(['abstract-only', 'full-text-passage', 'developer-passage']),
		license: z.string().nullable(),
		attribution: z.string().nullable(),
	})),
	candidates: z.array(z.object({ url: z.string().url(), title: text })),
});

export function validateResearchHandback(
	handback: SpecialistHandback<z.infer<typeof researchResultSchema>>,
	{ toolResults }: { toolResults: Array<{ payload: { toolName: string; result: unknown; args?: unknown; isError?: boolean } }> },
) {
	const payloads = toolResults.map(({ payload }) => payload);
	const retrieved = payloads.filter(payload => !payload.isError && ['researchSourceDiscover', 'researchSourceRetrieve'].includes(payload.toolName))
		.flatMap((payload) => {
			const parsed = retrievedSchema.safeParse(payload.result);
			return parsed.success ? [{ ...parsed.data, toolName: payload.toolName }] : [];
		});
	const terms = retrieved.find(result => result.status === 'terms_required');
	if (terms) {
		const reason = terms.adminActionUrl
			? `Evidence status: insufficient. Source access requires administrator review: ${terms.adminActionUrl}`
			: insufficientResearchReason;
		if (handback.case !== 'blocked' || handback.progress !== null || handback.reason !== reason)
			throw new Error('Research access metadata does not match the source result.');
		return;
	}
	if (handback.case === 'blocked') {
		if (handback.reason !== insufficientResearchReason || handback.progress !== null)
			throw new Error('Insufficient Research cannot contain factual findings or invented access metadata.');
		return;
	}
	if (handback.case === 'needs_help') {
		if (handback.need.kind !== 'input' || handback.progress !== null)
			throw new Error('Research can request only missing assignment input.');
		return;
	}
	const scrapes = payloads.filter(payload => payload.toolName === 'webScrape' && !payload.isError).flatMap((payload) => {
		const parsed = z.object({ args: z.object({ url: z.string().url() }), result: z.object({ markdown: text }) }).safeParse(payload);
		return parsed.success ? [parsed.data] : [];
	});
	const candidates = retrieved.flatMap(result => result.candidates);
	for (const payload of payloads.filter(payload => payload.toolName === 'webSearch' && !payload.isError)) {
		const parsed = z.object({ results: z.array(z.object({ title: z.string().nullable(), url: z.string().url() })) }).safeParse(payload.result);
		if (parsed.success)
			candidates.push(...parsed.data.results.map(candidate => ({ ...candidate, title: candidate.title || candidate.url })));
	}
	const evidence = retrieved.filter(result => result.toolName === 'researchSourceRetrieve' && ['success', 'partial'].includes(result.status)).flatMap(result => result.evidence);
	for (const source of handback.result.sources) {
		if (source.evidenceKind === 'scraped-webpage') {
			const titles = candidates.filter(candidate => candidate.url === source.url).map(candidate => candidate.title);
			if (!scrapes.some(scrape => scrape.args.url === source.url && scrape.result.markdown.includes(source.evidence))
				|| !(titles.length ? titles : [source.url]).includes(source.title)) {
				throw new Error('Research source was not read at its cited URL.');
			}
			continue;
		}
		const read = evidence.find(read => read.url === source.url && read.title === source.title && read.evidenceKind === source.evidenceKind && read.content.includes(source.evidence));
		if (!read)
			throw new Error('Research source does not match retrieved evidence.');
		if (source.evidenceKind === 'abstract-only' && !source.limitations.some(limit => limit.includes('abstract-only')))
			throw new Error('Research must preserve abstract-only limitations.');
		for (const metadata of [read.license, read.attribution]) {
			if (metadata && !source.limitations.some(limit => limit.includes(metadata)))
				throw new Error('Research must preserve source license and attribution.');
		}
	}
	const gaps = retrieved.flatMap(result => result.gaps.filter(gap => gap !== 'webpage_requires_scrape'
		|| result.candidates.some(candidate => !scrapes.some(scrape => scrape.args.url === candidate.url))));
	if (gaps.some(gap => !handback.result.limitations.some(limit => limit.includes(gap)))
		|| (gaps.length > 0 && handback.case !== 'partial')) {
		throw new Error('Research must retain incomplete source coverage.');
	}
}
