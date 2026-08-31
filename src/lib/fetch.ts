export interface FetchJsonResult {
	ok: boolean;
	status: number;
	json: unknown;
}

export async function fetchJson(url: string, signal?: AbortSignal): Promise<FetchJsonResult> {
	try {
		const response = await fetch(url, { signal });
		const json = await response.json().catch(() => null);
		return { ok: response.ok, status: response.status, json };
	}
	catch (error) {
		if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
			throw error; // let cancellation propagate, don't mask it as a failure
		}
		const host = new URL(url).host;
		throw new Error(`Request to ${host} failed: ${error instanceof Error ? error.message : error}`);
	}
}
