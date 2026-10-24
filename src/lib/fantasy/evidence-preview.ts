import { SQL } from 'bun';

import type { ChatWindow } from './chat-archive';
import type { FantasyConfig } from './config';
import type { EvidenceOptions, RecapEvidencePacket } from './recap-evidence';

import { evidenceReadOnlyDatabaseUrl, openRecapArchive } from './archive';
import { chatWindowSchema } from './chat-archive';
import { createNflSourceTask } from './nfl-sources-task';
import { collectRecapEvidence } from './recap-evidence';

export interface EvidencePreviewResult {
	status: 'ready' | 'partial' | 'blocked';
	packet: RecapEvidencePacket | null;
	reason: string | null;
	databaseUnchanged: boolean;
}

export { evidenceReadOnlyDatabaseUrl } from './archive';

async function recapState(sql: SQL, schema: string, leagueId: string): Promise<string> {
	// Fixed-width per-row digests retain duplicates and deterministic ordering without exporting rows.
	const rows = await sql.unsafe(`
		SELECT 'generations' AS name, count(*)::text AS count,
			md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) AS hash
		FROM "${schema}".fantasy_recap_generations t WHERE league_id = $1
		UNION ALL
		SELECT 'runs' AS name, count(*)::text AS count,
			md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) AS hash
		FROM "${schema}".fantasy_recap_runs t WHERE league_id = $1
		ORDER BY name
	`, [leagueId]) as Array<{ name: string; count: string; hash: string }>;
	if (rows.length !== 2 || rows.some(row => !/^\d+$/.test(row.count) || !/^[a-f0-9]{32}$/.test(row.hash)))
		throw new Error('preview_recap_state_unavailable');
	return JSON.stringify(rows);
}

/** Read-only candidate composition, deliberately separate from scheduled/legacy generation. */
export async function previewRecapEvidence(
	request: {
		config: FantasyConfig;
		week: number;
		window?: ChatWindow | null;
		databaseUrl: string;
		firecrawlApiKey?: string;
	},
	fixture: Pick<EvidenceOptions, 'sleeper' | 'now' | 'readWindow' | 'abortSignal'> & { schemaName?: string } = {},
	afterCollection?: (packet: RecapEvidencePacket) => Promise<void>,
): Promise<EvidencePreviewResult> {
	const blocked = (reason: string, databaseUnchanged = false): EvidencePreviewResult => ({
		status: 'blocked',
		packet: null,
		reason,
		databaseUnchanged,
	});
	let result = blocked('preview_database_unavailable');
	let sql: SQL | undefined;
	let storage: Awaited<ReturnType<typeof openRecapArchive>> | undefined;
	let failure = 'invalid_preview_scope';
	try {
		const now = fixture.now ?? (() => new Date());
		const instant = now();
		const window = chatWindowSchema.safeParse(request.window);
		const schema = fixture.schemaName ?? 'public';
		if (!Number.isSafeInteger(request.week) || request.week < 1 || request.week > 22
			|| !Number.isFinite(instant.getTime()) || (request.window !== undefined
				&& (!window.success || window.data.endAtUtc > instant.toISOString()))
			|| !request.config.sleeperLeagueId?.trim() || !request.config.sendblueGroupId?.trim()
			|| !/^[a-z_]\w*$/i.test(schema)) {
			return blocked('invalid_preview_scope');
		}

		failure = 'invalid_preview_database_url';
		const readonlyURL = evidenceReadOnlyDatabaseUrl(request.databaseUrl);
		failure = 'preview_database_unavailable';
		sql = new SQL(readonlyURL, { connectionTimeout: 5 });
		const [setting] = await sql`SHOW default_transaction_read_only`;
		if (setting?.default_transaction_read_only !== 'on')
			return blocked('preview_database_not_readonly');
		failure = 'preview_recap_state_unavailable';
		const before = await recapState(sql, schema, request.config.sleeperLeagueId);

		failure = 'preview_archive_unavailable';
		storage = await openRecapArchive(readonlyURL, schema);
		const memory = storage.memory;

		let task: ReturnType<typeof createNflSourceTask> | undefined;
		const apiKey = request.firecrawlApiKey;
		let packet: RecapEvidencePacket | null = null;
		let candidateFailed = false;
		try {
			packet = await collectRecapEvidence({
				config: request.config,
				week: request.week,
				window: window.success ? window.data : undefined,
			}, {
				memory: {
					getThreadById: input => memory.getThreadById(input),
					listMessages: input => memory.listMessages(input),
				},
				sleeper: fixture.sleeper,
				now,
				readWindow: fixture.readWindow,
				abortSignal: fixture.abortSignal,
				readNfl: apiKey?.trim()
					? async (input, currentSeason) => {
						task ??= createNflSourceTask({ apiKey, currentSeason });
						return task(input);
					}
					: undefined,
			});
			if (packet.admission.canDraft && afterCollection) {
				try {
					await afterCollection(packet);
				} catch {
					candidateFailed = true;
				}
			}
		} catch {
			// Still compare recap state when collection fails; do not expose source/storage errors.
		}
		failure = 'preview_recap_state_unavailable';
		const after = await recapState(sql, schema, request.config.sleeperLeagueId);
		if (before !== after) {
			// Concurrent writers may be responsible; this is observation, not attribution.
			result = blocked('recap_state_changed_during_preview');
		} else if (!packet) {
			result = blocked('preview_collection_failed', true);
		} else if (candidateFailed) {
			result = blocked('preview_candidate_failed', true);
		} else {
			result = {
				status: packet.status,
				packet,
				reason: packet.status === 'blocked' ? 'evidence_blocked' : null,
				databaseUnchanged: true,
			};
		}
	} catch {
		result = blocked(failure);
	} finally {
		const closed = await Promise.allSettled([
			Promise.resolve().then(() => storage?.close()),
			Promise.resolve().then(() => sql?.close()),
		]);
		if (closed.some(close => close.status === 'rejected') && result.status !== 'blocked')
			result = blocked('preview_cleanup_failed', result.databaseUnchanged);
	}
	return result;
}
