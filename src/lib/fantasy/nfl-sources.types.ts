import type { NflSourceInput } from './nfl-sources.schema';

export type NflSourceRecord
	= | { kind: 'injury'; sourceId: string; gsisId: string | null; name: string; position: string; team: string; sourceDate: string | null; designation: string | null; injuries: string[]; practiceInjuries: string[]; practiceStatus: string | null; practiceDays: Array<{ date: string; status: string }> }
		| { kind: 'news-summary'; sourceId: string; title: string; description: string | null; summary: string | null; url: string; publishedAtUtc: string | null; updatedAtUtc: string | null }
		| { kind: 'weekly-result'; sourceId: string; name: string; teamName: string; position: string; opponent: string; projectedPoints: number | null; actualPoints: number | null; actualStats: Record<string, number>; kickoffAtUtc: string | null; status: string };

export interface NflSourceResult {
	status: 'success' | 'partial' | 'empty' | 'blocked' | 'terms_required' | 'access_denied'
		| 'upstream_error' | 'unknown_outcome' | 'invalid_response';
	trust: 'untrusted-source-data';
	requestId: string | null;
	catalogueRequestId: string | null;
	quotedCredits: number | null;
	credits: number | null;
	adminActionUrl: string | null;
	chargeIdPresent: boolean;
	gaps: string[];
	source: null | {
		provider: string;
		capability: string;
		scope: NflSourceInput;
		url: string;
		retrievedAtUtc: string;
		observedAtUtc: string;
		sourceDate: string | null;
		snapshotAsOfUtc: null;
		licenseState: 'unknown';
		coverage: 'week-report' | 'recent-headlines' | 'current-season-week';
		scoring: 'STD' | 'HALF' | 'PPR' | null;
		truncated: boolean;
	};
	records: NflSourceRecord[];
}
