/**
 * GET a URL and parse its JSON body. Aborts propagate untouched; network
 * failures are rethrown as an Error naming the host.
 *
 * @param url - URL to fetch
 * @param signal - Optional abort signal
 * @returns Status plus parsed body; `json` is `null` on bad JSON
 */
export async function fetchJson(url: string, signal?: AbortSignal): Promise<{ ok: boolean; status: number; json: unknown }> {
	try {
		const response = await fetch(url, { signal });
		const json = await response.json().catch(() => null);
		return { ok: response.ok, status: response.status, json };
	}
	catch (error) {
		if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
			throw error;
		}
		const host = new URL(url).host;
		throw new Error(`Request to ${host} failed: ${error instanceof Error ? error.message : error}`);
	}
}
