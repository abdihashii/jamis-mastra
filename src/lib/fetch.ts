/**
 * GET a URL and parse its JSON body. Aborts propagate untouched; network
 * failures are rethrown as an Error naming the host.
 *
 * @param url - URL to fetch
 * @param signal - Optional abort signal
 * @param headers - Optional request headers (e.g. Gmail's Bearer token)
 * @param logFailure - Disable raw transport logging when the caller owns safe failure reporting
 * @returns Status plus parsed body; `json` is `null` on bad JSON
 */
export async function fetchJson(
	url: string,
	signal?: AbortSignal,
	headers?: Record<string, string>,
	logFailure = true,
): Promise<{ ok: boolean; status: number; json: unknown }> {
	try {
		const response = await fetch(url, { signal, headers });
		const json = await response.json().catch(() => {
			signal?.throwIfAborted();
			return null;
		});
		return { ok: response.ok, status: response.status, json };
	} catch (error) {
		if (signal?.aborted)
			throw signal.reason ?? error;
		if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
			throw error;
		}
		// ponytail: server-side detail only; the thrown class stays provider-free
		if (logFailure)
			console.error(`[fetch] ${new URL(url).host} unreachable:`, error);
		throw new Error('Service unreachable.');
	}
}
