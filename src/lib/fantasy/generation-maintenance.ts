import type { WorkerStopOptions } from '@mastra/core/worker';
import { MastraWorker } from '@mastra/core/worker';

/** The caller supplies the existing private-payload and managed-export purges, with bounded I/O. */
export class FantasyDebugMaintenance extends MastraWorker {
	readonly name = 'fantasy-debug-maintenance';
	private timer?: ReturnType<typeof setInterval>;
	private inFlight?: Promise<void>;

	constructor(private readonly actions: {
		purgePayloads: () => Promise<unknown>;
		purgeExports: () => Promise<unknown>;
		warn?: () => void;
	}) {
		super();
	}

	get isRunning(): boolean {
		return this.timer !== undefined;
	}

	async start(): Promise<void> {
		if (this.isRunning) {
			await this.inFlight;
			return;
		}
		this.timer = setInterval(() => {
			void this.purge();
		}, 86_400_000);
		this.timer.unref();
		await this.purge();
	}

	async stop({ drainTimeout = 5_000 }: WorkerStopOptions = {}): Promise<void> {
		if (!Number.isFinite(drainTimeout) || drainTimeout < 0 || drainTimeout > 2_147_483_647)
			throw new RangeError('invalid_fantasy_debug_drain_timeout');
		clearInterval(this.timer);
		this.timer = undefined;
		if (!this.inFlight)
			return;

		// This bounds only the wait, not the I/O. Keep unfinished purges tracked even after the drain expires.
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.warn();
				resolve();
			}, drainTimeout);
			void this.inFlight!.then(() => {
				clearTimeout(timeout);
				resolve();
			});
		});
	}

	private purge(): Promise<void> {
		if (!this.isRunning)
			return Promise.resolve();
		if (!this.inFlight) {
			this.inFlight = Promise.all([this.actions.purgePayloads, this.actions.purgeExports].map(async (purge) => {
				try {
					await purge();
				} catch {
					this.warn();
				}
			})).then(() => { this.inFlight = undefined; });
		}
		return this.inFlight;
	}

	private warn(): void {
		try {
			if (this.actions.warn)
				this.actions.warn();
			else
				console.warn('fantasy_debug_maintenance_failed');
		} catch {
			// A failing warning sink must not break cleanup or leak its exception.
		}
	}
}
