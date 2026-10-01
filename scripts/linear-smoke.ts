import process from 'node:process';
import { noopObserve } from '@mastra/core/tools';
import { createLinearClient, LinearError, linearReadInputSchema } from '../src/lib/linear';
import { linearReadTool } from '../src/mastra/tools/linear';

try {
	const evidence = await createLinearClient().readIdentityAndTeam();
	console.log(JSON.stringify(evidence, null, 2));
	if (process.argv.includes('--reads')) {
		for (const input of [
			{ action: 'issue', reference: 'JAM-64' },
			{ action: 'comments', reference: 'JAM-64' },
			{ action: 'attachments', reference: 'JAM-64' },
			{ action: 'list', stateType: 'backlog', limit: 1 },
			{ action: 'search', query: 'confirmed access', limit: 2 },
			{ action: 'issue', reference: 'OUTSIDE-1' },
		] as const) {
			const result = await linearReadTool.execute!(linearReadInputSchema.parse(input), { observe: noopObserve });
			if (result && 'status' in result) {
				console.log(JSON.stringify({ action: input.action, status: result.status, partial: result.partial, nextCursor: result.nextCursor, identifier: result.issue?.identifier, state: result.issue?.state, issues: result.issues?.map(issue => issue.identifier), comments: result.comments?.length, attachments: result.attachments?.length, reason: result.reason }));
				if (result.status !== ('reference' in input && input.reference === 'OUTSIDE-1' ? 'denied' : 'ok'))
					throw new Error('Unexpected smoke outcome');
			}
			else {
				throw new Error('Tool rejected smoke input');
			}
		}
	}
}
catch (error) {
	console.error(error instanceof LinearError ? error.message : 'Linear smoke failed.');
	process.exitCode = 1;
}
