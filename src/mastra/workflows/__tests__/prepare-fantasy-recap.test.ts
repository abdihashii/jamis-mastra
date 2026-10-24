import type { createFantasyEditorialProcedure as CreateProcedure, FantasyEditorialObserver } from '../prepare-fantasy-recap';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Agent } from '@mastra/core/agent';
import { Groups } from 'sendblue/resources/groups';
import { Messages } from 'sendblue/resources/messages';
import { editorialFixtureRuntime, passingEditorialReview } from '../../../lib/fantasy/__tests__/fixtures/editorial-runtime.fixture';
import { editorialFixtureQuote, frozenEditorialFixture, validEditorialDraft } from '../../../lib/fantasy/__tests__/fixtures/editorial.fixture';
import { editorialReviewSchema } from '../../../lib/fantasy/editorial-loop';

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

type ObserverEvent
	= | ({ phase: 'before' } & Parameters<FantasyEditorialObserver['beforeCall']>[0])
		| ({ phase: 'output' } & Parameters<FantasyEditorialObserver['output']>[0])
		| ({ phase: 'failure' } & Parameters<FantasyEditorialObserver['failure']>[0]);

function recordingObserver() {
	const events: ObserverEvent[] = [];
	const observer: FantasyEditorialObserver = {
		beforeCall: async (call) => {
			events.push({ phase: 'before', ...call });
			return { remainingMs: 60_000 };
		},
		output: async (output) => { events.push({ phase: 'output', ...output }); },
		failure: async (failure) => { events.push({ phase: 'failure', ...failure }); },
	};
	return { observer, events };
}

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

	test.each(['throw', 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('reservation %s blocks before any native model call', async (remainingMs) => {
		const packet = await frozenEditorialFixture();
		const fixture = editorialFixtureRuntime(() => ({ case: 'completed', result: validEditorialDraft(packet) }));
		const { observer, events } = recordingObserver();
		observer.beforeCall = async (call) => {
			events.push({ phase: 'before', ...call });
			if (remainingMs === 'throw')
				throw new Error('PRIVATE_RESERVATION_ERROR');
			return { remainingMs };
		};
		const result = await createProcedure(fixture.runtime)(packet, undefined, observer);
		expect(result.status).toBe('blocked');
		expect(fixture.calls).toHaveLength(0);
		expect(fixture.resolved).toHaveLength(0);
		expect(events).toEqual([{ phase: 'before', kind: 'writer', ordinal: 1 }]);
		expect(JSON.stringify(result)).not.toContain('PRIVATE_RESERVATION_ERROR');
	});

	test.each([0, 'throw'] as const)('reviewer reservation %s blocks before reviewer model work', async (remainingMs) => {
		const packet = await frozenEditorialFixture();
		const { observer, events } = recordingObserver();
		const beforeCall = observer.beforeCall;
		observer.beforeCall = async (call) => {
			const reservation = await beforeCall(call);
			if (call.kind === 'writer')
				return reservation;
			if (remainingMs === 'throw')
				throw new Error('PRIVATE_RESERVATION_ERROR');
			return { remainingMs };
		};
		const fixture = editorialFixtureRuntime(({ role, data }) => role === 'writer'
			? { case: 'completed', result: validEditorialDraft(packet) }
			: passingEditorialReview(data));
		const result = await createProcedure(fixture.runtime)(packet, undefined, observer);
		expect(result.status).toBe('blocked');
		expect(fixture.calls.map(call => call.role)).toEqual(['writer']);
		expect(events.map(event => [event.phase, event.kind, event.ordinal])).toEqual([
			['before', 'writer', 1],
			['output', 'writer', 1],
			['before', 'reviewer', 1],
		]);
	});

	test('cancellation during reservation prevents model work and removes the abort listener', async () => {
		const packet = await frozenEditorialFixture();
		const { observer, events } = recordingObserver();
		const controller = new AbortController();
		const remove = spyOn(controller.signal, 'removeEventListener');
		const beforeCall = observer.beforeCall;
		observer.beforeCall = async (call) => {
			const reservation = await beforeCall(call);
			controller.abort();
			await new Promise(resolve => setTimeout(resolve, 0));
			return reservation;
		};
		const fixture = editorialFixtureRuntime(() => ({ case: 'completed', result: validEditorialDraft(packet) }));
		try {
			const result = await createProcedure(fixture.runtime)(packet, controller.signal, observer);
			expect(result).toMatchObject({ status: 'blocked', reason: 'canceled' });
			expect(fixture.calls).toHaveLength(0);
			expect(fixture.resolved).toHaveLength(0);
			expect(events).toEqual([{ phase: 'before', kind: 'writer', ordinal: 1 }]);
			expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
		} finally {
			remove.mockRestore();
		}
	});

	test('reserves before each native call and captures typed drafts and reviews in role ordinal order', async () => {
		const packet = await frozenEditorialFixture();
		const { observer, events } = recordingObserver();
		const outputs: Array<Parameters<FantasyEditorialObserver['output']>[0]['value']> = [];
		let reviews = 0;
		const fixture = editorialFixtureRuntime(({ role, data }) => {
			expect(events.at(-1)).toEqual({ phase: 'before', kind: role, ordinal: data.revision === undefined ? reviews + 1 : data.revision + 1 });
			const value = role === 'writer' ? validEditorialDraft(packet) : editorialReviewSchema.parse(passingEditorialReview(data).result);
			if ('verdict' in value && reviews++ === 0) {
				value.verdict = 'fail';
				value.issues = [{ path: 'manager', category: 'fairness', message: 'PRIVATE_TYPED_CRITIQUE', supportIds: [] }];
			}
			outputs.push(value);
			return { case: 'completed', result: value };
		});
		const result = await createProcedure(fixture.runtime)(packet, undefined, observer);
		expect(result).toMatchObject({ status: 'approved', counts: { drafts: 2, reviews: 2 } });
		expect(events).toEqual((['writer', 'reviewer', 'writer', 'reviewer'] as const).flatMap((kind, index) => [
			{ phase: 'before', kind, ordinal: Math.floor(index / 2) + 1 },
			{ phase: 'output', kind, ordinal: Math.floor(index / 2) + 1, contributionCase: 'completed', value: outputs[index] },
		]));
	});

	test('captures a schema-valid invalid draft before deterministic repair', async () => {
		const packet = await frozenEditorialFixture();
		const { observer, events } = recordingObserver();
		const invalid = validEditorialDraft(packet);
		invalid.manager.rosterIds = [999];
		const fixture = editorialFixtureRuntime(({ role, data }) => {
			if (role === 'reviewer')
				return passingEditorialReview(data);
			if (data.revision > 0) {
				expect(events[1]).toEqual({ phase: 'output', kind: 'writer', ordinal: 1, contributionCase: 'completed', value: invalid });
				expect(data.feedback.previousDraft).toEqual(invalid);
			}
			return { case: 'completed', result: data.revision === 0 ? invalid : validEditorialDraft(packet) };
		});
		const result = await createProcedure(fixture.runtime)(packet, undefined, observer);
		expect(result).toMatchObject({ status: 'approved', counts: { drafts: 2, reviews: 1 } });
		expect(events.filter(event => event.phase === 'output').map(event => [event.kind, event.ordinal])).toEqual([['writer', 1], ['writer', 2], ['reviewer', 1]]);
	});

	for (const kind of ['writer', 'reviewer'] as const) {
		test.each(['partial', 'needs_help', 'blocked', 'null-progress'] as const)(`captures %s typed contribution from ${kind} without approving it`, async (contribution) => {
			const packet = await frozenEditorialFixture();
			const { observer, events } = recordingObserver();
			let value: Parameters<FantasyEditorialObserver['output']>[0]['value'] = null;
			const contributionCase = contribution === 'null-progress' ? 'blocked' : contribution;
			const fixture = editorialFixtureRuntime(({ role, data }) => {
				const result = role === 'writer' ? validEditorialDraft(packet) : editorialReviewSchema.parse(passingEditorialReview(data).result);
				if (role !== kind)
					return { case: 'completed', result };
				value = contribution === 'null-progress' ? null : result;
				return contributionCase === 'partial'
					? { case: 'partial', result, gaps: ['PRIVATE_GAPS'] }
					: contributionCase === 'needs_help'
						? { case: 'needs_help', need: { kind: 'input', question: 'PRIVATE_NEED', missing: ['PRIVATE_MISSING'] }, progress: value }
						: { case: 'blocked', reason: 'PRIVATE_BLOCK_REASON', progress: value };
			});
			const result = await createProcedure(fixture.runtime)(packet, undefined, observer);
			expect(result.status).toBe('blocked');
			expect(result).not.toHaveProperty('candidate');
			expect(fixture.calls).toHaveLength(kind === 'writer' ? 1 : 2);
			expect(events.at(-1)).toEqual({ phase: 'output', kind, ordinal: 1, contributionCase, value });
			for (const sentinel of ['PRIVATE_GAPS', 'PRIVATE_NEED', 'PRIVATE_MISSING', 'PRIVATE_BLOCK_REASON'])
				expect(JSON.stringify({ events, result })).not.toContain(sentinel);
		});
	}

	test.each(['missing', 'malformed', 'extra-envelope-key', 'extra-result-key'] as const)('reports only no_structured_output for %s response.object', async (fault) => {
		const packet = await frozenEditorialFixture();
		const { observer, events } = recordingObserver();
		const fixture = editorialFixtureRuntime(() => ({ case: 'completed', result: validEditorialDraft(packet) }));
		const original = Agent.prototype.generate;
		const generate = spyOn(Agent.prototype, 'generate').mockImplementation(async function (this: Agent, ...args: Parameters<typeof original>) {
			const response = await original.apply(this, args);
			const handback = { case: 'completed', result: validEditorialDraft(packet) };
			const object = fault === 'missing'
				? undefined
				: fault === 'malformed'
					? { handback: { case: 'completed', result: { text: 'PRIVATE_RAW_OUTPUT' } } }
					: fault === 'extra-envelope-key'
						? { handback, raw: 'PRIVATE_RAW_OUTPUT' }
						: { handback: { ...handback, result: { ...handback.result, raw: 'PRIVATE_RAW_OUTPUT' } } };
			return { ...response, object, text: 'PRIVATE_RAW_TEXT' } as typeof response;
		});
		try {
			const result = await createProcedure(fixture.runtime)(packet, undefined, observer);
			expect(result.status).toBe('blocked');
			expect(events).toEqual([
				{ phase: 'before', kind: 'writer', ordinal: 1 },
				{ phase: 'failure', kind: 'writer', ordinal: 1, code: 'no_structured_output' },
			]);
			expect(fixture.calls).toHaveLength(1);
			expect(JSON.stringify(result)).not.toContain('PRIVATE_RAW');
		} finally {
			generate.mockRestore();
		}
	});

	test('native provider errors expose only a fixed execution failure code', async () => {
		const packet = await frozenEditorialFixture();
		const { observer, events } = recordingObserver();
		const fixture = editorialFixtureRuntime(() => {
			throw Object.assign(new Error('PRIVATE_NATIVE_ERROR'), { requestContext: 'PRIVATE_CONTEXT', authorization: 'PRIVATE_AUTH' });
		});
		const result = await createProcedure(fixture.runtime)(packet, undefined, observer);
		expect(result.status).toBe('blocked');
		expect(events).toEqual([
			{ phase: 'before', kind: 'writer', ordinal: 1 },
			{ phase: 'failure', kind: 'writer', ordinal: 1, code: 'execution_failed' },
		]);
		expect(fixture.calls).toHaveLength(1);
		for (const sentinel of ['PRIVATE_NATIVE_ERROR', 'PRIVATE_CONTEXT', 'PRIVATE_AUTH'])
			expect(JSON.stringify({ events, result })).not.toContain(sentinel);
	});

	test.each(['writer', 'reviewer', 'failure'] as const)('observer %s persistence error blocks all following model work', async (stage) => {
		const packet = await frozenEditorialFixture();
		const { observer, events } = recordingObserver();
		const fixture = editorialFixtureRuntime(({ role, data }) => {
			if (stage === 'failure')
				throw new Error('PRIVATE_NATIVE_ERROR');
			if (role === 'writer')
				return { case: 'completed', result: validEditorialDraft(packet) };
			const pass = passingEditorialReview(data);
			return { ...pass, result: { ...pass.result, verdict: 'fail', issues: [{ path: 'manager', category: 'voice', message: 'Needs repair', supportIds: [] }] } };
		});
		const output = observer.output;
		observer.output = async (event) => {
			await output(event);
			if (event.kind === stage)
				throw new Error('PRIVATE_PERSISTENCE_ERROR');
		};
		if (stage === 'failure') {
			const failure = observer.failure;
			observer.failure = async (event) => {
				await failure(event);
				throw new Error('PRIVATE_PERSISTENCE_ERROR');
			};
		}
		const result = await createProcedure(fixture.runtime)(packet, undefined, observer);
		expect(result.status).toBe('blocked');
		expect(fixture.calls).toHaveLength(stage === 'reviewer' ? 2 : 1);
		expect(events.filter(event => event.phase === 'failure')).toHaveLength(stage === 'failure' ? 1 : 0);
		expect(JSON.stringify(result)).not.toContain('PRIVATE_PERSISTENCE_ERROR');
	});

	test.each([12_345, 600_000, 1_800_000])('deadline %i aborts the native model without replacing the other bounds', async (deadlineMs) => {
		const packet = await frozenEditorialFixture();
		const { observer, events } = recordingObserver();
		observer.beforeCall = async () => ({ remainingMs: 12_345 });
		const deadline = new AbortController();
		const original = AbortSignal.timeout;
		const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === deadlineMs ? deadline.signal : original(ms));
		const fixture = editorialFixtureRuntime(async ({ options }) => {
			deadline.abort(new DOMException('Deadline expired', 'TimeoutError'));
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(options.abortSignal.aborted).toBe(true);
			throw options.abortSignal.reason;
		});
		try {
			const result = await createProcedure(fixture.runtime)(packet, undefined, observer);
			expect(result.status).toBe('blocked');
			expect(fixture.calls).toHaveLength(1);
			expect(timeout.mock.calls.map(([ms]) => ms)).toEqual(expect.arrayContaining([12_345, 600_000, 1_800_000]));
			// Native cancellation can return an empty response instead of throwing from generate.
			expect(events).toEqual([{ phase: 'failure', kind: 'writer', ordinal: 1, code: 'no_structured_output' }]);
		} finally {
			timeout.mockRestore();
		}
	});

	test('captures a late valid response after cancellation but before the private handback check', async () => {
		const packet = await frozenEditorialFixture();
		const { observer, events } = recordingObserver();
		const controller = new AbortController();
		const fixture = editorialFixtureRuntime(() => ({ case: 'completed', result: validEditorialDraft(packet) }));
		const original = Agent.prototype.generate;
		const generate = spyOn(Agent.prototype, 'generate').mockImplementation(async function (this: Agent, ...args: Parameters<typeof original>) {
			const response = await original.apply(this, args);
			controller.abort();
			return response;
		});
		try {
			const result = await createProcedure(fixture.runtime)(packet, controller.signal, observer);
			expect(result).toMatchObject({ status: 'blocked', reason: 'canceled' });
			expect(fixture.calls).toHaveLength(1);
			expect(events).toEqual([
				{ phase: 'before', kind: 'writer', ordinal: 1 },
				{ phase: 'output', kind: 'writer', ordinal: 1, contributionCase: 'completed', value: validEditorialDraft(packet) },
			]);
		} finally {
			generate.mockRestore();
		}
	});

	test('concurrent preparations isolate observers and counters, and never touch parent storage', async () => {
		const packet = await frozenEditorialFixture();
		const first = recordingObserver();
		const second = recordingObserver();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const beforeCall = first.observer.beforeCall;
		first.observer.beforeCall = async (call) => {
			const reservation = await beforeCall(call);
			if (call.kind === 'writer') {
				entered.resolve();
				await release.promise;
			}
			return reservation;
		};
		const fixture = editorialFixtureRuntime(({ role, data }) => role === 'writer'
			? { case: 'completed', result: validEditorialDraft(packet) }
			: passingEditorialReview(data));
		const storage = spyOn(fixture.runtime, 'getStorage').mockImplementation(() => {
			throw new Error('SQL, memory and snapshots forbidden');
		});
		try {
			const prepare = createProcedure(fixture.runtime);
			const pending = prepare(packet, undefined, first.observer);
			await entered.promise;
			try {
				expect((await prepare(packet, undefined, second.observer)).status).toBe('approved');
				expect(first.events).toEqual([{ phase: 'before', kind: 'writer', ordinal: 1 }]);
				expect((await prepare(packet)).status).toBe('approved');
				expect(second.events).toHaveLength(4);
			} finally {
				release.resolve();
			}
			expect((await pending).status).toBe('approved');
			expect(first.events).toEqual(second.events);
			expect(first.events.map(event => [event.phase, event.kind, event.ordinal])).toEqual([
				['before', 'writer', 1],
				['output', 'writer', 1],
				['before', 'reviewer', 1],
				['output', 'reviewer', 1],
			]);
			expect(fixture.calls).toHaveLength(6);
			expect(storage).not.toHaveBeenCalled();
			expect(Object.keys(fixture.runtime.listAgents())).toEqual([]);
			expect(Object.keys(fixture.runtime.listWorkflows())).toEqual([]);
		} finally {
			storage.mockRestore();
		}
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
