import { z } from 'zod';

import { researchResultSchema } from './research-handback';

const text = z.string().min(1);
export const personalAccountsResultSchema = z.object({
	summary: text,
	messages: z.array(z.object({ subject: z.string(), from: text, date: z.string().datetime(), snippet: z.string(), body: z.string().max(12_000).nullable(), truncated: z.boolean() }).strict()).max(20),
	events: z.array(z.object({ calendar: text, title: text, start: text, end: text, operatorLocalStart: text.nullable(), operatorLocalEnd: text.nullable(), location: z.string().nullable() }).strict()).max(50),
	issues: z.array(z.object({ identifier: text, url: z.string().url(), status: text }).strict()).max(50),
	coverage: z.array(z.object({ source: z.enum(['gmail', 'calendar', 'linear']), status: z.enum(['complete', 'empty', 'ambiguous', 'truncated', 'unavailable', 'denied']), gaps: z.array(text).max(10) }).strict()).max(3),
	research: researchResultSchema.nullable(),
	replyText: text.nullable(),
}).strict();
