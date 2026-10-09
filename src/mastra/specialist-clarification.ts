import type { MemoryStorage } from '@mastra/core/storage';

import { z } from 'zod';

import { researchResultSchema } from './agents/research-handback';
import { specialistHandbackSchema } from './agents/specialist-handback';

export const specialistClarificationKey = 'jamis_specialist_clarification';

export const specialistClarificationSchema = z.object({
	owner: z.enum(['invoke_weather', 'invoke_research', 'invoke_personal_accounts']),
	need: z.object({ kind: z.literal('input'), question: z.string().min(1).max(4000), missing: z.array(z.string().min(1).max(4000)).min(1).max(5) }).strict(),
	publicAssignment: z.string().min(1).max(16_000).nullable(),
	originalAccountsRequest: z.string().min(1).max(4000).optional(),
	researchResults: z.array(z.object({ assignment: z.string().min(1).max(16_000), handback: specialistHandbackSchema(researchResultSchema) }).strict()).max(5),
}).strict().refine(state => (state.owner === 'invoke_research') === (state.publicAssignment !== null)
	&& (state.originalAccountsRequest === undefined || state.owner === 'invoke_personal_accounts')
	&& JSON.stringify(state).length <= 128_000, 'Specialist clarification is outside its bounded contract.');

export type SpecialistClarification = z.infer<typeof specialistClarificationSchema>;

const storedClarificationSchema = z.object({
	sourceMessageId: z.string().min(1),
	clarification: specialistClarificationSchema,
}).strict();

/** One next-turn slot in the existing session, not a task queue or an authority record. */
export async function takeSpecialistClarification(memory: MemoryStorage, threadId: string) {
	let pending: z.infer<typeof storedClarificationSchema> | undefined;
	await memory.updateThreadMetadata({ id: threadId, update: (thread) => {
		if (thread.metadata?.[specialistClarificationKey] == null)
			return undefined;
		const metadata = { ...thread.metadata };
		const parsed = storedClarificationSchema.safeParse(metadata[specialistClarificationKey]);
		pending = parsed.success ? parsed.data : undefined;
		// Postgres shallow-merges metadata, so omission would leave the old slot intact.
		metadata[specialistClarificationKey] = null;
		return metadata;
	} });
	return pending;
}

export async function saveSpecialistClarification(memory: MemoryStorage, threadId: string, sourceMessageId: string, clarification: SpecialistClarification) {
	const stored = storedClarificationSchema.parse({ sourceMessageId, clarification });
	const saved = await memory.updateThreadMetadata({ id: threadId, update: thread => ({ ...thread.metadata, [specialistClarificationKey]: stored }) });
	if (!saved)
		throw new Error('The current specialist clarification could not be retained.');
}
