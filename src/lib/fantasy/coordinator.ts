import type { MastraDBMessage } from '@mastra/core/memory';

import type { WeekFacts } from './analysis';

import type { FantasyConfig } from './config';
import type { SendClient } from './deliver';
import type { ChatContextMessage, RecapShaping } from './generate';
import type { RecapGenerationRecord } from './recaps';
import type { RecapFailureClassification, RecapFailureStage, RunsStore } from './runs';
import type { SleeperManager } from './sleeper';
import { createHash, randomUUID } from 'node:crypto';

import { FANTASY_GENERATOR_VERSION, ShapingValidationError, toChatContext, validateShaping } from './generate';
import { renderWeekRecap } from './render';

const LEASE_MS = 15 * 60 * 1000;

export type CoordinatorOutcome
	= | 'sent'
		| 'failed'
		| 'delivery_unknown'
		| 'noop-already-sent'
		| 'noop-no-completed-week'
		| 'blocked-active-claim'
		| 'blocked-delivery-unknown';

export interface CoordinatorResult {
	outcome: CoordinatorOutcome;
	week: number | null;
	error?: string;
}

export interface RecapsStore {
	ensureSchema: () => Promise<void>;
	record: (record: RecapGenerationRecord, claimToken: string) => Promise<boolean>;
}

export interface CoordinatorDeps {
	runs: RunsStore;
	recaps: RecapsStore;
	groupId: string;
	leagueId: string;
	/** Archived group messages, newest first; `since` filters to messages after that instant. */
	readThreadMessages: (since?: Date) => Promise<MastraDBMessage[]>;
	send: SendClient;
	now: () => Date;
}

async function tryDm(send: SendClient, text: string): Promise<void> {
	try {
		await send.directMessage(text);
	} catch (error) {
		// Provider errors can echo request bodies; log status + short message only.
		const status = (error as { status?: number })?.status;
		console.error(`[fantasy-recap] operator DM failed: ${status ? `HTTP ${status} ` : ''}${(error as Error)?.message?.slice(0, 120) ?? error}`);
	}
}

async function alertUnmappedSenders(senders: string[], deps: CoordinatorDeps): Promise<void> {
	for (const sender of senders) {
		const hash = createHash('sha256').update(sender).digest('hex').slice(0, 16);
		const isNew = await deps.runs.alertUnmappedSenderOnce(hash);
		if (isNew)
			await tryDm(deps.send, `[fantasy-recap] a sender in the fantasy group isn't in FANTASY_MANAGER_MAP: ${sender}. They read as "unknown sender" in recaps until mapped.`);
	}
}

/** Structured generation with the plan's single repair attempt for validation failures. */
async function generateWithRepair(
	generate: (facts: WeekFacts, context: ChatContextMessage[]) => Promise<RecapShaping>,
	facts: WeekFacts,
	context: ChatContextMessage[],
): Promise<RecapShaping> {
	try {
		return await generate(facts, context);
	} catch (error) {
		if (!(error instanceof ShapingValidationError))
			throw error;
		console.warn(`[fantasy-recap] shaping rejected (${error.message}); the one repair attempt follows`);
		return generate(facts, context);
	}
}

async function preserveUnknownDelivery(
	week: number,
	claimToken: string,
	error: string,
	deps: CoordinatorDeps,
): Promise<CoordinatorResult> {
	try {
		await deps.runs.markDeliveryUnknown(week, claimToken, error);
	} catch { /* the started lease will expire to delivery_unknown */ }
	await tryDm(deps.send, `[fantasy-recap] week ${week} recap delivery is unknown (${error}). Check the group, then run confirm-sent --week ${week} if it landed, or retry --week ${week} --operator-verified-absent if not.`);
	return { outcome: 'delivery_unknown', week, error };
}

async function failRun(
	week: number,
	claimToken: string,
	error: string,
	stage: RecapFailureStage,
	classification: RecapFailureClassification,
	alert: string,
	deps: CoordinatorDeps,
): Promise<CoordinatorResult> {
	try {
		if (!await deps.runs.markFailed(week, claimToken, error, stage, classification))
			return { outcome: 'blocked-active-claim', week };
	} catch { /* the started lease will expire to a conservative interruption state */ }
	await tryDm(deps.send, alert);
	return { outcome: 'failed', week, error };
}

/** Sends `text` for the claimed week and records the outcome per ADR 0018. Text is persisted first. */
async function deliverStoredText(
	week: number,
	claimToken: string,
	text: string,
	generation: { model: string; facts: WeekFacts } | null,
	deps: CoordinatorDeps,
): Promise<CoordinatorResult> {
	const { runs, send } = deps;
	try {
		if (generation) {
			const recorded = await deps.recaps.record({
				leagueId: deps.leagueId,
				fantasyWeek: week,
				generatorVersion: FANTASY_GENERATOR_VERSION,
				model: generation.model,
				finalText: text,
				facts: generation.facts,
			}, claimToken);
			if (!recorded)
				return { outcome: 'blocked-active-claim', week };
		}
		if (!await runs.recordAttemptText(week, claimToken, text))
			return { outcome: 'blocked-active-claim', week };
	} catch (error) {
		const message = error instanceof Error ? error.message.slice(0, 120) : 'unknown storage failure';
		return failRun(
			week,
			claimToken,
			message,
			'application_storage',
			'execution_failed',
			`[fantasy-recap] week ${week} recap persistence failed (${message}). The daily run retries automatically.`,
			deps,
		);
	}

	const outcome = await send.sendToGroup(deps.groupId, text);
	if (outcome.kind === 'sent') {
		try {
			if (await runs.markSent(week, claimToken, outcome.handle))
				return { outcome: 'sent', week };
		} catch { /* handled as delivery_unknown below */ }
		return preserveUnknownDelivery(week, claimToken, 'delivery result could not be recorded', deps);
	}
	if (outcome.kind === 'failed') {
		return failRun(
			week,
			claimToken,
			outcome.error,
			'reply_delivery',
			'delivery_failed',
			`[fantasy-recap] week ${week} recap failed before Sendblue accepted it (${outcome.error}). The daily run retries automatically.`,
			deps,
		);
	}
	return preserveUnknownDelivery(week, claimToken, outcome.error, deps);
}

export interface RunWeeklyArgs {
	config: FantasyConfig;
	/** null when no completed week exists (normal no-op, not an error). */
	week: number | null;
	/** Loaded only after the completed week is claimed. */
	loadFacts: (() => Promise<{ facts: WeekFacts; managers: SleeperManager[] }>) | null;
	model: string;
	traceId?: string;
	generate: (facts: WeekFacts, context: ChatContextMessage[]) => Promise<RecapShaping>;
}

export async function runWeeklyRecap(args: RunWeeklyArgs, deps: CoordinatorDeps): Promise<CoordinatorResult> {
	const { runs, send } = deps;
	await deps.recaps.ensureSchema();
	await runs.ensureSchema();

	// Crash recovery first: started rows past their lease never learned their fate.
	// One atomic sweep; a live concurrent claim simply loses no row to it.
	for (const stuck of await runs.expireStaleLeases(deps.now(), 'send attempt interrupted; delivery unobservable')) {
		if (stuck.status === 'delivery_unknown')
			await tryDm(send, `[fantasy-recap] week ${stuck.fantasyWeek} send was interrupted (crash or restart). Check the group, then confirm-sent or retry --operator-verified-absent.`);
	}

	const week = args.week;
	if (week == null)
		return { outcome: 'noop-no-completed-week', week: null };

	const existing = await runs.getRun(week);
	if (existing?.status === 'sent')
		return { outcome: 'noop-already-sent', week };
	if (existing?.status === 'delivery_unknown')
		return { outcome: 'blocked-delivery-unknown', week };

	const claimToken = randomUUID();
	const claim = await runs.claimRun(
		week,
		claimToken,
		new Date(deps.now().getTime() + LEASE_MS),
		args.traceId ?? null,
	);
	if (!claim.claimed)
		return { outcome: claim.run?.status === 'delivery_unknown' ? 'blocked-delivery-unknown' : 'blocked-active-claim', week };

	// Safe failure + stored text: retry the identical stored text, never regenerate
	// (ADR 0018). A failed row from a pre-send error has no text and regenerates.
	if (claim.run?.finalText)
		return deliverStoredText(week, claimToken, claim.run.finalText, null, deps);

	let failureStage: RecapFailureStage = 'scheduled_job';
	try {
		const { facts, managers } = await args.loadFacts!();
		failureStage = 'application_storage';
		// Chat window: after the previous sent recap, or everything (bounded) for the first.
		const since = (await runs.latestSentRunBefore(week))?.sentAt ?? undefined;
		const rawMessages = await deps.readThreadMessages(since);
		const context = toChatContext(rawMessages, args.config, managers);
		const unmapped = new Set<string>();
		for (const message of rawMessages) {
			const sender = (message.content.metadata as Record<string, unknown> | undefined)?.senderNumber;
			if (typeof sender === 'string' && !args.config.managerMap[sender])
				unmapped.add(sender);
		}
		await alertUnmappedSenders([...unmapped], deps);

		failureStage = 'model';
		const shaping = await generateWithRepair(args.generate, facts, context);
		validateShaping(shaping, context, facts);
		const text = renderWeekRecap(facts, shaping, context);

		return await deliverStoredText(week, claimToken, text, { model: args.model, facts }, deps);
	} catch (error) {
		// Shaping messages carry only field labels/ids; other errors (LLM/provider) get the
		// tighter slice because error text can echo prompt content towards traces/DB/DM.
		const bound = error instanceof ShapingValidationError ? 300 : 120;
		const message = error instanceof Error ? error.message.slice(0, bound) : 'unknown failure';
		const label = failureStage === 'scheduled_job'
			? 'facts unavailable'
			: failureStage === 'application_storage' ? 'supporting state unavailable' : 'could not be generated';
		return failRun(
			week,
			claimToken,
			message,
			failureStage,
			'execution_failed',
			`[fantasy-recap] week ${week} recap ${label}: ${message}`,
			deps,
		);
	}
}

export type RetryResult
	= | { ok: true; week: number; outcome: 'sent' | 'failed' | 'delivery_unknown' }
		| { ok: false; reason: string };

/**
 * Resends the exact stored text, never regenerates. Refuses stale weeks and
 * un-cleared delivery-unknown states.
 */
export async function retryWeek(
	week: number,
	operatorVerifiedAbsent: boolean,
	deps: CoordinatorDeps,
): Promise<RetryResult> {
	const { runs } = deps;
	await runs.ensureSchema();
	const run = await runs.getRun(week);
	if (!run || !run.finalText)
		return { ok: false, reason: `week ${week} has no stored recap to resend` };
	if (run.status === 'sent')
		return { ok: false, reason: `week ${week} was already sent` };
	if (run.status === 'started')
		return { ok: false, reason: `week ${week} has an active send claim` };
	if (run.status === 'delivery_unknown' && !operatorVerifiedAbsent)
		return { ok: false, reason: `week ${week} delivery is unknown; check the group first, then retry with --operator-verified-absent (or confirm-sent if it landed)` };
	if (await runs.hasNewerActiveRun(week))
		return { ok: false, reason: `a newer week already has an active recap; week ${week} is stale and cannot retry` };

	const claimToken = randomUUID();
	const storedText = await runs.claimForRetry(week, claimToken, new Date(deps.now().getTime() + LEASE_MS));
	if (storedText == null)
		return { ok: false, reason: `week ${week} was claimed concurrently; try again` };

	const result = await deliverStoredText(week, claimToken, storedText, null, deps);
	if (result.outcome === 'blocked-active-claim')
		return { ok: false, reason: `week ${week} lost its send claim` };
	return { ok: true, week, outcome: result.outcome as 'sent' | 'failed' | 'delivery_unknown' };
}

export async function confirmSent(week: number, deps: CoordinatorDeps): Promise<boolean> {
	await deps.runs.ensureSchema();
	return deps.runs.confirmSentByOperator(week);
}
