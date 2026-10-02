import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

import { LocalFilesystem, Workspace } from '@mastra/core/workspace';

// An unavailable capability must not stop unrelated requests or fall back to the checkout.
export async function createProjectWorkspace(path = process.env.PROJECT_VIEW_PATH) {
	if (!path || !isAbsolute(path))
		return undefined;
	try {
		const basePath = await realpath(path);
		const preparedAt = (await readFile(join(basePath, '.prepared-at'), 'utf8')).trim();
		if (new Date(preparedAt).toISOString() !== preparedAt)
			return undefined;
		return new Workspace({
			id: 'project-understanding',
			name: 'Approved project files',
			filesystem: new LocalFilesystem({
				basePath,
				contained: true,
				readOnly: true,
				instructions: ({ defaultInstructions }) => `${defaultInstructions} Approved checkout view prepared at ${preparedAt}. This does not prove the running build.`,
			}),
		});
	}
	catch {
		return undefined;
	}
}
