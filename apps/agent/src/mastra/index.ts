import { ObservabilityStorageClickhouseVNext } from '@mastra/clickhouse';
import { Mastra } from '@mastra/core';
import { MastraCompositeStore } from '@mastra/core/storage';
import {
	MastraStorageExporter,
	Observability,
	// MastraPlatformExporter,
	SensitiveDataFilter,
} from '@mastra/observability';
import { PostgresStore } from '@mastra/pg';

import { weatherAgent } from './agents/weather-agent';

export const mastra = new Mastra({
	agents: { weatherAgent },
	storage: new MastraCompositeStore({
		id: 'composite-storage',
		default: new PostgresStore({
			id: 'mastra-storage',
			connectionString: process.env.DATABASE_URL!,
		}),
		domains: {
			observability: new ObservabilityStorageClickhouseVNext({
				url: process.env.CLICKHOUSE_URL!,
				username: process.env.CLICKHOUSE_USERNAME!,
				password: process.env.CLICKHOUSE_PASSWORD!,
			}),
		},
	}),
	observability: new Observability({
		configs: {
			default: {
				serviceName: 'mastra',
				exporters: [
					new MastraStorageExporter(), // Persists observability events to Mastra Storage
					// new MastraPlatformExporter(), // Sends observability events to Mastra platform (if MASTRA_PLATFORM_ACCESS_TOKEN is set)
				],
				spanOutputProcessors: [
					new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
				],
			},
		},
	}),
});
