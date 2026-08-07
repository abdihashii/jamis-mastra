import process from 'node:process';

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

// Fail at boot rather than handing undefined to a driver. ClickHouse accepts an
// empty password and connects, which hides the misconfiguration until much later.
function requireEnv(name: string): string {
	const value = process.env[name];

	if (!value) {
		throw new Error(`Missing required env var: ${name}`);
	}

	return value;
}

export const mastra = new Mastra({
	agents: { weatherAgent },
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
