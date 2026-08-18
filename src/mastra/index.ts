import { ObservabilityStorageClickhouseVNext } from '@mastra/clickhouse';
import { Mastra } from '@mastra/core';
import { SimpleAuth } from '@mastra/core/server';
import { MastraCompositeStore } from '@mastra/core/storage';
import {
	MastraStorageExporter,
	Observability,
	// MastraPlatformExporter,
	SensitiveDataFilter,
} from '@mastra/observability';
import { PostgresStore } from '@mastra/pg';

import { jamis } from './agents/jamis';
import { requireEnv } from './env';

export const mastra = new Mastra({
	agents: { jamis },
	server: {
		// One token, one operator. SimpleAuth checks Authorization and
		// X-Playground-Access by default, so Studio authenticates with an
		// `Authorization: Bearer` header. No public path exceptions.
		auth: new SimpleAuth({
			tokens: { [requireEnv('API_TOKEN')]: { id: 'admin', name: 'admin' } },
		}),
	},
	storage: new MastraCompositeStore({
		id: 'composite-storage',
		default: new PostgresStore({
			id: 'mastra-storage',
			connectionString: requireEnv('DATABASE_URL'),
		}),
		domains: {
			observability: new ObservabilityStorageClickhouseVNext({
				url: requireEnv('CLICKHOUSE_URL'),
				username: requireEnv('CLICKHOUSE_USERNAME'),
				password: requireEnv('CLICKHOUSE_PASSWORD'),
			}),
		},
	}),
	observability: new Observability({
		configs: {
			default: {
				serviceName: 'mastra',
				exporters: [
					new MastraStorageExporter(),
					// new MastraPlatformExporter(), // needs MASTRA_PLATFORM_ACCESS_TOKEN
				],
				spanOutputProcessors: [
					new SensitiveDataFilter(),
				],
			},
		},
	}),
});
