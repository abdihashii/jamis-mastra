import type { Middleware } from '@mastra/core/server';

const PRIVATE_WORKFLOW_IDS = new Set(['fantasyWeeklyRecap', 'fantasy-weekly-recap', 'prepare_fantasy_recap', 'publish_fantasy_recap']);

/** Defense in depth: native caller grants remain required inside each workflow. */
export const fantasyApiAdmission = {
	path: '/api/workflows/*',
	handler: async (context, next) => {
		let id;
		try {
			// Match Hono's case-sensitive parameter decoding, not decoded path separators.
			id = decodeURIComponent(context.req.path.split('/')[3] ?? '');
		} catch { return new Response('Invalid workflow path.', { status: 400 }); }
		return PRIVATE_WORKFLOW_IDS.has(id) && !['GET', 'HEAD'].includes(context.req.method)
			? new Response('Fantasy recap execution requires the application workflow boundary.', { status: 403 })
			: next();
	},
} satisfies Middleware;
