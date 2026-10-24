import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { MastraWorker } from '@mastra/core/worker';
import { FantasyDebugMaintenance } from './generation-maintenance';

interface FakeTimer {
	fire: () => void;
	delay: number | undefined;
	unref: ReturnType<typeof mock>;
}

function deferred() {
	let resolve!: () => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function fakeTimers() {
	const intervals: FakeTimer[] = [];
	const timeouts: FakeTimer[] = [];
	const interval = spyOn(globalThis, 'setInterval').mockImplementation(((fire: () => void, delay?: number) => {
		const timer = { fire, delay, unref: mock() };
		intervals.push(timer);
		return timer;
	}) as unknown as typeof setInterval);
	const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((fire: () => void, delay?: number) => {
		const timer = { fire, delay, unref: mock() };
		timeouts.push(timer);
		return timer;
	}) as unknown as typeof setTimeout);
	const clearIntervalSpy = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
	const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
	return {
		intervals,
		timeouts,
		clearIntervalSpy,
		clearTimeoutSpy,
		restore() {
			for (const spy of [interval, timeout, clearIntervalSpy, clearTimeoutSpy]) spy.mockRestore();
		},
	};
}

let clock: ReturnType<typeof fakeTimers>;
let fetchGuard: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
beforeEach(() => {
	clock = fakeTimers();
	const rejectNetwork = () => {
		throw new Error('unexpected_fixture_network');
	};
	fetchGuard = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(rejectNetwork, { preconnect: rejectNetwork }));
});
afterEach(() => {
	clock.restore();
	const calls = fetchGuard.mock.calls.length;
	fetchGuard.mockRestore();
	expect(calls).toBe(0);
});

describe('FantasyDebugMaintenance', () => {
	it('runs startup and daily cleanup without Mastra init, config, cron, models, tools, workflows, or storage', async () => {
		const purgePayloads = mock(async () => 2);
		const purgeExports = mock(async () => 1);
		const worker = new FantasyDebugMaintenance({ purgePayloads, purgeExports });
		expect(worker).toBeInstanceOf(MastraWorker);
		expect(worker.name).toBe('fantasy-debug-maintenance');
		expect(worker.isRunning).toBe(false);
		expect(purgePayloads).not.toHaveBeenCalled();
		expect(purgeExports).not.toHaveBeenCalled();
		await worker.start();
		await worker.start();
		expect(worker.isRunning).toBe(true);
		expect(purgePayloads).toHaveBeenCalledTimes(1);
		expect(purgeExports).toHaveBeenCalledTimes(1);
		expect(clock.intervals).toHaveLength(1);
		expect(clock.intervals[0]!.delay).toBe(86_400_000);
		expect(clock.intervals[0]!.unref).toHaveBeenCalledTimes(1);
		for (let day = 0; day < 2; day++) {
			clock.intervals[0]!.fire();
			await worker.start();
		}
		expect(purgePayloads).toHaveBeenCalledTimes(3);
		expect(purgeExports).toHaveBeenCalledTimes(3);
		await worker.stop();
		await worker.stop();
		expect(worker.isRunning).toBe(false);
		expect(clock.clearIntervalSpy).toHaveBeenCalledWith(clock.intervals[0]);
		clock.intervals[0]!.fire();
		expect(purgePayloads).toHaveBeenCalledTimes(3);
		expect(purgeExports).toHaveBeenCalledTimes(3);
		expect(clock.timeouts).toHaveLength(0);
	});

	it('shares simultaneous starts and skips daily ticks until both independent purges settle', async () => {
		const payloads = deferred();
		const exports = deferred();
		const purgePayloads = mock(() => payloads.promise);
		const purgeExports = mock(() => exports.promise);
		const worker = new FantasyDebugMaintenance({ purgePayloads, purgeExports });
		const first = worker.start();
		const second = worker.start();
		expect(purgeExports).toHaveBeenCalledTimes(1);
		clock.intervals[0]!.fire();
		payloads.resolve();
		await payloads.promise;
		clock.intervals[0]!.fire();
		expect(purgePayloads).toHaveBeenCalledTimes(1);
		expect(purgeExports).toHaveBeenCalledTimes(1);
		expect(clock.intervals).toHaveLength(1);
		exports.resolve();
		await Promise.all([first, second]);
		clock.intervals[0]!.fire();
		await worker.start();
		expect(purgePayloads).toHaveBeenCalledTimes(2);
		expect(purgeExports).toHaveBeenCalledTimes(2);
		await worker.stop();
	});

	it.each(['purgePayloads', 'purgeExports'] as const)('contains %s failures with a fixed warning and still runs the other purge', async (failing) => {
		const actions = { purgePayloads: mock(async () => 0), purgeExports: mock(async () => 0) };
		actions[failing].mockImplementationOnce(() => {
			throw new Error('PRIVATE payload /private/export postgres://secret');
		});
		const warning = spyOn(console, 'warn').mockImplementation(() => {});
		const worker = new FantasyDebugMaintenance(actions);
		try {
			await worker.start();
			expect(actions.purgePayloads).toHaveBeenCalledTimes(1);
			expect(actions.purgeExports).toHaveBeenCalledTimes(1);
			expect(warning.mock.calls).toEqual([['fantasy_debug_maintenance_failed']]);
			clock.intervals[0]!.fire();
			await worker.start();
			expect(actions.purgePayloads).toHaveBeenCalledTimes(2);
			expect(actions.purgeExports).toHaveBeenCalledTimes(2);
			expect(warning).toHaveBeenCalledTimes(1);
		} finally {
			await worker.stop();
			warning.mockRestore();
		}
	});

	it('contains asynchronous rejections and a throwing warning sink without passing exception data', async () => {
		const purgePayloads = mock(async () => {
			throw new Error('PRIVATE payload');
		});
		const purgeExports = mock(async () => {
			throw new Error('PRIVATE export');
		});
		const warn = mock(() => {
			throw new Error('PRIVATE warning sink');
		});
		const worker = new FantasyDebugMaintenance({ purgePayloads, purgeExports, warn });
		await worker.start();
		expect(purgePayloads).toHaveBeenCalledTimes(1);
		expect(purgeExports).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls).toEqual([[], []]);
		await worker.stop();
	});

	it('stops scheduling immediately and drains in-flight work before the deadline', async () => {
		const pending = deferred();
		const purgePayloads = mock(() => pending.promise);
		const purgeExports = mock(async () => 0);
		const worker = new FantasyDebugMaintenance({ purgePayloads, purgeExports });
		const starting = worker.start();
		let drained = false;
		const stopping = worker.stop({ drainTimeout: 25 }).then(() => {
			drained = true;
		});
		expect(worker.isRunning).toBe(false);
		expect(clock.timeouts[0]!.delay).toBe(25);
		clock.intervals[0]!.fire();
		await Promise.resolve();
		expect(drained).toBe(false);
		expect(purgePayloads).toHaveBeenCalledTimes(1);
		expect(purgeExports).toHaveBeenCalledTimes(1);
		pending.resolve();
		await Promise.all([starting, stopping]);
		expect(drained).toBe(true);
		expect(clock.clearTimeoutSpy).toHaveBeenCalledWith(clock.timeouts[0]);
		clock.intervals[0]!.fire();
		expect(purgePayloads).toHaveBeenCalledTimes(1);
	});

	it.each([undefined, 0, 25])('bounds draining at %s without pretending to cancel work or overlapping on restart', async (drainTimeout) => {
		const pending = deferred();
		const purgePayloads = mock(() => pending.promise);
		const purgeExports = mock(async () => 0);
		const warn = mock();
		const worker = new FantasyDebugMaintenance({ purgePayloads, purgeExports, warn });
		const starting = worker.start();
		const stopping = worker.stop({ drainTimeout });
		expect(clock.timeouts[0]!.delay).toBe(drainTimeout ?? 5_000);
		clock.timeouts[0]!.fire();
		await stopping;
		expect(worker.isRunning).toBe(false);
		expect(warn.mock.calls).toEqual([[]]);
		clock.intervals[0]!.fire();
		const restarting = worker.start();
		clock.intervals[1]!.fire();
		expect(purgePayloads).toHaveBeenCalledTimes(1);
		expect(purgeExports).toHaveBeenCalledTimes(1);
		pending.reject(new Error('PRIVATE late rejection'));
		await Promise.all([starting, restarting]);
		expect(warn.mock.calls).toEqual([[], []]);
		purgePayloads.mockResolvedValue(undefined);
		clock.intervals[1]!.fire();
		await worker.start();
		expect(purgePayloads).toHaveBeenCalledTimes(2);
		expect(purgeExports).toHaveBeenCalledTimes(2);
		await worker.stop();
	});

	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('rejects invalid drain timeout %s', async (drainTimeout) => {
		const worker = new FantasyDebugMaintenance({ purgePayloads: async () => 0, purgeExports: async () => 0 });
		await expect(worker.stop({ drainTimeout })).rejects.toThrow('invalid_fantasy_debug_drain_timeout');
		expect(clock.timeouts).toHaveLength(0);
	});
});
