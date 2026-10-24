import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { fantasyApiAdmission } from '../fantasy-api-admission';

const protectedIds = ['fantasyWeeklyRecap', 'fantasy-weekly-recap', 'prepare_fantasy_recap', 'publish_fantasy_recap'];
// Installed native routes, plus replay and unknown future actions: admission is not an action allowlist.
const actions = [
	'',
	'create-run',
	'start',
	'start-async',
	'stream',
	'stream-legacy',
	'resume',
	'resume-async',
	'resume-no-wait',
	'resume-stream',
	'restart',
	'restart-async',
	'restart-all-active-workflow-runs',
	'restart-all-active-workflow-runs-async',
	'time-travel',
	'time-travel-async',
	'time-travel-stream',
	'replay',
	'cancel',
	'runs/example/cancel',
	'runs/example/steps/execute',
	'runs/example',
	'future-action',
];

// Same native Hono middleware boundary as linear-reply.test.ts, without application bootstrap.
function fixture(admission = true) {
	const entered: Array<{ method: string; id: string | undefined; path: string }> = [];
	const app = new Hono();
	if (admission)
		app.use(fantasyApiAdmission.path, fantasyApiAdmission.handler);
	for (const path of ['/api/workflows/:workflowId', '/api/workflows/:workflowId/*']) {
		app.all(path, (context) => {
			entered.push({ method: context.req.method, id: context.req.param('workflowId'), path: context.req.path });
			return context.json({ id: context.req.param('workflowId') });
		});
	}
	app.all('/api/workflows', context => context.json({ workflows: [] }));
	app.all('/api/agents/*', context => context.json({ accepted: true }));
	return { app, entered };
}

describe('fantasy native API admission', () => {
	it.each(protectedIds)('denies every mutation verb and action for %s and encoded equivalents', async (id) => {
		const { app, entered } = fixture();
		const encoded = [...id].map(character => `%${character.charCodeAt(0).toString(16)}`).join('');
		for (const workflowId of [id, encoded, encoded.toUpperCase()]) {
			for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
				for (const action of actions) {
					const response = await app.request(`/api/workflows/${workflowId}${action ? `/${action}` : ''}`, { method });
					expect(response.status).toBe(403);
				}
			}
		}
		expect(entered).toEqual([]);
	});

	it('preserves GET and HEAD inspection, including run state and workflow listing', async () => {
		const { app, entered } = fixture();
		for (const id of protectedIds) {
			for (const action of ['', '/runs', '/runs/example', '/observe']) {
				for (const method of ['GET', 'HEAD']) {
					const response = await app.request(`/api/workflows/${id}${action}`, { method });
					expect(response.status).toBe(200);
				}
			}
		}
		expect(entered).toHaveLength(protectedIds.length * 4 * 2);
		expect((await app.request('/api/workflows')).status).toBe(200);
	});

	it.each(['%', '%GG', '%E0%A4%A', 'fantasyWeeklyRecap%'])('returns 400 for malformed ID encoding %s', async (id) => {
		const { app, entered } = fixture();
		for (const method of ['GET', 'HEAD', 'POST', 'DELETE'])
			expect((await app.request(`/api/workflows/${id}/start`, { method })).status).toBe(400);
		expect(entered).toEqual([]);
	});

	it('matches native decoding without treating encoded slashes, double encoding or case variants as aliases', async () => {
		const guarded = fixture();
		const native = fixture(false);
		const cases = [
			['fantasyWeeklyRecap%2Fstart', 'fantasyWeeklyRecap/start'],
			['fantasyWeeklyRecap%2fstart', 'fantasyWeeklyRecap/start'],
			['%2FfantasyWeeklyRecap', '/fantasyWeeklyRecap'],
			['fantasyWeeklyRecap%252Fstart', 'fantasyWeeklyRecap%2Fstart'],
			['%2566antasyWeeklyRecap', '%66antasyWeeklyRecap'],
			['FantasyWeeklyRecap', 'FantasyWeeklyRecap'],
			['FANTASY-WEEKLY-RECAP', 'FANTASY-WEEKLY-RECAP'],
			['Prepare_fantasy_recap', 'Prepare_fantasy_recap'],
			['PUBLISH_FANTASY_RECAP', 'PUBLISH_FANTASY_RECAP'],
			['fantasyWeeklyRecap-extra', 'fantasyWeeklyRecap-extra'],
		];
		for (const [encoded, decoded] of cases) {
			const path = `/api/workflows/${encoded}/start`;
			for (const { app } of [native, guarded]) {
				const response = await app.request(path, { method: 'POST' });
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ id: decoded });
			}
		}
		expect(guarded.entered).toEqual(native.entered);
	});

	it('uses the router-normalized prefix without widening to unmatched paths or unrelated workflows', async () => {
		const { app, entered } = fixture();
		for (const path of ['/api/%77orkflows/%66antasyWeeklyRecap/start', '/%61pi/workflows/fantasyWeeklyRecap/start'])
			expect((await app.request(path, { method: 'POST' })).status).toBe(403);
		for (const path of ['/API/workflows/fantasyWeeklyRecap/start', '/api/Workflows/fantasyWeeklyRecap/start', '/api%2Fworkflows/fantasyWeeklyRecap/start'])
			expect((await app.request(path, { method: 'POST' })).status).toBe(404);
		for (const id of ['prepare_linear_reply', 'jamis', 'unrelated']) {
			for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
				expect((await app.request(`/api/workflows/${id}/start?workflowId=fantasyWeeklyRecap`, { method })).status).toBe(200);
		}
		for (const method of ['GET', 'POST', 'DELETE']) {
			expect((await app.request('/api/workflows', { method })).status).toBe(200);
			expect((await app.request('/api/agents/jamis/generate', { method })).status).toBe(200);
		}
		expect(entered).toHaveLength(18);
	});
});
