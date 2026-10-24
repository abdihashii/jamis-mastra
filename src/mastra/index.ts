import { ObservabilityStorageClickhouseVNext } from '@mastra/clickhouse';
import { Mastra } from '@mastra/core';
import { SimpleAuth } from '@mastra/core/server';
import { MastraCompositeStore } from '@mastra/core/storage';
import {
	MastraStorageExporter,
	Observability,
	// MastraPlatformExporter,
} from '@mastra/observability';
import { PostgresStore } from '@mastra/pg';

import { DEFAULT_RECAP_MODEL } from '../lib/fantasy/generate';
import { createFantasyFootballPundit } from './agents/fantasy-football-pundit';
import { createJamisAgent } from './agents/jamis';
import { registerLinearReplyProcedure, SENDBLUE_CORRELATION_KEY } from './channels/sendblue';
import { requireEnv, requireOperatorTimeZone } from './env';
import { openAICodexGateway } from './gateways/openai-codex-gateway.js';
import { createProjectLogger, filterProjectTrace, protectProjectSignals, spanOutputProcessors } from './observability';
import { deploymentEvidenceTool } from './tools/deployment-evidence';
import { fantasyWeeklyRecapWorkflow } from './workflows/fantasy-weekly-recap';
import { linearReplyApiAdmission } from './workflows/linear-reply';

requireOperatorTimeZone();

export const mastra = new Mastra({
	logger: createProjectLogger(),
	gateways: { 'openai-codex': openAICodexGateway },
	tools: { deploymentEvidence: deploymentEvidenceTool },
	server: {
		middleware: [linearReplyApiAdmission],
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
					protectProjectSignals(new MastraStorageExporter()),
					// new MastraPlatformExporter(), // needs MASTRA_PLATFORM_ACCESS_TOKEN
				],
				spanOutputProcessors,
				spanFilter: filterProjectTrace,
			},
		},
	}),
});

mastra.addAgent(createJamisAgent({ mastra }), 'jamis');
// The Pundit has no channels wired; it exists only for the weekly recap workflow.
mastra.addAgent(createFantasyFootballPundit(DEFAULT_RECAP_MODEL), 'fantasy-football-pundit');
mastra.addWorkflow(fantasyWeeklyRecapWorkflow, 'fantasyWeeklyRecap');
registerLinearReplyProcedure(mastra);
