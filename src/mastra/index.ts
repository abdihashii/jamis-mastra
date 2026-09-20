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

import { createFantasyAgent, DEFAULT_RECAP_MODEL } from '../fantasy/generate';
import { jamis } from './agents/jamis';
import { SENDBLUE_CORRELATION_KEY } from './channels/sendblue';
import { requireEnv, requireOperatorTimeZone } from './env';
import { openAICodexGateway } from './gateways/openai-codex-gateway.js';
import { redactChannelRenderContext } from './observability';
import { fantasyWeeklyRecapWorkflow } from './workflows/fantasy-weekly-recap';

requireOperatorTimeZone();

export const mastra = new Mastra({
	// 'fantasy' has no channels wired; it exists only for the weekly recap workflow.
	// Jamis keeps its own delegation agents (including fantasy-broadcast) on its agent config.
	agents: { jamis, fantasy: createFantasyAgent(DEFAULT_RECAP_MODEL) },
	workflows: { fantasyWeeklyRecap: fantasyWeeklyRecapWorkflow },
	gateways: { 'openai-codex': openAICodexGateway },
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
				requestContextKeys: [SENDBLUE_CORRELATION_KEY],
				exporters: [
					new MastraStorageExporter(),
					// new MastraPlatformExporter(), // needs MASTRA_PLATFORM_ACCESS_TOKEN
				],
				spanOutputProcessors: [
					redactChannelRenderContext,
					new SensitiveDataFilter(),
				],
			},
		},
	}),
});
