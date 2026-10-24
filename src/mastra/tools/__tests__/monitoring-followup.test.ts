import type { ChannelHandlerContext } from '@mastra/core/channels';
import type { Message, Thread } from 'chat';
import type { z } from 'zod';

import { SpanType } from '@mastra/core/observability';
import { RequestContext } from '@mastra/core/request-context';
import { makeCoreTool } from '@mastra/core/utils';
import { beforeEach, describe, expect, test } from 'bun:test';

import type { SqlLike } from '../../../lib/operator-time-zone';

process.env.JAMIS_ALLOWED_NUMBER = '+15555550101';
process.env.SENDBLUE_API_KEY = 'test-api-key';
process.env.SENDBLUE_API_SECRET = 'test-api-secret';
process.env.SENDBLUE_FROM_NUMBER = '+15555550100';
process.env.SENDBLUE_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.OPERATOR_TIMEZONE = 'UTC';

const { GENERIC_CHANNEL_ERROR, getSendblueChannelCapability, handleSendblueDirectMessage, hashSendblueMessageHandle } = await import('../../channels/sendblue.js');
const { clearDeploymentSnapshot, readDeploymentMonitoring, stageDeploymentSnapshot } = await import('../deployment-monitoring.js');
const { triageIncidentTool } = await import('../triage-incident.js');

const now = Date.parse('2030-01-01T12:00:00.000Z');
const at = new Date(now).toISOString();
const raw = 'private prompt +15555550101 secret-token';
const histories = new Map<string, Message[]>();
const sql = (async (strings: TemplateStringsArray) => strings.join(' ').replace(/\s+/g, ' ').trim().includes('WITH previous')
	? [{ applied: false, consumed_proposal: false, proposal_time_zone: null }]
	: []) as SqlLike;
sql.begin = operation => operation(sql);

beforeEach(() => {
	histories.clear();
	for (const id of ['thread-a', 'thread-b'])
		clearDeploymentSnapshot(id);
});

function operatorMessage(threadId: string, id: string, text: string): Message {
	const message = { id, threadId, text, author: { userId: process.env.JAMIS_ALLOWED_NUMBER }, metadata: { dateSent: new Date(now) } } as Message;
	histories.set(threadId, [...histories.get(threadId) ?? [], message]);
	return message;
}

function thread(id: string) {
	let failPost = false;
	const value = {
		id,
		isDM: true,
		adapter: { name: 'sendblue', fetchMessages: async (threadId: string) => ({ messages: histories.get(threadId) ?? [] }) },
		post: async () => {
			if (failPost)
				throw new Error(raw);
			return {};
		},
	} as unknown as Thread;
	return { value, setFailPost: (failed: boolean) => {
		failPost = failed;
	} };
}

async function dispatch<T>(
	thread: Thread,
	message: Message,
	handler: (requestContext: RequestContext, observedThread: Thread) => Promise<T>,
): Promise<T> {
	const requestContext = new RequestContext();
	let result!: T;
	await handleSendblueDirectMessage(thread, message, async (observedThread) => {
		result = await handler(requestContext, observedThread);
	}, { requestContext, signalMetadata: {} } as ChannelHandlerContext, sql);
	return result;
}

function evidence(stopped: Array<'app' | 'postgres' | 'clickhouse' | 'cloudflared'> = []) {
	const current = { availability: 'available', freshness: 'fresh', observedAt: at, gaps: [] };
	return {
		host: current,
		docker: { ...current, containers: (['app', 'postgres', 'clickhouse', 'cloudflared'] as const).map(component => ({ component, state: stopped.includes(component) ? 'exited' : 'running', raw })) },
		app: current,
		postgres: current,
		clickhouse: { ...current, gaps: [] },
		cloudflareTunnel: { ...current, containerState: 'running', recentDiagnostic: 'none_observed' },
		tailscale: { ...current, serviceState: 'active', backendState: 'Running' },
	};
}

async function snapshot(
	requestContext: RequestContext,
	thread: Thread,
	options: { stopped?: Array<'app' | 'postgres' | 'clickhouse' | 'cloudflared'>; replyFailure?: boolean; replyGenerationFailure?: boolean; fantasyFailure?: boolean; currentEvidence?: ReturnType<typeof evidence> } = {},
) {
	const capability = getSendblueChannelCapability(requestContext);
	const digest = capability && hashSendblueMessageHandle(capability.message.id);
	return await readDeploymentMonitoring({
		getStore: async () => ({ listTracesLight: async (args: { filters: { spanType: SpanType } }) => ({
			spans: (options.replyFailure || options.replyGenerationFailure) && args.filters.spanType === SpanType.GENERIC
				? [{
						name: 'sendblue.channel',
						spanType: SpanType.GENERIC,
						traceId: 'trace-reply',
						spanId: 'span-reply',
						startedAt: new Date(now),
						endedAt: new Date(now),
						metadata: { stage: options.replyGenerationFailure ? 'reply_generation' : 'reply_delivery', classification: 'failed', sendblue_message_digest: 'older', raw },
					}]
				: [],
			pagination: { hasMore: false },
		}) }) as never,
		readWorkflowRuns: async () => [],
		readFantasyRuns: async () => options.fantasyFailure ? [{ fantasyWeek: 4, status: 'failed', updatedAt: new Date(now), failureStage: 'reply_delivery', failureClassification: 'delivery_failed', lastError: raw }] as never : [],
		readEvidence: async () => (options.currentEvidence ?? evidence(options.stopped)) as never,
		currentDigest: digest,
		onSnapshot: capability ? (summary, findings) => stageDeploymentSnapshot(thread.id, capability.message.id, summary, findings) : undefined,
	}, 24, now);
}

async function followup(requestContext: RequestContext, finding?: Record<string, unknown>, mastra?: unknown) {
	return await triageIncidentTool.execute!(
		{ kind: 'monitoring_finding', ...(finding ? { finding } : {}) } as never,
		{ agent: { agentId: 'jamis' }, requestContext, mastra } as never,
	);
}

describe('authenticated Deployment Monitoring follow-up', () => {
	test('triages a missing-reply Monitoring finding without claiming a delivery failure', async () => {
		const conversation = thread('thread-a');
		await dispatch(conversation.value, operatorMessage('thread-a', 'request-1', 'Status?'), async (context, observed) => {
			const summary = await snapshot(context, observed, { replyGenerationFailure: true });
			expect(summary.needsAttention).toContainEqual({ subject: 'operator_conversation', fact: 'reply_not_generated', boundary: 'recent_history', at });
			await observed.post('A reply was not generated.');
		});
		const result = await dispatch(conversation.value, operatorMessage('thread-a', 'request-2', 'What happened?'), async context => await followup(context));
		expect(result).toMatchObject({ status: 'found', targetKind: 'monitoring_finding', incident: { stage: 'reply_generation', classification: 'execution_failed', impact: 'request_failed', cause: 'reply_not_generated', traceReference: { traceId: 'trace-reply', spanId: 'span-reply' } } });
		expect((triageIncidentTool.outputSchema as z.ZodTypeAny).safeParse(result).success).toBe(true);
		expect(JSON.stringify(result)).not.toContain(raw);
	});
	test('allows only safe finding clues and requires the live channel capability', async () => {
		const schema = triageIncidentTool.inputSchema as z.ZodTypeAny;
		expect(schema.parse({ kind: 'monitoring_finding', finding: { subject: 'docker', container: 'postgres' } })).toMatchObject({ kind: 'monitoring_finding' });
		expect(schema.safeParse({ kind: 'monitoring_finding', traceId: 'forged' }).success).toBe(false);
		expect(schema.safeParse({ kind: 'monitoring_finding', finding: { messageId: 'forged' } }).success).toBe(false);
		expect(schema.safeParse({ kind: 'monitoring_finding', component: 'docker' }).success).toBe(false);
		const providerSchema = (schema as unknown as { '~standard': { jsonSchema: { input: () => Record<string, unknown> } } })['~standard'].jsonSchema.input();
		expect(JSON.stringify(providerSchema)).toContain('monitoring_finding');
		expect(JSON.stringify(providerSchema)).not.toContain('traceId');
		expect(await followup(new RequestContext())).toMatchObject({ status: 'unavailable', evidenceGaps: ['missing_channel_capability'] });
	});

	test('resolves one accepted snapshot finding from captured evidence, not a changed source', async () => {
		const conversation = thread('thread-a');
		const first = operatorMessage('thread-a', 'request-1', 'How is the server?');
		let currentEvidence = evidence(['postgres']);
		const summary = await dispatch(conversation.value, first, async (context, observed) => {
			const result = await snapshot(context, observed, { currentEvidence });
			await observed.post('Monitoring snapshot');
			return result;
		});
		expect(summary.needsAttention).toEqual([{ subject: 'docker', fact: 'container_not_running', boundary: 'current', at, container: 'postgres' }]);
		currentEvidence = evidence();
		const second = operatorMessage('thread-a', 'request-2', 'What happened with that?');
		const result = await dispatch(conversation.value, second, async context => await followup(context));
		expect((triageIncidentTool.outputSchema as z.ZodTypeAny).safeParse(result).success).toBe(true);
		expect(result).toMatchObject({ status: 'found', targetKind: 'monitoring_finding', incident: { component: 'docker', stage: 'postgres_container', observedAtUtc: at, classification: 'component_not_running', impact: 'component_unavailable' } });
		if (!result || !('status' in result) || result.status !== 'found')
			throw new Error('Expected one finding');
		expect(result?.evidenceGaps).toContain('occurrence_time_unknown');
		expect(result?.evidenceGaps).toContain('cause_unproven');
		expect(JSON.stringify(result)).not.toMatch(/private prompt|secret-token|request-1|thread-a/);
		const third = operatorMessage('thread-a', 'request-3', 'And that?');
		expect(await dispatch(conversation.value, third, async context => await followup(context))).toMatchObject({ status: 'unavailable', evidenceGaps: ['monitoring_snapshot_unavailable'] });
	});

	test('keeps same-time findings separate through one accepted clarification reply', async () => {
		const conversation = thread('thread-a');
		await dispatch(conversation.value, operatorMessage('thread-a', 'request-1', 'Status?'), async (context, observed) => {
			await snapshot(context, observed, { stopped: ['postgres'], replyFailure: true });
			await observed.post('Two findings');
		});
		const second = operatorMessage('thread-a', 'request-2', 'What happened?');
		const ambiguous = await dispatch(conversation.value, second, async (context, observed) => {
			const result = await followup(context);
			await observed.post('Which finding?');
			return result;
		});
		expect(ambiguous).toMatchObject({ status: 'ambiguous', targetKind: 'monitoring_finding' });
		expect((triageIncidentTool.outputSchema as z.ZodTypeAny).safeParse(ambiguous).success).toBe(true);
		if (!ambiguous || !('status' in ambiguous) || ambiguous.status !== 'ambiguous')
			throw new Error('Expected ambiguous findings');
		expect(ambiguous.candidates).toHaveLength(2);
		expect(ambiguous.candidates?.map(candidate => candidate.component)).toEqual(['sendblue-channel', 'docker']);
		expect(ambiguous.candidates?.map(candidate => 'occurrenceTimeUtc' in candidate ? candidate.occurrenceTimeUtc : candidate.observedAtUtc)).toEqual([at, at]);
		const third = operatorMessage('thread-a', 'request-3', 'The reply one');
		const selected = await dispatch(conversation.value, third, async context => await followup(context, { subject: 'operator_conversation', fact: 'reply_acceptance_failed' }));
		expect(selected).toMatchObject({ status: 'found', incident: { component: 'sendblue-channel', stage: 'reply_delivery', cause: 'reply_delivery_failed', traceReference: { traceId: 'trace-reply', spanId: 'span-reply' } } });
		expect(JSON.stringify(selected)).not.toMatch(/secret-token|thread-a|request-1/);
	});

	test('matches finding clues after OpenAI strict-schema conversion', async () => {
		const conversation = thread('thread-a');
		await dispatch(conversation.value, operatorMessage('thread-a', 'request-1', 'Status?'), async (context, observed) => {
			await snapshot(context, observed, { stopped: ['postgres'] });
			await observed.post('Snapshot');
		});
		const result = await dispatch(conversation.value, operatorMessage('thread-a', 'request-2', 'The Postgres one'), async (requestContext) => {
			const tool = makeCoreTool(triageIncidentTool, {
				name: 'triageIncident',
				agentId: 'jamis',
				requestContext,
				model: { provider: 'openai-codex.responses', modelId: 'gpt-5.6-terra' } as never,
			});
			return await tool.execute!({
				kind: 'monitoring_finding',
				component: null,
				container: null,
				window: null,
				humanDomainReference: null,
				finding: { subject: 'docker', container: 'postgres', fact: null, at: null, week: null },
			}, { toolCallId: 'test-call', messages: [] });
		});
		expect(result).toMatchObject({ status: 'found', incident: { component: 'docker', stage: 'postgres_container' } });
	});

	test('matches timestamp clues by instant and rejects different instants', async () => {
		const conversation = thread('thread-a');
		for (const selectorAt of ['2030-01-01T12:00:00Z', '2030-01-01T12:00:00+00:00', '2030-01-01T13:00:00+01:00', '2030-01-01T12:00:01Z']) {
			await dispatch(conversation.value, operatorMessage('thread-a', `snapshot-${selectorAt}`, 'Status?'), async (context, observed) => {
				await snapshot(context, observed, { stopped: ['postgres'] });
				await observed.post('Snapshot');
			});
			const result = await dispatch(conversation.value, operatorMessage('thread-a', `followup-${selectorAt}`, 'What happened then?'), async context => await followup(context, { at: selectorAt }));
			expect(result).toMatchObject({ status: Date.parse(selectorAt) === now ? 'found' : 'not_found' });
		}
	});

	test('rejects failed replies, forged clues, intervening messages, and lost process state', async () => {
		const conversation = thread('thread-a');
		conversation.setFailPost(true);
		await expect(dispatch(conversation.value, operatorMessage('thread-a', 'request-1', 'Status?'), async (context, observed) => {
			await snapshot(context, observed, { stopped: ['postgres'] });
			await observed.post('Snapshot');
		})).rejects.toThrow(raw);
		conversation.setFailPost(false);
		const store = {
			listTracesLight: async (args: { filters: { metadata: Record<string, string> } }) => {
				expect(args.filters.metadata.sendblue_message_digest).toBe(hashSendblueMessageHandle('request-1'));
				return { spans: [{ name: 'sendblue.channel', spanType: SpanType.GENERIC, traceId: 'failed-snapshot-trace', spanId: 'failed-snapshot-span', startedAt: new Date(now), metadata: { stage: 'reply_delivery', classification: 'failed' } }], pagination: { hasMore: false, total: 1 } };
			},
		};
		const mastra = { observability: { flush: async () => {} }, getStorage: () => ({ getStore: async () => store }) };
		expect(await dispatch(conversation.value, operatorMessage('thread-a', 'request-2', 'What happened?'), async context => await followup(context, undefined, mastra))).toMatchObject({ status: 'found', targetKind: 'preceding_request', incident: { component: 'sendblue-channel', stage: 'reply_delivery', traceReference: { traceId: 'failed-snapshot-trace', spanId: 'failed-snapshot-span' } } });
		await dispatch(conversation.value, operatorMessage('thread-a', 'request-error', 'Status?'), async (context, observed) => {
			await snapshot(context, observed, { stopped: ['postgres'] });
			await observed.post(GENERIC_CHANNEL_ERROR);
		});
		expect(await dispatch(conversation.value, operatorMessage('thread-a', 'request-after-error', 'What happened?'), async context => await followup(context))).toMatchObject({ status: 'unavailable', targetKind: 'preceding_request', evidenceGaps: ['observability_flush_failed'] });

		await dispatch(conversation.value, operatorMessage('thread-a', 'request-3', 'Status?'), async (context, observed) => {
			await snapshot(context, observed, { stopped: ['postgres'] });
			await observed.post('Snapshot');
		});
		const forged = await dispatch(conversation.value, operatorMessage('thread-a', 'request-4', 'Wrong clue'), async context => await followup(context, { subject: 'docker', container: 'app' }));
		expect(forged).toMatchObject({ status: 'not_found', evidenceGaps: ['no_matching_incident', 'monitoring_finding_not_found'] });
		expect(await dispatch(conversation.value, operatorMessage('thread-a', 'request-5', 'Now the postgres one'), async context => await followup(context))).toMatchObject({ status: 'unavailable', evidenceGaps: ['monitoring_snapshot_unavailable'] });

		await dispatch(conversation.value, operatorMessage('thread-a', 'request-6', 'Status?'), async (context, observed) => {
			await snapshot(context, observed, { stopped: ['postgres'] });
			await observed.post('Snapshot');
		});
		clearDeploymentSnapshot('thread-a'); // A fresh process has no in-memory snapshot.
		expect(await dispatch(conversation.value, operatorMessage('thread-a', 'request-7', 'What happened?'), async context => await followup(context))).toMatchObject({ status: 'unavailable', evidenceGaps: ['monitoring_snapshot_unavailable'] });

		await dispatch(conversation.value, operatorMessage('thread-a', 'request-8', 'Status?'), async (context, observed) => {
			await snapshot(context, observed, { stopped: ['postgres'] });
			await observed.post('Snapshot');
		});
		await dispatch(conversation.value, operatorMessage('thread-a', 'request-9', 'Unrelated message'), async (_, observed) => {
			await observed.post('Hello');
		});
		expect(await dispatch(conversation.value, operatorMessage('thread-a', 'request-10', 'What happened?'), async context => await followup(context))).toMatchObject({ status: 'unavailable', evidenceGaps: ['monitoring_snapshot_unavailable'] });
	});

	test('allows only one clarification reply and invalidates a failed clarification delivery', async () => {
		const conversation = thread('thread-a');
		await dispatch(conversation.value, operatorMessage('thread-a', 'request-1', 'Status?'), async (context, observed) => {
			await snapshot(context, observed, { stopped: ['app', 'postgres'] });
			await observed.post('Two findings');
		});
		await dispatch(conversation.value, operatorMessage('thread-a', 'request-2', 'What happened?'), async (context, observed) => {
			expect(await followup(context)).toMatchObject({ status: 'ambiguous' });
			await observed.post('Which container?');
		});
		await dispatch(conversation.value, operatorMessage('thread-a', 'request-3', 'The Docker one'), async (context, observed) => {
			expect(await followup(context, { subject: 'docker' })).toMatchObject({ status: 'ambiguous' });
			await observed.post('Still ambiguous');
		});
		expect(await dispatch(conversation.value, operatorMessage('thread-a', 'request-4', 'Postgres'), async context => await followup(context, { container: 'postgres' }))).toMatchObject({ status: 'unavailable', evidenceGaps: ['monitoring_snapshot_unavailable'] });

		await dispatch(conversation.value, operatorMessage('thread-a', 'request-5', 'Status?'), async (context, observed) => {
			await snapshot(context, observed, { stopped: ['app', 'postgres'] });
			await observed.post('Two findings');
		});
		conversation.setFailPost(true);
		await expect(dispatch(conversation.value, operatorMessage('thread-a', 'request-6', 'What happened?'), async (context, observed) => {
			expect(await followup(context)).toMatchObject({ status: 'ambiguous' });
			await observed.post('Which container?');
		})).rejects.toThrow(raw);
		conversation.setFailPost(false);
		expect(await dispatch(conversation.value, operatorMessage('thread-a', 'request-7', 'Postgres'), async context => await followup(context, { container: 'postgres' }))).toMatchObject({ status: 'unavailable', targetKind: 'preceding_request', evidenceGaps: ['observability_flush_failed'] });
	});

	test('isolates concurrent threads and retains an exact Fantasy week without a raw row', async () => {
		const a = thread('thread-a');
		const b = thread('thread-b');
		await dispatch(a.value, operatorMessage('thread-a', 'a-1', 'Status?'), async (context, observed) => {
			await snapshot(context, observed, { stopped: ['postgres'] });
			await observed.post('A snapshot');
		});
		expect(await dispatch(b.value, operatorMessage('thread-b', 'b-0', 'What happened there?'), async context => await followup(context))).toMatchObject({ status: 'unavailable', evidenceGaps: ['monitoring_snapshot_unavailable'] });
		await dispatch(b.value, operatorMessage('thread-b', 'b-1', 'Status?'), async (context, observed) => {
			await snapshot(context, observed, { fantasyFailure: true });
			await observed.post('B snapshot');
		});
		const bResult = await dispatch(b.value, operatorMessage('thread-b', 'b-2', 'What happened?'), async context => await followup(context));
		expect(bResult).toMatchObject({ status: 'found', incident: { component: 'fantasy-weekly-recap', humanDomainReference: 'week 4', stage: 'reply_delivery', classification: 'delivery_failed', occurrenceTimeUtc: at } });
		expect(JSON.stringify(bResult)).not.toContain(raw);
		const aResult = await dispatch(a.value, operatorMessage('thread-a', 'a-2', 'What happened?'), async context => await followup(context));
		expect(aResult).toMatchObject({ status: 'found', incident: { component: 'docker', stage: 'postgres_container' } });
	});
});
