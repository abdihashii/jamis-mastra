import type { EditorialOutcome } from './editorial-loop';
import type { RecapEvidencePacket } from './recap-evidence';
import { previewRecapEvidence } from './evidence-preview';

export interface CandidatePreviewResult {
	status: 'approved' | 'blocked';
	reason: string | null;
	packet: RecapEvidencePacket | null;
	outcome: EditorialOutcome | null;
	counts: EditorialOutcome['counts'];
	databaseUnchanged: boolean;
}

async function prepareCandidate(packet: RecapEvidencePacket, signal?: AbortSignal): Promise<EditorialOutcome> {
	// No app entrypoint, scheduler, registered roots or writable storage in this runtime.
	const [{ Mastra }, { noopLogger }, { openAICodexGateway }, { createFantasyEditorialProcedure }] = await Promise.all([
		import('@mastra/core'),
		import('@mastra/core/logger'),
		import('../../mastra/gateways/openai-codex-gateway'),
		import('../../mastra/workflows/prepare-fantasy-recap'),
	]);
	const mastra = new Mastra({ logger: noopLogger, gateways: { openaiCodex: openAICodexGateway } });
	return createFantasyEditorialProcedure(mastra)(packet, signal);
}

/** The existing read-only owner surrounds collection AND every writer/reviewer invocation. */
export async function previewRecapCandidate(
	request: Parameters<typeof previewRecapEvidence>[0],
	fixture: Parameters<typeof previewRecapEvidence>[1] & {
		prepare?: typeof prepareCandidate;
	} = {},
): Promise<CandidatePreviewResult> {
	const work: { outcome: EditorialOutcome | null } = { outcome: null };
	const evidence = await previewRecapEvidence(request, fixture, async (packet) => {
		work.outcome = await (fixture.prepare ?? prepareCandidate)(packet, fixture.abortSignal);
	});
	const counts = { ...(work.outcome?.counts ?? { drafts: 0, reviews: 0 }) };
	// Never expose an approved draft after an unverified/changed DB interval or failed cleanup.
	if (evidence.status === 'blocked' || !evidence.databaseUnchanged) {
		return { status: 'blocked', reason: evidence.reason, packet: evidence.packet, outcome: null, counts, databaseUnchanged: evidence.databaseUnchanged };
	}
	if (!work.outcome)
		return { status: 'blocked', reason: 'candidate_unavailable', packet: evidence.packet, outcome: null, counts, databaseUnchanged: true };
	const completed = work.outcome;
	return { status: completed.status, reason: completed.status === 'blocked' ? completed.reason : null, packet: evidence.packet, outcome: completed, counts, databaseUnchanged: true };
}
