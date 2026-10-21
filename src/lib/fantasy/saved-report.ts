import type { EditorialOutcome } from './editorial-loop';
import type { RecapEvidencePacket } from './recap-evidence';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { buildEditorialCandidate, EDITORIAL_MAX_PARTS, EDITORIAL_PART_MAX_LENGTH, EDITORIAL_VERSION } from './editorial';
import { editorialOutcomeSchema } from './editorial-loop';
import { FANTASY_EDITORIAL_MODEL } from './editorial-policy';

export const SAVED_REPORT_VERSION = 'fantasy-saved-report-v1' as const;
export interface SavedReportScope { leagueId: string; groupId: string; season: number; week: number }

const scopeId = z.string().max(500).refine(value => value.trim().length > 0);
const roleSchema = z.object({ model: z.literal(FANTASY_EDITORIAL_MODEL), effort: z.literal('xhigh') }).strict();
const savedReportSchema = z.object({
	version: z.literal(SAVED_REPORT_VERSION),
	id: z.string().regex(/^report-[a-f0-9]{64}$/),
	scope: z.object({
		leagueId: scopeId,
		groupId: scopeId,
		season: z.number().int().min(1920).max(2100),
		week: z.number().int().min(1).max(22),
	}).strict(),
	evidenceId: z.string().regex(/^evidence-[a-f0-9]{64}$/),
	candidateId: z.string().regex(/^candidate-[a-f0-9]{64}$/),
	editorialVersion: z.enum(['fantasy-editorial-v1', EDITORIAL_VERSION]),
	writer: roleSchema,
	reviewer: roleSchema,
	counts: z.object({
		drafts: z.number().int().min(1).max(3),
		reviews: z.number().int().min(1).max(3),
	}).strict().refine(counts => counts.reviews <= counts.drafts),
	parts: z.array(z.string().max(EDITORIAL_PART_MAX_LENGTH).refine(value => value.trim().length > 0))
		.min(1)
		.max(EDITORIAL_MAX_PARTS),
}).strict();
const savedReportContentSchema = savedReportSchema.omit({ id: true });
export type SavedReport = z.infer<typeof savedReportSchema>;

function reportId(content: Omit<SavedReport, 'id'>): string {
	return `report-${createHash('sha256').update(JSON.stringify(content)).digest('hex')}`;
}

function deeplyFrozen(value: unknown): boolean {
	return !value || typeof value !== 'object'
		|| (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen));
}

function freeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Integrity is not outbound authority: delivery still requires a closed grant and durable claim. */
export function parseSavedReport(value: unknown): SavedReport {
	try {
		const report = savedReportSchema.parse(value);
		const { id, ...content } = report;
		if (id !== reportId(content))
			throw new Error('invalid_saved_report');
		// Zod detached every retained object/array before any freeze touches it.
		return freeze(report);
	} catch {
		throw new Error('invalid_saved_report');
	}
}

/** Persist only approved bytes and their binding metadata, never raw evidence, drafts or reviews. */
export function buildSavedReport(packet: RecapEvidencePacket, outcome: EditorialOutcome): SavedReport {
	try {
		if (!deeplyFrozen(packet) || packet.version !== 'fantasy-evidence-v1'
			|| !['ready', 'partial'].includes(packet.status) || packet.admission.canDraft !== true
			|| packet.admission.blockers.length > 0 || packet.gaps.some(gap => gap.blocking)
			|| !packet.league || !packet.facts || typeof packet.scope.season !== 'string'
			|| !/^\d{4}$/.test(packet.scope.season)
			|| packet.scope.leagueId !== packet.league.id || packet.scope.leagueId !== packet.facts.leagueId
			|| packet.scope.season !== packet.league.season || packet.scope.season !== packet.facts.season
			|| packet.scope.week !== packet.facts.week) {
			throw new Error('invalid_saved_report');
		}
		const approved = editorialOutcomeSchema.parse(outcome);
		if (approved.status !== 'approved' || approved.evidenceId !== packet.id
			|| approved.review.verdict !== 'pass' || approved.review.issues.length !== 0
			|| approved.review.evidenceId !== packet.id || approved.review.candidateId !== approved.candidate.id) {
			throw new Error('invalid_saved_report');
		}
		const candidate = approved.candidate;
		const rebuilt = buildEditorialCandidate(packet, candidate.draft);
		if (rebuilt.status !== 'candidate' || candidate.id !== rebuilt.candidate.id
			|| candidate.version !== rebuilt.candidate.version || candidate.evidenceId !== rebuilt.candidate.evidenceId
			|| JSON.stringify(candidate.parts) !== JSON.stringify(rebuilt.candidate.parts)) {
			throw new Error('invalid_saved_report');
		}
		const content = savedReportContentSchema.parse({
			version: SAVED_REPORT_VERSION,
			scope: {
				leagueId: packet.scope.leagueId,
				groupId: packet.scope.groupId,
				season: Number(packet.scope.season),
				week: packet.scope.week,
			},
			evidenceId: packet.id,
			candidateId: candidate.id,
			editorialVersion: candidate.version,
			writer: { model: FANTASY_EDITORIAL_MODEL, effort: 'xhigh' },
			reviewer: { model: FANTASY_EDITORIAL_MODEL, effort: 'xhigh' },
			counts: approved.counts,
			parts: candidate.parts,
		});
		return parseSavedReport({ ...content, id: reportId(content) });
	} catch {
		throw new Error('invalid_saved_report');
	}
}

export function sameSavedReportScope(report: SavedReport, scope: SavedReportScope): boolean {
	return report.scope.leagueId === scope.leagueId && report.scope.groupId === scope.groupId
		&& report.scope.season === scope.season && report.scope.week === scope.week;
}
