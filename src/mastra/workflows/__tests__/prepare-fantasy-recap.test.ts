import type { createFantasyEditorialProcedure as CreateProcedure } from '../prepare-fantasy-recap';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Groups } from 'sendblue/resources/groups';
import { Messages } from 'sendblue/resources/messages';
import { editorialFixtureRuntime, passingEditorialReview } from '../../../lib/fantasy/__tests__/fixtures/editorial-runtime.fixture';
import { editorialFixtureQuote, frozenEditorialFixture, validEditorialDraft } from '../../../lib/fantasy/__tests__/fixtures/editorial.fixture';

let createProcedure: typeof CreateProcedure;
let group: ReturnType<typeof spyOn>;
let dm: ReturnType<typeof spyOn>;
let network: ReturnType<typeof spyOn>;
beforeAll(async () => {
	group = spyOn(Groups.prototype, 'sendMessage').mockImplementation(() => {
		throw new Error('Group send forbidden');
	});
	dm = spyOn(Messages.prototype, 'send').mockImplementation(() => {
		throw new Error('DM send forbidden');
	});
	network = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => {
		throw new Error('External network forbidden');
	}, { preconnect() { throw new Error('External network forbidden'); } }));
	({ createFantasyEditorialProcedure: createProcedure } = await import('../prepare-fantasy-recap'));
});
afterAll(() => {
	expect(group).not.toHaveBeenCalled();
	expect(dm).not.toHaveBeenCalled();
	expect(network).not.toHaveBeenCalled();
	group.mockRestore();
	dm.mockRestore();
	network.mockRestore();
});

describe('private native Fantasy candidate procedure', () => {
	test('actual native checked calls prepare an exact reviewed artifact without registering roots or workflows', async () => {
		const packet = await frozenEditorialFixture();
		const fixture = editorialFixtureRuntime(({ role, data }) => role === 'writer'
			? { case: 'completed', result: validEditorialDraft(packet) }
			: passingEditorialReview(data));
		const run = createProcedure(fixture.runtime);
		const result = await run(packet);
		expect(result.status).toBe('approved');
		expect(result.counts).toEqual({ drafts: 1, reviews: 1 });
		expect(fixture.calls.map(call => call.role)).toEqual(['writer', 'reviewer']);
		expect(fixture.resolved.every(id => id === 'gpt-6-astra')).toBe(true);
		expect(fixture.resolved.length).toBeGreaterThan(0);
		expect(Object.keys(fixture.runtime.listAgents())).toEqual([]);
		expect(Object.keys(fixture.runtime.listWorkflows())).toEqual([]);
		expect(() => fixture.runtime.getWorkflow('prepare_fantasy_recap')).toThrow();
		if (result.status === 'approved') {
			expect(result.candidate.parts[0]).toContain(editorialFixtureQuote);
			expect(result.review.candidateId).toBe(result.candidate.id);
			expect(fixture.calls[1].data.candidate.parts).toEqual(result.candidate.parts);
		}
		for (const call of fixture.calls) {
			expect(call.options.tools ?? []).toEqual([]);
			expect(call.options.providerOptions.openai).toMatchObject({ reasoningEffort: 'xhigh', parallelToolCalls: false });
			expect(JSON.stringify(call.options)).not.toContain('+15550000001');
			expect(JSON.stringify(call.options)).not.toContain('fixture-group');
		}
	});

	test('actual failed review feeds specific issues back to the writer and rechecks the changed exact parts', async () => {
		const packet = await frozenEditorialFixture();
		let reviews = 0;
		const issue = { path: 'manager.body', category: 'grounding', message: 'The claim is unsupported.', supportIds: ['score:1:1'] };
		const fixture = editorialFixtureRuntime(({ role, data }) => {
			if (role === 'writer') {
				const draft = validEditorialDraft(packet);
				if (data.revision > 0) {
					expect(data.feedback.issues).toEqual([issue]);
					draft.manager.body = 'A performance worth recognizing without inventing managerial intent.';
				}
				return { case: 'completed', result: draft };
			}
			const pass = passingEditorialReview(data);
			return reviews++ === 0 ? { ...pass, result: { ...pass.result, verdict: 'fail', issues: [issue] } } : pass;
		});
		const result = await createProcedure(fixture.runtime)(packet);
		expect(result.status).toBe('approved');
		expect(result.counts).toEqual({ drafts: 2, reviews: 2 });
		expect(fixture.calls.map(call => call.role)).toEqual(['writer', 'reviewer', 'writer', 'reviewer']);
		expect(fixture.calls[1].data.candidate.id).not.toBe(fixture.calls[3].data.candidate.id);
		expect(fixture.calls.every(call => call.data.evidence.evidenceId === packet.id)).toBe(true);
	});

	test('native persistent critique stops at three drafts/reviews without outputting a rejected report', async () => {
		const packet = await frozenEditorialFixture();
		const fixture = editorialFixtureRuntime(({ role, data }) => {
			if (role === 'writer')
				return { case: 'completed', result: validEditorialDraft(packet) };
			const pass = passingEditorialReview(data);
			return { ...pass, result: { ...pass.result, verdict: 'fail', issues: [{ path: 'manager', category: 'fairness', message: 'PRIVATE_REVIEW_CRITIQUE', supportIds: [] }] } };
		});
		const result = await createProcedure(fixture.runtime)(packet);
		expect(result).toMatchObject({ status: 'blocked', reason: 'revision_budget_exhausted', counts: { drafts: 3, reviews: 3 } });
		expect(result).not.toHaveProperty('candidate');
		expect(JSON.stringify(result)).not.toContain('PRIVATE_REVIEW_CRITIQUE');
		expect(fixture.calls).toHaveLength(6);
	});

	test.each(['malformed', 'stale', 'provider-error', 'partial'])('fails closed on %s native reviewer output, without fallback or retry', async (fault) => {
		const packet = await frozenEditorialFixture();
		const fixture = editorialFixtureRuntime(({ role, data }) => {
			if (role === 'writer')
				return { case: 'completed', result: validEditorialDraft(packet) };
			if (fault === 'provider-error')
				throw new Error('PRIVATE_PROVIDER_ERROR');
			if (fault === 'malformed')
				return { case: 'completed', result: { verdict: 'pass' } };
			const pass = passingEditorialReview(data);
			if (fault === 'stale')
				return { ...pass, result: { ...pass.result, candidateId: 'old' } };
			return { case: 'partial', result: pass.result, gaps: ['Unavailable review'] };
		});
		const result = await createProcedure(fixture.runtime)(packet);
		expect(result).toMatchObject({ status: 'blocked', counts: { drafts: 1, reviews: 1 } });
		expect(result).not.toHaveProperty('candidate');
		expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_ERROR');
		expect(fixture.calls).toHaveLength(2);
	});

	test('native cancellation reaches the in-flight model and blocks all following review work', async () => {
		const packet = await frozenEditorialFixture();
		const controller = new AbortController();
		const fixture = editorialFixtureRuntime(async ({ options }) => {
			controller.abort();
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(options.abortSignal.aborted).toBe(true);
			throw options.abortSignal.reason;
		});
		const result = await createProcedure(fixture.runtime)(packet, controller.signal);
		expect(result).toMatchObject({ status: 'blocked', reason: 'canceled', counts: { drafts: 1, reviews: 0 } });
		expect(fixture.calls).toHaveLength(1);
	});
});
