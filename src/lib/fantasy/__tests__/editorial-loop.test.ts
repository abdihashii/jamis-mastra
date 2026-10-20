import type { EditorialCalls } from '../editorial-loop';
import { describe, expect, it, spyOn } from 'bun:test';
import { buildEditorialCandidate } from '../editorial';
import { editorialProjection, runEditorialLoop } from '../editorial-loop';
import { frozenEditorialFixture, validEditorialDraft } from './fixtures/editorial.fixture';

function pass(assignment: string) {
	const { evidence, candidate } = JSON.parse(assignment);
	return { evidenceId: evidence.evidenceId, candidateId: candidate.id, verdict: 'pass', issues: [] };
}
const issue = { path: 'manager.body', category: 'grounding', message: 'The interpretation is unsupported.', supportIds: ['score:1:1'] };

describe('bounded same-evidence editorial loop', () => {
	it('accepts only a deterministically rendered candidate and matching passing review', async () => {
		const packet = await frozenEditorialFixture();
		let writes = 0;
		let reviews = 0;
		const result = await runEditorialLoop(packet, {
			write: async (assignment, signal) => {
				writes++;
				expect(signal).toBeInstanceOf(AbortSignal);
				expect(JSON.parse(assignment)).toMatchObject({ evidence: { evidenceId: packet.id }, revision: 0, feedback: null });
				return validEditorialDraft(packet);
			},
			review: async (assignment, signal) => {
				reviews++;
				expect(signal.aborted).toBe(false);
				const { candidate } = JSON.parse(assignment);
				expect(candidate.parts[0]).toContain('Quote of the Week: Alpha');
				return pass(assignment);
			},
		});
		expect(result.status).toBe('approved');
		expect(result.counts).toEqual({ drafts: 1, reviews: 1 });
		expect([writes, reviews]).toEqual([1, 1]);
		if (result.status === 'approved') {
			expect(result.review).toMatchObject({ evidenceId: packet.id, candidateId: result.candidate.id, verdict: 'pass' });
			expect(Object.isFrozen(result.candidate.parts)).toBe(true);
		}
	});

	it('feeds a failed review only to the same writer and repeats both gates on the same evidence', async () => {
		const packet = await frozenEditorialFixture();
		let writes = 0;
		const reviewed: string[] = [];
		const result = await runEditorialLoop(packet, {
			write: async (assignment) => {
				const input = JSON.parse(assignment);
				expect(input.evidence.evidenceId).toBe(packet.id);
				const draft = validEditorialDraft(packet);
				if (writes++) {
					expect(input.feedback).toMatchObject({ trust: 'untrusted-data-not-instructions', issues: [issue] });
					expect(input.feedback.previousDraft).toEqual(validEditorialDraft(packet));
					draft.manager.body = 'A supported performance without pretending to know intent.';
				}
				return draft;
			},
			review: async (assignment) => {
				const review = pass(assignment);
				reviewed.push(review.candidateId);
				return reviewed.length === 1 ? { ...review, verdict: 'fail', issues: [issue] } : review;
			},
		});
		expect(result.status).toBe('approved');
		expect(result.counts).toEqual({ drafts: 2, reviews: 2 });
		expect(reviewed[0]).not.toBe(reviewed[1]);
	});

	it('repairs a deterministic failure before any review', async () => {
		const packet = await frozenEditorialFixture();
		let writes = 0;
		const result = await runEditorialLoop(packet, {
			write: async (assignment) => {
				const draft = validEditorialDraft(packet);
				if (!writes++)
					draft.manager.rosterIds = [999];
				else expect(JSON.parse(assignment).feedback.issues).toContainEqual({ path: 'manager.rosterIds', code: 'unknown_manager' });
				return draft;
			},
			review: async assignment => pass(assignment),
		});
		expect(result.status).toBe('approved');
		expect(result.counts).toEqual({ drafts: 2, reviews: 1 });
	});

	it.each(['deterministic', 'editorial'])('exhausts exactly two revisions on persistent %s issues', async (kind) => {
		const packet = await frozenEditorialFixture();
		const result = await runEditorialLoop(packet, {
			write: async () => {
				const draft = validEditorialDraft(packet);
				if (kind === 'deterministic')
					draft.manager.body = 'PRIVATE_REJECTED_PROSE 999.';
				return draft;
			},
			review: async assignment => ({ ...pass(assignment), verdict: 'fail', issues: [{ ...issue, message: 'PRIVATE_REVIEW_DETAIL' }] }),
		});
		expect(result).toMatchObject({ status: 'blocked', reason: 'revision_budget_exhausted', counts: { drafts: 3, reviews: kind === 'editorial' ? 3 : 0 } });
		expect(JSON.stringify(result)).not.toContain('PRIVATE_REJECTED_PROSE');
		expect(JSON.stringify(result)).not.toContain('PRIVATE_REVIEW_DETAIL');
		expect(result).not.toHaveProperty('candidate');
	});

	it.each(['missing', 'foreign-evidence', 'stale-candidate', 'pass-with-issue', 'fail-without-issue', 'unknown-source', 'unknown-path', 'replacement'])('fails closed on %s review', async (fault) => {
		const packet = await frozenEditorialFixture();
		const result = await runEditorialLoop(packet, {
			write: async () => validEditorialDraft(packet),
			review: async (assignment) => {
				const review = pass(assignment);
				if (fault === 'missing')
					return undefined;
				if (fault === 'foreign-evidence')
					return { ...review, evidenceId: 'foreign' };
				if (fault === 'stale-candidate')
					return { ...review, candidateId: 'old' };
				if (fault === 'pass-with-issue')
					return { ...review, issues: [issue] };
				if (fault === 'fail-without-issue')
					return { ...review, verdict: 'fail' };
				if (fault === 'unknown-source')
					return { ...review, verdict: 'fail', issues: [{ ...issue, supportIds: ['unknown'] }] };
				if (fault === 'unknown-path')
					return { ...review, verdict: 'fail', issues: [{ ...issue, path: 'stories.999.body' }] };
				return { ...review, replacementText: 'A different report' };
			},
		});
		expect(result).toMatchObject({ status: 'blocked', reason: 'invalid_review', counts: { drafts: 1, reviews: 1 } });
	});

	it.each(['writer', 'reviewer'])('does not retry a %s exception or export private error details', async (failed) => {
		const packet = await frozenEditorialFixture();
		const result = await runEditorialLoop(packet, {
			write: async () => {
				if (failed === 'writer')
					throw new Error('PRIVATE_PROVIDER_ERROR');
				return validEditorialDraft(packet);
			},
			review: async () => { throw new Error('PRIVATE_PROVIDER_ERROR'); },
		});
		expect(result).toMatchObject({ status: 'blocked', reason: failed === 'writer' ? 'writer_failed' : 'review_failed', counts: { drafts: 1, reviews: failed === 'writer' ? 0 : 1 } });
		expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_ERROR');
	});

	it('permits a successful pair beyond the former aggregate limit within the approved budget', async () => {
		const packet = await frozenEditorialFixture();
		let elapsed = 0;
		const result = await runEditorialLoop(packet, {
			write: async () => {
				elapsed += 250_000;
				return validEditorialDraft(packet);
			},
			review: async (assignment) => {
				elapsed += 250_000;
				return pass(assignment);
			},
		}, { clock: () => elapsed });
		expect(result).toMatchObject({ status: 'approved', counts: { drafts: 1, reviews: 1 } });
	});

	it('enforces the fifteen-minute aggregate deadline without resetting between revisions', async () => {
		const packet = await frozenEditorialFixture();
		let elapsed = 0;
		const result = await runEditorialLoop(packet, {
			write: async () => {
				elapsed += 150_000;
				return validEditorialDraft(packet);
			},
			review: async (assignment) => {
				elapsed += 150_000;
				return { ...pass(assignment), verdict: 'fail', issues: [issue] };
			},
		}, { clock: () => elapsed });
		expect(result).toMatchObject({ status: 'blocked', reason: 'deadline_exceeded', counts: { drafts: 3, reviews: 3 } });
	});

	it('does not start a review when the total deadline expires during deterministic validation', async () => {
		const packet = await frozenEditorialFixture();
		let phase = 0;
		let reviews = 0;
		const result = await runEditorialLoop(packet, {
			write: async () => {
				phase = 1;
				return validEditorialDraft(packet);
			},
			review: async (assignment) => {
				reviews++;
				return pass(assignment);
			},
		}, { clock: () => !phase ? 0 : phase++ === 1 ? 890_000 : 900_000 });
		expect(result).toMatchObject({ status: 'blocked', reason: 'deadline_exceeded', counts: { drafts: 1, reviews: 0 } });
		expect(reviews).toBe(0);
	});

	it.each(['writer', 'reviewer'])('aborts the %s at the fixed per-call deadline without any retry', async (role) => {
		const packet = await frozenEditorialFixture();
		const perCall = new AbortController();
		const total = new AbortController();
		const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 300_000 ? perCall.signal : total.signal);
		try {
			const expire = (signal: AbortSignal) => {
				perCall.abort(new DOMException('Expired', 'TimeoutError'));
				expect(signal.aborted).toBe(true);
				throw signal.reason;
			};
			const result = await runEditorialLoop(packet, {
				write: async (_assignment, signal) => role === 'writer' ? expire(signal) : validEditorialDraft(packet),
				review: async (_assignment, signal) => expire(signal),
			});
			expect(result).toMatchObject({ status: 'blocked', reason: 'call_deadline_exceeded', counts: { drafts: 1, reviews: role === 'writer' ? 0 : 1 } });
			expect(timeout).toHaveBeenCalledWith(900_000);
			expect(timeout).toHaveBeenCalledWith(300_000);
		} finally { timeout.mockRestore(); }
	});

	it('propagates cancellation through the in-flight call and never reviews afterward', async () => {
		const packet = await frozenEditorialFixture();
		const controller = new AbortController();
		let reviews = 0;
		const calls: EditorialCalls = {
			write: async (_assignment, signal) => {
				controller.abort();
				expect(signal.aborted).toBe(true);
				throw signal.reason;
			},
			review: async () => {
				reviews++;
				return undefined;
			},
		};
		expect(await runEditorialLoop(packet, calls, { abortSignal: controller.signal })).toMatchObject({
			status: 'blocked',
			reason: 'canceled',
			counts: { drafts: 1, reviews: 0 },
		});
		expect(reviews).toBe(0);
	});

	it('does not start model work for mutable or blocked evidence', async () => {
		const packet = await frozenEditorialFixture();
		let calls = 0;
		const execute = async () => {
			calls++;
			return undefined;
		};
		const mutable = structuredClone(packet);
		expect(await runEditorialLoop(mutable, { write: execute, review: execute })).toMatchObject({ status: 'blocked', reason: 'evidence_blocked' });
		expect(calls).toBe(0);
	});

	it('projects all scoped chat and source limits but never account/group/phone metadata', async () => {
		const packet = await frozenEditorialFixture();
		const data = JSON.stringify(editorialProjection(packet));
		expect(data).toContain('PRIVATE_FOOTBALL_CHAT');
		expect(data).toContain('quoteReview');
		expect(data).toContain('archived-window-only');
		for (const denied of ['+15550000001', 'fixture-group', 'fixture-league', 'u1', 'OperatorMemory', 'senderNumber', 'groupId'])
			expect(data).not.toContain(denied);
		const built = buildEditorialCandidate(packet, validEditorialDraft(packet));
		expect(built.status).toBe('candidate');
	});
});
