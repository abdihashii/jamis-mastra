import { Buffer } from 'node:buffer';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

export async function checkedProjectPath(root: string, path: string) {
	let target = root;
	for (const part of path === '.' ? [] : path.split('/')) {
		target = join(target, part);
		const stat = await lstat(target);
		if (!(stat.isDirectory() || stat.isFile()))
			throw new Error('denied');
	}
	return target;
}
// Shared wire policy only: this module must not import app initialization or dependencies.
export const limits = {
	wallMs: 10000,
	streamBytes: 65536,
	expressionBytes: 4096,
	jsonBytes: 4 * 1024 * 1024,
	requestBytes: 6 * 1024 * 1024,
	responseBytes: 512 * 1024,
};
export interface ProjectView { generation: string; preparedAt: string }
export type Operation = { operation: 'search' | 'files' | 'count'; path: string; pattern: string; globs?: string[]; ignoreCase?: boolean; literal?: boolean } | { operation: 'jq'; path: string; filter: string };
export type Failure = 'denied' | 'missing' | 'unavailable' | 'invalid' | 'limit' | 'busy';
export type Result = { ok: true; operation: Operation['operation']; path: string; view: ProjectView; output: string | string[] | number } | { ok: false; error: Failure };
export interface Status { instance: string; mode: 'rg' | 'jq'; view: ProjectView; idle: boolean }
export function isView(value: unknown): value is ProjectView {
	if (!value || typeof value !== 'object' || Object.keys(value).some(k => !['generation', 'preparedAt'].includes(k)))
		return false;
	const v = value as ProjectView;
	return typeof v.generation === 'string' && /^view-[a-zA-Z0-9-]+$/.test(v.generation) && typeof v.preparedAt === 'string' && Number.isFinite(Date.parse(v.preparedAt)) && new Date(v.preparedAt).toISOString() === v.preparedAt;
}
export function sameView(a: ProjectView, b: ProjectView) {
	return a.generation === b.generation && a.preparedAt === b.preparedAt;
}
export function relativePath(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= limits.expressionBytes && !value.includes('\0') && !value.includes('\\') && !value.startsWith('/') && (value === '.' || value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
}
export function validOperation(value: unknown): value is Operation {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return false;
	const op = value as Operation;
	const jq = op.operation === 'jq';
	if (!jq && !['search', 'files', 'count'].includes(op.operation))
		return false;
	const keys = jq ? ['operation', 'path', 'filter'] : ['operation', 'path', 'pattern', 'globs', 'ignoreCase', 'literal'];
	const expression = jq ? op.filter : op.pattern;
	return Object.keys(op).every(key => keys.includes(key)) && relativePath(op.path)
		&& typeof expression === 'string' && !expression.includes('\0') && Buffer.byteLength(expression) <= limits.expressionBytes
		&& (jq || ((op.ignoreCase === undefined || typeof op.ignoreCase === 'boolean') && (op.literal === undefined || typeof op.literal === 'boolean')
			&& (op.globs === undefined || (Array.isArray(op.globs) && op.globs.length <= 16 && op.globs.every(g => typeof g === 'string' && g.length > 0 && Buffer.byteLength(g) <= limits.expressionBytes && !g.includes('\0') && !g.includes('\\') && !g.startsWith('/') && !g.split('/').includes('..'))))));
}
