import { z } from 'zod';

// OpenAI function parameters require an object root.
export const researchQuestionSchema = z.object({
	kind: z.enum(['operator_request', 'clarification', 'carry_on_allowance']).describe('operator_request uses the exact current public Operator task, never a private or mixed account task. clarification uses the immediately preceding active-session public task and actual answer. carry_on_allowance is the only private-to-public template; unsupported projections return a gap. Never repeat Research to reset a task budget.'),
	subjectId: z.string().min(1).max(80).optional().describe('Verified application-provided public label ID for carry_on_allowance only. Never supply private text, identity, booking references, itinerary, or unrelated conversation.'),
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
