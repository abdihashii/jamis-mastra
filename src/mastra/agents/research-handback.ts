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
