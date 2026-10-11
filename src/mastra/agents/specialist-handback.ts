import { z } from 'zod';

const explanation = z.string().trim().min(1).max(4000);
const needSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('input'), question: explanation, missing: z.array(explanation).min(1).max(5) }).strict(),
	z.object({ kind: z.literal('contribution'), specialist: z.literal('research'), assignment: explanation }).strict(),
	z.object({ kind: z.literal('approval'), operationId: z.string().uuid() }).strict(),
]);

export function specialistHandbackSchema<T extends Record<string, unknown>>(resultSchema: z.ZodType<T, T>) {
	return z.discriminatedUnion('case', [
		z.object({ case: z.literal('completed'), result: resultSchema }).strict(),
		z.object({ case: z.literal('partial'), result: resultSchema, gaps: z.array(explanation).min(1).max(10) }).strict(),
		z.object({ case: z.literal('needs_help'), need: needSchema, progress: resultSchema.nullable() }).strict(),
		z.object({ case: z.literal('blocked'), reason: explanation, progress: resultSchema.nullable() }).strict(),
	]);
}

export type SpecialistHandback<T>
	= | { case: 'completed'; result: T }
		| { case: 'partial'; result: T; gaps: string[] }
		| { case: 'needs_help'; need: z.infer<typeof needSchema>; progress: T | null }
		| { case: 'blocked'; reason: string; progress: T | null };

export interface SpecialistFailure<T> {
	case: 'failed';
	reason: 'Specialist execution or handback validation failed.';
	progress: T | null;
}
