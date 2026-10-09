import { z } from 'zod';

// OpenAI function parameters require an object root.
export const researchQuestionSchema = z.object({
	kind: z.enum(['operator_request', 'clarification', 'carry_on_allowance']),
	subjectId: z.string().min(1).max(80).optional(),
}).strict().refine(input => (input.kind === 'carry_on_allowance') === (input.subjectId !== undefined), {
	message: 'subjectId is required only for carry_on_allowance.',
});

export interface PublicFareLabel {
	id: string;
	airline: string;
	fareClass: string;
}

export const publicFareLabels: readonly PublicFareLabel[] = [
	{ id: 'united-basic-economy', airline: 'United', fareClass: 'Basic Economy' },
];

// The application supplies this public catalogue, never an account message or model rewrite.
export function createResearchQuestionProjector(publicLabels: readonly PublicFareLabel[]) {
	const labels = new Map(publicLabels.map(label => [label.id, { ...label }]));
	return (input: z.infer<typeof researchQuestionSchema>) => {
		const label = input.kind === 'carry_on_allowance' && input.subjectId ? labels.get(input.subjectId) : undefined;
		return label
			? `What is the published carry-on allowance for ${label.airline} ${label.fareClass}? Use public policy only; ticket-specific exceptions are outside this assignment.`
			: { case: 'blocked' as const, reason: 'This question cannot be expressed using the permitted public labels.', progress: null };
	};
}
