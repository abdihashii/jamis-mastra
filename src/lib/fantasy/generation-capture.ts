import type { FantasyEditorialObserver } from '../../mastra/workflows/prepare-fantasy-recap';
import type { GenerationAttemptRef } from './generation-state';
import type { EvidenceOptions, RecapEvidencePacket } from './recap-evidence';
import type { SqlLike } from './recaps';

import { captureGenerationPacket, recordGenerationOutput, reserveGenerationCall } from './generation-runs';

/**
 * Per-attempt private sink. An optional-source catch cannot turn a failed durable reservation into permission to
 * draft.
 */
export function createGenerationCapture(ref: GenerationAttemptRef, token: string, sql: SqlLike) {
	let failed = false;
	let nflOrdinal = 0;
	const calls = new Map<string, string>();
	function assertHealthy() {
		if (failed)
			throw new Error('generation_capture_unavailable');
	}
	async function persist(action: () => Promise<boolean>) {
		assertHealthy();
		try {
			if (await action())
				return;
		} catch { /* Fail closed without exporting storage errors or private source data. */ }
		failed = true;
		throw new Error('generation_capture_unavailable');
	}
	async function reserve(kind: 'nfl' | 'writer' | 'reviewer', ordinal: number) {
		assertHealthy();
		try {
			const call = await reserveGenerationCall(ref, token, kind, ordinal, sql);
			if (call && call.remainingMs > 0) {
				calls.set(`${kind}:${ordinal}`, call.id);
				return call;
			}
		} catch { /* A reservation acknowledgement is mandatory before dispatch. */ }
		failed = true;
		throw new Error('generation_capture_unavailable');
	}
	const observer: FantasyEditorialObserver = {
		beforeCall: async ({ kind, ordinal }) => {
			const call = await reserve(kind, ordinal);
			return { remainingMs: call.remainingMs };
		},
		output: async ({ kind, ordinal, contributionCase, value }) => {
			const id = calls.get(`${kind}:${ordinal}`);
			await persist(() => id ? recordGenerationOutput(ref, id, contributionCase, value, sql) : Promise.resolve(false));
		},
		failure: async ({ kind, ordinal, code }) => {
			const id = calls.get(`${kind}:${ordinal}`);
			await persist(() => id ? recordGenerationOutput(ref, id, 'failed', null, sql, code) : Promise.resolve(false));
		},
	};
	return {
		observer,
		assertHealthy,
		packet: (packet: RecapEvidencePacket) => persist(() => captureGenerationPacket(ref, token, packet, sql)),
		readNfl: (read: NonNullable<EvidenceOptions['readNfl']>): NonNullable<EvidenceOptions['readNfl']> => async (input, season) => {
			const call = await reserve('nfl', ++nflOrdinal);
			let result;
			try {
				result = await read(input, season);
			} catch {
				await persist(() => recordGenerationOutput(ref, call.id, 'failed', null, sql, 'execution_failed'));
				throw new Error('nfl_execution_failed');
			}
			await persist(() => recordGenerationOutput(ref, call.id, 'completed', result, sql));
			return result;
		},
	};
}
