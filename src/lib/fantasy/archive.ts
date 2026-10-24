import { noopLogger } from '@mastra/core/logger';
import { PostgresStore } from '@mastra/pg';

/** Preserve routing options while enforcing read-only access and a bounded statement. */
export function evidenceReadOnlyDatabaseUrl(value: string): string {
	const url = new URL(value);
	if (!['postgres:', 'postgresql:'].includes(url.protocol))
		throw new Error('invalid_preview_database_url');
	const options = url.searchParams.get('options');
	const configured = [...(options ?? '').matchAll(/\bstatement_timeout=(\d+)(ms|s|min|h)?(?=\s|$)/g)].at(-1);
	const milliseconds = configured ? Number(configured[1]) * ({ ms: 1, s: 1000, min: 60_000, h: 3_600_000 }[configured[2] ?? 'ms'] ?? 1) : 0;
	const timeout = milliseconds > 0 && milliseconds <= 15_000 ? '' : '-c statement_timeout=15000';
	url.searchParams.set('options', [options, timeout, '-c default_transaction_read_only=on'].filter(Boolean).join(' '));
	return url.toString();
}

/** Both production collection and previews read the archive without initializing its schema. */
export async function openRecapArchive(value: string, schema = 'public') {
	if (!/^[a-z_]\w*$/i.test(schema))
		throw new Error('archive_scope_invalid');
	const url = new URL(evidenceReadOnlyDatabaseUrl(value));
	url.searchParams.set('connectionTimeoutMillis', '5000');
	const storage = new PostgresStore({ id: 'fantasy-readonly-archive', connectionString: url.toString(), disableInit: true, schemaName: schema });
	storage.__setLogger(noopLogger);
	for (const domain of Object.values(storage.stores)) domain?.__setLogger(noopLogger);
	try {
		const mode = await storage.db.one<{ default_transaction_read_only: string }>('SHOW default_transaction_read_only');
		if (mode.default_transaction_read_only !== 'on')
			throw new Error('archive_not_readonly');
		const memory = await storage.getStore('memory');
		if (!memory)
			throw new Error('archive_unavailable');
		return { memory, close: () => storage.close() };
	} catch {
		try {
			await storage.close();
		} catch { /* Failure still denies collection; no raw storage error is exported. */ }
		throw new Error('archive_unavailable');
	}
}
