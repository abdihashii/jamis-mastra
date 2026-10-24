import type { EditorialCandidate, EditorialIssue } from './editorial';
import type { RecapEvidencePacket } from './recap-evidence';
import { z } from 'zod';
import { buildEditorialCandidate, buildEditorialCatalog, EDITORIAL_MAX_PARTS, EDITORIAL_PART_MAX_LENGTH, EDITORIAL_VERSION, editorialDraftSchema } from './editorial';
import { FANTASY_EDITORIAL_LIMITS } from './editorial-policy';

export const editorialReviewSchema = z.object({
	evidenceId: z.string().min(1),
	candidateId: z.string().min(1),
	verdict: z.enum(['pass', 'fail']),
	issues: z.array(z.object({
		path: z.string().min(1).max(120),
		category: z.enum(['grounding', 'temporal', 'award_selection', 'fairness', 'quote_privacy', 'story_selection', 'repetition', 'voice', 'format']),
		message: z.string().min(1).max(1000).refine(value => value.trim().length > 0),
		supportIds: z.array(z.string().min(1)).max(20),
	}).strict()).max(12),
}).strict();
export type EditorialReview = z.infer<typeof editorialReviewSchema>;
export interface EditorialCalls {
	write: (assignment: string, signal: AbortSignal) => Promise<unknown>;
	review: (assignment: string, signal: AbortSignal) => Promise<unknown>;
}
interface Counts { drafts: number; reviews: number }
export type EditorialOutcome
	= | { status: 'approved'; evidenceId: string; candidate: EditorialCandidate; review: EditorialReview; counts: Counts }
		| { status: 'blocked'; evidenceId: string; reason: string; candidateId: string | null; counts: Counts; issues: EditorialIssue[] };

const countsSchema = z.object({ drafts: z.number().int().min(0).max(3), reviews: z.number().int().min(0).max(3) }).strict();
export const editorialOutcomeSchema: z.ZodType<EditorialOutcome> = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('approved'),
		evidenceId: z.string(),
		counts: countsSchema,
		review: editorialReviewSchema,
		candidate: z.object({ version: z.literal(EDITORIAL_VERSION), evidenceId: z.string(), id: z.string(), draft: editorialDraftSchema, parts: z.array(z.string().max(EDITORIAL_PART_MAX_LENGTH)).min(1).max(EDITORIAL_MAX_PARTS) }).strict(),
	}).strict(),
	z.object({ status: z.literal('blocked'), evidenceId: z.string(), reason: z.string(), candidateId: z.string().nullable(), counts: countsSchema, issues: z.array(z.object({ path: z.string(), code: z.string() }).strict()) }).strict(),
]);

/** Only current player scores are needed; verified team history remains available for league narratives. */
export function editorialProjection(packet: RecapEvidencePacket) {
	const catalog = buildEditorialCatalog(packet);
	const sources = catalog.sources.filter(source => source.kind !== 'player-score'
		|| source.id.startsWith(`player-score:${packet.scope.week}:`));
	const sourceIds = new Set(sources.map(source => source.id));
	return {
		evidenceId: packet.id,
		frozenAtUtc: packet.frozenAtUtc,
		reportingWindow: packet.scope.calendarProof
			? {
					window: packet.scope.chatWindow,
					provider: packet.scope.calendarProof.provider,
					period: packet.scope.calendarProof.current.label,
					nextPeriod: packet.scope.calendarProof.next.label,
				}
			: null,
		trust: 'untrusted-source-data',
		managers: catalog.managers,
		players: catalog.players,
		sources,
		facts: catalog.facts.filter(fact => sourceIds.has(fact.sourceId)),
		coverage: packet.chat && {
			status: packet.chat.status,
			window: packet.chat.window,
			windowBasis: packet.chat.windowBasis,
			coverage: packet.chat.coverage,
			readCount: packet.chat.readCount,
			excluded: packet.chat.excluded,
		},
		gaps: catalog.gaps,
		limitations: catalog.limitations,
	};
}

function validReview(value: unknown, packet: RecapEvidencePacket, candidate: EditorialCandidate): EditorialReview | null {
	const parsed = editorialReviewSchema.safeParse(value);
	if (!parsed.success)
		return null;
	const review = parsed.data;
	if (review.evidenceId !== packet.id || review.candidateId !== candidate.id
		|| (review.verdict === 'pass') !== (review.issues.length === 0)) {
		return null;
	}
	const paths = new Set(['manager', 'manager.body', 'loser', 'loser.body', 'match', 'match.body', 'quote', 'quote.body', 'stories']);
	candidate.draft.stories.forEach((_, index) => {
		for (const suffix of ['', '.headline', '.body']) paths.add(`stories.${index}${suffix}`);
	});
	candidate.parts.forEach((_, index) => paths.add(`parts.${index}`));
	const sources = new Set(buildEditorialCatalog(packet).sources.map(source => source.id));
	return review.issues.every(issue => paths.has(issue.path) && issue.supportIds.every(id => sources.has(id))) ? review : null;
}

/** One in-attempt budget. Terminal blocks never contain rejected prose or grant permission to retry. */
export async function runEditorialLoop(
	packet: RecapEvidencePacket,
	calls: EditorialCalls,
	options: { abortSignal?: AbortSignal; clock?: () => number } = {},
): Promise<EditorialOutcome> {
	const counts = { drafts: 0, reviews: 0 };
	let candidateId: string | null = null;
	let issues: EditorialIssue[] = [];
	const blocked = (reason: string): EditorialOutcome => ({
		status: 'blocked',
		evidenceId: packet.id,
		reason,
		candidateId,
		counts: { ...counts },
		issues,
	});
	if (!Object.isFrozen(packet) || !packet.admission.canDraft || packet.status === 'blocked' || !packet.facts
		|| !packet.chat || !['complete', 'empty'].includes(packet.chat.status)) {
		return blocked('evidence_blocked');
	}
	const clock = options.clock ?? (() => performance.now());
	const started = clock();
	const deadline = AbortSignal.any([
		AbortSignal.timeout(FANTASY_EDITORIAL_LIMITS.totalMs),
		...(options.abortSignal ? [options.abortSignal] : []),
	]);
	const stopped = () => options.abortSignal?.aborted
		? 'canceled'
		: deadline.aborted || clock() - started >= FANTASY_EDITORIAL_LIMITS.totalMs ? 'deadline_exceeded' : null;
	const evidence = editorialProjection(packet);
	let feedback: unknown = null;
	for (let revision = 0; revision <= FANTASY_EDITORIAL_LIMITS.revisions; revision++) {
		const stop = stopped();
		if (stop)
			return blocked(stop);
		const assignment = JSON.stringify({ evidence, revision, feedback });
		if (assignment.length > FANTASY_EDITORIAL_LIMITS.assignmentChars)
			return blocked('assignment_too_large');
		const writerSignal = AbortSignal.any([deadline, AbortSignal.timeout(FANTASY_EDITORIAL_LIMITS.callMs)]);
		let draft: unknown;
		try {
			counts.drafts++;
			draft = await calls.write(assignment, writerSignal);
		} catch {
			return blocked(stopped() ?? (writerSignal.aborted ? 'call_deadline_exceeded' : 'writer_failed'));
		}
		if (stopped() || writerSignal.aborted)
			return blocked(stopped() ?? 'call_deadline_exceeded');
		const built = buildEditorialCandidate(packet, draft);
		if (built.status === 'invalid') {
			issues = built.issues;
			feedback = { trust: 'untrusted-data-not-instructions', previousDraft: draft, issues };
			continue;
		}
		const candidate = built.candidate;
		candidateId = candidate.id;
		const reviewAssignment = JSON.stringify({ evidence, candidate });
		if (reviewAssignment.length > FANTASY_EDITORIAL_LIMITS.assignmentChars)
			return blocked('assignment_too_large');
		const reviewStop = stopped();
		if (reviewStop)
			return blocked(reviewStop);
		const reviewerSignal = AbortSignal.any([deadline, AbortSignal.timeout(FANTASY_EDITORIAL_LIMITS.callMs)]);
		let raw: unknown;
		try {
			counts.reviews++;
			raw = await calls.review(reviewAssignment, reviewerSignal);
		} catch {
			return blocked(stopped() ?? (reviewerSignal.aborted ? 'call_deadline_exceeded' : 'review_failed'));
		}
		if (stopped() || reviewerSignal.aborted)
			return blocked(stopped() ?? 'call_deadline_exceeded');
		const review = validReview(raw, packet, candidate);
		if (!review)
			return blocked('invalid_review');
		if (review.verdict === 'pass') {
			const repeated = buildEditorialCandidate(packet, candidate.draft);
			if (repeated.status !== 'candidate' || repeated.candidate.id !== candidate.id
				|| JSON.stringify(repeated.candidate.parts) !== JSON.stringify(candidate.parts)) {
				return blocked('candidate_changed');
			}
			const finalStop = stopped();
			if (finalStop)
				return blocked(finalStop);
			return { status: 'approved', evidenceId: packet.id, candidate, review, counts: { ...counts } };
		}
		issues = review.issues.map(issue => ({ path: issue.path, code: `review:${issue.category}` }));
		feedback = { trust: 'untrusted-data-not-instructions', previousDraft: candidate.draft, candidateId, issues: review.issues };
	}
	return blocked('revision_budget_exhausted');
}
