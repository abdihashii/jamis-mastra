import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

import { isView } from './project-cli-contract';

// Resolve current once. A missing descriptor disables CLI, not existing native reads.
export async function pinProjectView(path = process.env.PROJECT_VIEW_PATH) {
	if (!path || !isAbsolute(path))
		return undefined;
	try {
		const basePath = await realpath(path);
		const view: unknown = JSON.parse(await readFile(join(basePath, '.project-view.json'), 'utf8'));
		if (!isView(view) || (await readFile(join(basePath, '.prepared-at'), 'utf8')).trim() !== view.preparedAt)
			return undefined;
		return { basePath, view };
	} catch { return undefined; }
}

// An unavailable capability must not stop unrelated requests or fall back to the checkout.
export async function createProjectWorkspace(path = process.env.PROJECT_VIEW_PATH) {
	if (!path || !isAbsolute(path))
		return undefined;
	try {
		const basePath = await realpath(path);
		const preparedAt = (await readFile(join(basePath, '.prepared-at'), 'utf8')).trim();
		if (new Date(preparedAt).toISOString() !== preparedAt)
			return undefined;
		const { LocalFilesystem, Workspace } = await import('@mastra/core/workspace');
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
	} catch {
		return undefined;
	}
}
