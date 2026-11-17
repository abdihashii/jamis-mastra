import { z } from 'zod';

export const editorialTextRangeSchema = z.object({
	part: z.number().int().nonnegative(),
	start: z.number().int().nonnegative(),
	length: z.number().int().positive(),
}).strict();
export type EditorialTextRange = z.infer<typeof editorialTextRangeSchema>;
