import type { PostgresStore } from '@mastra/pg';
import type { EventEmitter } from 'node:events';

import { registerApiRoute, SimpleAuth } from '@mastra/core/server';

type ReadinessClient = Pick<EventEmitter, 'once' | 'removeListener'> & {
	query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
	release: (destroy?: boolean) => void;
};

export function createReadinessServer(store: PostgresStore, token: string) {
	let checking = false;
	return {
		auth: new SimpleAuth({
			tokens: { [token]: { id: 'admin', name: 'admin' } },
			protected: ['/api/*', '/readyz'],
		}),
		apiRoutes: [registerApiRoute('/readyz', {
			method: 'GET',
			handler: async (c) => {
				c.header('Cache-Control', 'no-store');
				if (checking)
					return c.json({ status: 'unavailable' }, 503);
				checking = true;
				const ready = await new Promise<boolean>((resolve) => {
					let client: ReadinessClient | undefined;
					let settled = false;
					let timer: ReturnType<typeof setTimeout>;
					const finish = (success: boolean) => {
						if (settled)
							return;
						settled = true;
						clearTimeout(timer);
						if (client) {
							client.removeListener('error', onError);
							client.release(!success);
							checking = false;
						}
						resolve(success);
					};
					function onError() {
						finish(false);
					}
					timer = setTimeout(onError, 4_000);
					const checkout: Promise<ReadinessClient> = store.pool.connect();
					void checkout.then((connection) => {
						// shortcut: pg cannot cancel checkout; keep one pending slot until pg supports cancellation.
						if (settled) {
							connection.release(true);
							checking = false;
							return;
						}
						client = connection;
						client.once('error', onError);
						void client.query('SELECT 1').then(
							result => finish(result.rows[0]?.['?column?'] === 1),
							onError,
						);
					}, () => {
						checking = false;
						finish(false);
					});
				});
				return ready ? c.json({ status: 'ready' }) : c.json({ status: 'unavailable' }, 503);
			},
		})],
	};
}
