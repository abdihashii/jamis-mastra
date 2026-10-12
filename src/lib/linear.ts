import process from 'node:process';
import { z } from 'zod';

const configSchema = z.object({
	LINEAR_CLIENT_ID: z.string().trim().min(1),
	LINEAR_CLIENT_SECRET: z.string().trim().min(1),
	LINEAR_TEAM_ID: z.uuid(),
});
const tokenSchema = z.object({
	access_token: z.string().min(1),
	token_type: z.literal('Bearer'),
	expires_in: z.number().int().positive().max(2_592_000),
	scope: z.string(),
});
const evidenceSchema = z.object({
	data: z.object({
		viewer: z.object({ id: z.uuid(), name: z.string().min(1).max(200), app: z.boolean() }),
		team: z.object({ id: z.uuid(), name: z.string().min(1).max(200), key: z.string().min(1).max(100) }),
	}),
	errors: z.array(z.unknown()).optional(),
});

const cursorSchema = z.string().min(1).max(512);
export const linearReadInputSchema = z.object({
	action: z.enum(['list', 'search', 'issue', 'comments', 'attachments']),
	query: z.string().trim().min(1).max(200).optional(),
	reference: z.string().trim().min(1).max(200).optional(),
	stateType: z.enum(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']).optional(),
	state: z.string().trim().min(1).max(100).optional(),
	priority: z.number().int().min(0).max(4).optional(),
	assigneeId: z.uuid().optional(),
	limit: z.number().int().min(1).max(20).default(10),
	cursor: cursorSchema.optional(),
}).strict().superRefine((input, ctx) => {
	const collection = input.action === 'list' || input.action === 'search';
	if ((input.action === 'search') !== (input.query !== undefined)
		|| collection === (input.reference !== undefined)
		|| (!collection && [input.stateType, input.state, input.priority, input.assigneeId].some(value => value !== undefined))
		|| (input.action === 'issue' && input.cursor !== undefined)) {
		ctx.addIssue({
			code: 'custom',
			message: 'Use query only for search, reference only for issue/comments/attachments, and filters only for list/search.',
		});
	}
});
const issueSchema = z.object({
	id: z.uuid(),
	identifier: z.string().max(100).regex(/^[A-Z][A-Z0-9]*-\d+$/),
	title: z.string().max(512),
	url: z.url().max(2048).refine(url => new URL(url).origin === 'https://linear.app'),
	state: z.object({ name: z.string().max(100), type: z.string().max(100) }),
	updatedAt: z.iso.datetime(),
	team: z.object({ id: z.uuid() }),
});
const commentSchema = z.object({
	id: z.uuid(),
	body: z.string(),
	createdAt: z.iso.datetime(),
	url: z.url().max(2048).refine(url => new URL(url).origin === 'https://linear.app'),
	user: z.object({ name: z.string().max(200) }).nullable(),
	issue: z.object({ id: z.uuid(), team: z.object({ id: z.uuid() }) }),
});
const attachmentSchema = z.object({
	id: z.uuid(),
	title: z.string().max(512),
	url: z.url().max(2048).refine(url => ['https:', 'http:'].includes(new URL(url).protocol)),
	issue: z.object({ id: z.uuid(), team: z.object({ id: z.uuid() }) }),
});
const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: cursorSchema.nullable() })
	.refine(page => !page.hasNextPage || page.endCursor !== null);
function connection<T extends z.ZodType>(node: T) {
	return z.object({ nodes: z.array(node).max(20), pageInfo: pageInfoSchema });
}
export const linearReadResultSchema = z.object({
	status: z.enum(['ok', 'not_found', 'ambiguous', 'denied', 'unavailable']),
	partial: z.boolean(),
	nextCursor: cursorSchema.nullable(),
	issues: z.array(issueSchema).max(20).optional(),
	issue: issueSchema.extend({ description: z.string().nullable(), truncated: z.boolean() }).optional(),
	comments: z.array(commentSchema.omit({ issue: true }).extend({ truncated: z.boolean() })).max(20).optional(),
	attachments: z.array(attachmentSchema.omit({ issue: true })).max(20).optional(),
	reason: z.enum([
		'configuration',
		'authentication',
		'identity',
		'team',
		'response',
		'timeout',
		'unavailable',
		'outside_team',
	]).optional(),
});
export type LinearReadInput = z.input<typeof linearReadInputSchema>;
export type LinearReadResult = z.infer<typeof linearReadResultSchema>;
const ISSUE_FIELDS = 'id identifier title url state { name type } updatedAt team { id }';
const PAGE_FIELDS = 'pageInfo { hasNextPage endCursor }';

export const linearCreateInputSchema = z.object({
	action: z.literal('create'),
	title: z.string().trim().min(1).max(200),
	description: z.string().max(2000).default(''),
	state: z.string().trim().min(1).max(100).optional(),
}).strict();
const workflowStateSchema = z.object({
	id: z.uuid(),
	name: z.string().min(1).max(100),
	team: z.object({ id: z.uuid() }),
});
export const linearCreateOperationSchema = z.object({
	id: z.uuid(),
	teamId: z.uuid(),
	title: linearCreateInputSchema.shape.title,
	description: linearCreateInputSchema.shape.description,
	stateId: z.uuid(),
	stateName: z.string().min(1).max(100),
}).strict();
export type LinearCreateOperation = z.infer<typeof linearCreateOperationSchema>;
export const linearCreateOutcomeSchema = z.object({
	status: z.enum(['succeeded', 'failed', 'uncertain']),
	identifier: issueSchema.shape.identifier.optional(),
	url: issueSchema.shape.url.optional(),
}).strict();
export type LinearCreateOutcome = z.infer<typeof linearCreateOutcomeSchema>;
export const linearCreateInspectionSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('unresolved') }).strict(),
	z.object({
		status: z.literal('verified'),
		operation: linearCreateOperationSchema,
		outcome: linearCreateOutcomeSchema.extend({
			status: z.literal('succeeded'),
			identifier: issueSchema.shape.identifier,
			url: issueSchema.shape.url,
		}),
	}).strict(),
]);
export type LinearCreateInspection = z.infer<typeof linearCreateInspectionSchema>;

type Failure
	= 'configuration' | 'authentication' | 'identity' | 'team' | 'response' | 'timeout' | 'unavailable';

/** Only fixed categories leave this boundary, never upstream bodies or causes. */
export class LinearError extends Error {
	constructor(public readonly category: Failure) {
		super(`Linear ${category} failure.`);
		this.name = 'LinearError';
	}
}

/** Runtime-only app token. Writable clients are created only at the confirmed channel boundary. */
export function createLinearClient(
	env: Record<string, string | undefined> = process.env,
	writable = false,
) {
	const parsed = configSchema.safeParse(env);
	if (!parsed.success)
		throw new LinearError('configuration');
	const config = parsed.data;
	// All app clients use identical scopes: changing scopes revokes existing app tokens.
	const scopes = 'read,issues:create';
	let token: { access: string; expiresAt: number } | undefined;
	let pendingToken: Promise<string> | undefined;

	async function request(url: string, init: RequestInit): Promise<unknown> {
		const timeout = AbortSignal.timeout(10_000);
		const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
		try {
			const response = await fetch(url, { ...init, signal, redirect: 'error' });
			if (response.status === 401 || response.status === 403) {
				token = undefined;
				throw new LinearError('authentication');
			}
			if (!response.ok) {
				throw new LinearError(
					url.endsWith('/oauth/token') && response.status === 400
						? 'authentication'
						: 'unavailable',
				);
			}
			return await response.json().catch(() => {
				throw new LinearError(signal.aborted ? 'timeout' : 'response');
			});
		}
		catch (error) {
			if (error instanceof LinearError)
				throw error;
			throw new LinearError(signal.aborted ? 'timeout' : 'unavailable');
		}
	}

	async function getToken(): Promise<string> {
		if (token && Date.now() < token.expiresAt)
			return token.access;
		if (!pendingToken) {
			pendingToken = (async () => {
				const startedAt = Date.now();
				const result = tokenSchema.safeParse(await request('https://api.linear.app/oauth/token', {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({
						grant_type: 'client_credentials',
						scope: scopes,
						client_id: config.LINEAR_CLIENT_ID,
						client_secret: config.LINEAR_CLIENT_SECRET,
					}),
				}));
				if (
					!result.success
					|| result.data.scope.trim().split(
						/[,\s]+/,
					).sort().join(',') !== 'issues:create,read'
				) {
					throw new LinearError('response');
				}
				token = { access: result.data.access_token, expiresAt: startedAt + result.data.expires_in * 1000 - 60_000 };
				return token.access;
			})();
		}
		try {
			return await pendingToken;
		}
		finally {
			pendingToken = undefined;
		}
	}

	async function graphql<T extends z.ZodType>(
		query: string,
		variables: Record<string, unknown>,
		schema: T,
		signal?: AbortSignal,
	): Promise<z.infer<T>> {
		const access = await getToken();
		const envelope = z.object({ data: z.unknown(), errors: z.array(z.unknown()).optional() }).safeParse(
			await request('https://api.linear.app/graphql', {
				method: 'POST',
				signal,
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access}` },
				body: JSON.stringify({ query, variables }),
			}),
		);
		if (!envelope.success || envelope.data.errors?.length)
			throw new LinearError('response');
		const result = schema.safeParse(envelope.data.data);
		if (!result.success)
			throw new LinearError('response');
		return result.data;
	}

	async function readIdentityAndTeam(signal?: AbortSignal) {
		const { viewer, team } = await graphql(
			'query JamisIdentityAndTeam($teamId: String!) { viewer { id name app } team(id: $teamId) { id name key } }',
			{ teamId: config.LINEAR_TEAM_ID },
			evidenceSchema.shape.data,
			signal,
		);
		if (!viewer.app || viewer.name.toLowerCase() !== 'jamis')
			throw new LinearError('identity');
		if (team.id !== config.LINEAR_TEAM_ID || team.name !== 'jamis')
			throw new LinearError('team');
		return { viewer, team };
	}

	function assertTeam(issues: Array<z.infer<typeof issueSchema>>) {
		if (issues.some(issue => issue.team.id !== config.LINEAR_TEAM_ID))
			throw new LinearError('team');
	}

	async function readIssues(raw: LinearReadInput, signal?: AbortSignal): Promise<LinearReadResult> {
		const parsed = linearReadInputSchema.safeParse(raw);
		if (!parsed.success)
			throw new LinearError('configuration');
		const input = parsed.data;
		const { team } = await readIdentityAndTeam(signal);
		const filter: Record<string, unknown> = { team: { id: { eq: team.id } } };
		if (input.state || input.stateType) {
			filter.state = {
				...(input.state ? { name: { eq: input.state } } : {}),
				...(input.stateType ? { type: { eq: input.stateType } } : {}),
			};
		}
		if (input.priority !== undefined)
			filter.priority = { eq: input.priority };
		if (input.assigneeId)
			filter.assignee = { id: { eq: input.assigneeId } };
		const empty = { partial: false, nextCursor: null } as const;
		const collection = input.action === 'list' || input.action === 'search';
		const ref = input.reference;
		const identifier = ref?.match(/^([A-Z][A-Z0-9]*)-(\d+)$/i);
		if (identifier && identifier[1].toUpperCase() !== team.key)
			return { status: 'denied', reason: 'outside_team', ...empty };
		const uuid = z.uuid().safeParse(ref).success;
		const fuzzy = !collection && !identifier && !uuid;
		if (uuid)
			filter.id = { eq: ref };
		if (identifier)
			filter.number = { eq: Number(identifier[2]) };
		if (identifier && !Number.isSafeInteger(Number(identifier[2])))
			throw new LinearError('configuration');
		const search = input.action === 'search' || fuzzy;
		const page = await graphql(
			search
				? `query JamisSearch($filter: IssueFilter!, $first: Int!, $after: String, $term: String!) { results: searchIssues(filter: $filter, first: $first, after: $after, term: $term) { nodes { ${ISSUE_FIELDS} } ${PAGE_FIELDS} } }`
				: `query JamisList($filter: IssueFilter!, $first: Int!, $after: String) { results: issues(filter: $filter, first: $first, after: $after) { nodes { ${ISSUE_FIELDS} } ${PAGE_FIELDS} } }`,
			{ filter, first: collection ? input.limit : 2, after: collection ? input.cursor : undefined, ...(search ? { term: input.query ?? ref } : {}) },
			z.object({ results: connection(issueSchema) }),
			signal,
		);
		assertTeam(page.results.nodes);
		const { nodes, pageInfo } = page.results;
		if (nodes.length > (collection ? input.limit : 2))
			throw new LinearError('response');
		const paging = { partial: pageInfo.hasNextPage, nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null };
		if (collection)
			return { status: 'ok', issues: nodes, ...paging };
		if (nodes.length === 0)
			return { status: 'not_found', ...empty };
		if (fuzzy || nodes.length !== 1 || pageInfo.hasNextPage)
			return { status: 'ambiguous', issues: nodes, partial: paging.partial, nextCursor: null };
		const resolved = nodes[0];
		if ((uuid && resolved.id !== ref!.toLowerCase()) || (identifier && resolved.identifier !== ref!.toUpperCase()))
			throw new LinearError('response');
		const fields = input.action === 'issue'
			? 'description'
			: input.action === 'comments'
				? `comments(first: $first, after: $after) { nodes { id body createdAt url user { name } issue { id team { id } } } ${PAGE_FIELDS} }`
				: `attachments(first: $first, after: $after) { nodes { id title url issue { id team { id } } } ${PAGE_FIELDS} }`;
		const schema = input.action === 'issue'
			? issueSchema.extend({ description: z.string().nullable() })
			: input.action === 'comments'
				? issueSchema.extend({ comments: connection(commentSchema) })
				: issueSchema.extend({ attachments: connection(attachmentSchema) });
		const result = await graphql(
			`query JamisIssue($id: String!${input.action === 'issue' ? '' : ', $first: Int!, $after: String'}) { issue(id: $id) { ${ISSUE_FIELDS} ${fields} } }`,
			{ id: resolved.id, ...(input.action === 'issue' ? {} : { first: input.limit, after: input.cursor }) },
			z.object({ issue: schema }),
			signal,
		);
		assertTeam([result.issue]);
		if (result.issue.id !== resolved.id)
			throw new LinearError('response');
		if ('description' in result.issue) {
			const truncated = (result.issue.description?.length ?? 0) > 8000;
			return {
				status: 'ok',
				issue: {
					...result.issue,
					description: result.issue.description?.slice(0, 8000) ?? null,
					truncated,
				},
				partial: truncated,
				nextCursor: null,
			};
		}
		const data = 'comments' in result.issue ? result.issue.comments : result.issue.attachments;
		if (data.nodes.length > input.limit)
			throw new LinearError('response');
		if (data.nodes.some(node => node.issue.id !== resolved.id || node.issue.team.id !== team.id))
			throw new LinearError('team');
		const pageResult = {
			partial: data.pageInfo.hasNextPage,
			nextCursor: data.pageInfo.hasNextPage ? data.pageInfo.endCursor : null,
		};
		if ('comments' in result.issue) {
			const comments = result.issue.comments.nodes.map(({
				issue: _issue,
				body,
				...comment
			}) => ({ ...comment, body: body.slice(0, 4000), truncated: body.length > 4000 }));
			return {
				status: 'ok',
				comments,
				...pageResult,
				partial: pageResult.partial || comments.some(comment => comment.truncated),
			};
		}
		return {
			status: 'ok',
			attachments: result.issue.attachments.nodes.map(({ issue: _issue, ...attachment }) => attachment),
			...pageResult,
		};
	}

	async function prepareCreate(raw: z.input<typeof linearCreateInputSchema>): Promise<LinearCreateOperation> {
		const input = linearCreateInputSchema.safeParse(raw);
		if (!input.success)
			throw new LinearError('configuration');
		const { team } = await readIdentityAndTeam();
		let state: z.infer<typeof workflowStateSchema>;
		if (input.data.state) {
			const result = await graphql(
				'query JamisCreateState($filter: WorkflowStateFilter!) { workflowStates(filter: $filter, first: 2) { nodes { id name team { id } } pageInfo { hasNextPage } } }',
				{ filter: { team: { id: { eq: team.id } }, name: { eq: input.data.state } } },
				z.object({
					workflowStates: z.object({
						nodes: z.array(workflowStateSchema).max(2),
						pageInfo: z.object({ hasNextPage: z.boolean() }),
					}),
				}),
			);
			if (result.workflowStates.nodes.length !== 1 || result.workflowStates.pageInfo.hasNextPage)
				throw new LinearError('response');
			state = result.workflowStates.nodes[0];
			if (state.name !== input.data.state)
				throw new LinearError('response');
		}
		else {
			const result = await graphql(
				'query JamisDefaultCreateState($id: String!) { team(id: $id) { id defaultIssueState { id name team { id } } } }',
				{ id: team.id },
				z.object({ team: z.object({ id: z.uuid(), defaultIssueState: workflowStateSchema }) }),
			);
			if (result.team.id !== team.id)
				throw new LinearError('team');
			state = result.team.defaultIssueState;
		}
		if (state.team.id !== team.id)
			throw new LinearError('team');
		return {
			id: crypto.randomUUID(),
			teamId: team.id,
			title: input.data.title,
			description: input.data.description,
			stateId: state.id,
			stateName: state.name,
		};
	}

	async function executeCreate(raw: LinearCreateOperation): Promise<LinearCreateOutcome> {
		const operation = linearCreateOperationSchema.safeParse(raw);
		if (!writable || !operation.success || operation.data.teamId !== config.LINEAR_TEAM_ID)
			return { status: 'failed' };
		const op = operation.data;
		// One retry is safe here: no mutation has been sent during this preflight.
		for (let attempt = 0; ; attempt++) {
			try {
				await readIdentityAndTeam();
				const result = await graphql(
					'query JamisValidateCreateState($id: String!) { workflowState(id: $id) { id name team { id } } }',
					{ id: op.stateId },
					z.object({ workflowState: workflowStateSchema }),
				);
				if (
					result.workflowState.id !== op.stateId
					|| result.workflowState.name !== op.stateName
					|| result.workflowState.team.id !== op.teamId
				) {
					return { status: 'failed' };
				}
				break;
			}
			catch (error) {
				if (
					attempt === 0
					&& error instanceof LinearError
					&& ['authentication', 'timeout', 'unavailable'].includes(error.category)
				) {
					continue;
				}
				return { status: 'failed' };
			}
		}
		try {
			const { stateName: _stateName, ...input } = op;
			const result = await graphql(
				`mutation JamisCreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
				{ input },
				z.object({ issueCreate: z.object({ success: z.boolean(), issue: issueSchema.nullable() }) }),
			);
			const issue = result.issueCreate.issue;
			if (
				!result.issueCreate.success
				|| !issue
				|| issue.id !== op.id
				|| issue.team.id !== op.teamId
				|| issue.title !== op.title
				|| issue.state.name !== op.stateName
			) {
				return { status: 'uncertain' };
			}
			return { status: 'succeeded', identifier: issue.identifier, url: issue.url };
		}
		catch {
			// Sent requests, partial errors, malformed/lost responses: never replay.
			return { status: 'uncertain' };
		}
	}

	async function inspectCreate(raw: LinearCreateOperation): Promise<LinearCreateInspection> {
		const op = linearCreateOperationSchema.parse(raw);
		try {
			const { team } = await readIdentityAndTeam();
			if (team.id !== op.teamId)
				return { status: 'unresolved' };
			const result = await graphql(
				'query JamisInspectCreate($id: String!) { issue(id: $id) { id identifier title description url team { id } state { id name } } }',
				{ id: op.id },
				z.object({
					issue: z.object({
						id: z.uuid(),
						identifier: issueSchema.shape.identifier,
						title: z.string(),
						description: z.string().nullable(),
						url: issueSchema.shape.url,
						team: z.object({ id: z.uuid() }),
						state: z.object({ id: z.uuid(), name: z.string() }),
					}).nullable(),
				}),
			);
			const issue = result.issue;
			if (
				!issue
				|| issue.id !== op.id
				|| issue.team.id !== op.teamId
				|| issue.title !== op.title
				|| (issue.description ?? '') !== op.description
				|| issue.state.id !== op.stateId
				|| issue.state.name !== op.stateName
			) {
				return { status: 'unresolved' };
			}
			return {
				status: 'verified',
				operation: op,
				outcome: { status: 'succeeded', identifier: issue.identifier, url: issue.url },
			};
		}
		catch { return { status: 'unresolved' }; }
	}

	return { readIdentityAndTeam, readIssues, prepareCreate, executeCreate, inspectCreate };
}
