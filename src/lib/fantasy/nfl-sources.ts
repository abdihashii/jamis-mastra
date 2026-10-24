import { Firecrawl } from 'firecrawl';
import { z } from 'zod';

const clubs = {
	ATL: 'atlanta-falcons',
	AZ: 'arizona-cardinals',
	BAL: 'baltimore-ravens',
	BUF: 'buffalo-bills',
	CAR: 'carolina-panthers',
	CHI: 'chicago-bears',
	CIN: 'cincinnati-bengals',
	CLE: 'cleveland-browns',
	DAL: 'dallas-cowboys',
	DEN: 'denver-broncos',
	DET: 'detroit-lions',
	GB: 'green-bay-packers',
	HOU: 'houston-texans',
	IND: 'indianapolis-colts',
	JAX: 'jacksonville-jaguars',
	KC: 'kansas-city-chiefs',
	LAC: 'los-angeles-chargers',
	LAR: 'los-angeles-rams',
	LV: 'las-vegas-raiders',
	MIA: 'miami-dolphins',
	MIN: 'minnesota-vikings',
	NE: 'new-england-patriots',
	NO: 'new-orleans-saints',
	NYG: 'new-york-giants',
	NYJ: 'new-york-jets',
	PHI: 'philadelphia-eagles',
	PIT: 'pittsburgh-steelers',
	SEA: 'seattle-seahawks',
	SF: 'san-francisco-49ers',
	TB: 'tampa-bay-buccaneers',
	TEN: 'tennessee-titans',
	WAS: 'washington-commanders',
} as const;
const team = z.enum(Object.keys(clubs) as [keyof typeof clubs, ...(keyof typeof clubs)[]]);
const season = z.number().int().min(1920).max(2100);
const week = z.number().int().min(1).max(22);
const position = z.enum(['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'FLX', 'ALL']);
const scoring = z.enum(['STD', 'HALF', 'PPR']);
export const nflSourceInputSchema = z.discriminatedUnion('operation', [
	z.object({ operation: z.literal('injuries'), season, week, team }).strict(),
	z.object({ operation: z.literal('news'), team }).strict(),
	z.object({ operation: z.literal('weekly-results'), season, week, position, scoring }).strict(),
]);
export type NflSourceInput = z.infer<typeof nflSourceInputSchema>;
const routes = {
	'injuries': { provider: 'nfl-com', capability: 'sports-league-data/injury_report', key: '', field: 'reports' },
	'news': { provider: 'nfl-com', capability: 'sports-league-data/news', key: '', field: 'articles' },
	'weekly-results': { provider: 'startwho-com', capability: 'fantasy-sports-rankings/weekly_results', key: 'players', field: 'players' },
} as const;
const text = z.string().min(1).max(200);
const prose = z.string().max(8000);
const credits = z.number().int().nonnegative();
const instant = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString());
const date = z.string().date();
const observed = z.number().int().nonnegative().refine(value => Number.isFinite(new Date(value).getTime()));
const contractSchema = z.object({
	provider: text,
	capability: text,
	creditsCost: credits,
	perRecord: z.literal(false),
	execute: z.object({ provider: text, capability: text }),
	options: z.array(z.object({
		name: text,
		type: text,
		required: z.boolean().optional(),
		min: z.number().optional(),
		max: z.number().optional(),
		oneOf: z.array(z.union([z.string(), z.number()])).optional(),
		pattern: z.string().optional(),
	})).max(30),
	requiresOneOf: z.array(z.array(text)).optional(),
	response: z.object({ key: z.string(), fields: z.array(z.object({ name: text, type: text })) }),
});
const injuryRow = z.object({
	player: z.object({ id: text, gsis_id: text.nullable(), display_name: text, position: text }),
	team: z.object({ abbreviation: team }),
	season,
	week,
	season_type: z.literal('REG'),
	report_date: date.nullable(),
	injury_status: z.enum(['OUT', 'DOUBTFUL', 'QUESTIONABLE']).nullable(),
	injuries: z.array(text).max(20),
	practice_injuries: z.array(text).max(20),
	practice_status: z.enum(['FULL', 'LIMITED', 'DIDNOT']).nullable(),
	practice_days: z.array(z.object({ date, status: z.enum(['FULL', 'LIMITED', 'DIDNOT']) })).max(10),
});
const newsRow = z.object({
	id: text,
	title: text,
	description: prose.nullable(),
	summary: prose.nullable(),
	web_url: z.string().max(2048),
	publish_date: instant.nullable(),
	last_updated: instant.nullable(),
	tags: z.array(z.object({ slug: text })).max(100),
});
const resultRow = z.object({
	player_id: text,
	name: text,
	team: text,
	position: z.enum(['QB', 'RB', 'WR', 'TE', 'K', 'DST']),
	opponent: text,
	projected_points: z.number().finite().nullable(),
	actual_points: z.number().finite().nullable(),
	actual_stats: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.number().finite()),
	game_kickoff_at: instant.nullable(),
	status: z.enum(['final', 'dnp', 'scheduled', 'pending']),
});
export type NflSourceRecord
	= | { kind: 'injury'; sourceId: string; gsisId: string | null; name: string; position: string; team: string; sourceDate: string | null; designation: string | null; injuries: string[]; practiceInjuries: string[]; practiceStatus: string | null; practiceDays: Array<{ date: string; status: string }> }
		| { kind: 'news-summary'; sourceId: string; title: string; description: string | null; summary: string | null; url: string; publishedAtUtc: string | null; updatedAtUtc: string | null }
		| { kind: 'weekly-result'; sourceId: string; name: string; teamName: string; position: string; opponent: string; projectedPoints: number | null; actualPoints: number | null; actualStats: Record<string, number>; kickoffAtUtc: string | null; status: string };
export interface NflSourceResult {
	status: 'success' | 'partial' | 'empty' | 'blocked' | 'terms_required' | 'access_denied'
		| 'upstream_error' | 'unknown_outcome' | 'invalid_response';
	trust: 'untrusted-source-data';
	requestId: string | null;
	catalogueRequestId: string | null;
	quotedCredits: number | null;
	credits: number | null;
	adminActionUrl: string | null;
	chargeIdPresent: boolean;
	gaps: string[];
	source: null | {
		provider: string;
		capability: string;
		scope: NflSourceInput;
		url: string;
		retrievedAtUtc: string;
		observedAtUtc: string;
		sourceDate: string | null;
		snapshotAsOfUtc: null;
		licenseState: 'unknown';
		coverage: 'week-report' | 'recent-headlines' | 'current-season-week';
		scoring: 'STD' | 'HALF' | 'PPR' | null;
		truncated: boolean;
	};
	records: NflSourceRecord[];
}
function empty(): NflSourceResult {
	return {
		status: 'blocked',
		trust: 'untrusted-source-data',
		requestId: null,
		catalogueRequestId: null,
		quotedCredits: null,
		credits: null,
		adminActionUrl: null,
		chargeIdPresent: false,
		gaps: [],
		source: null,
		records: [],
	};
}
function sourceUrl(value: string, provider: string) {
	const url = new URL(value);
	const host = provider === 'nfl-com' ? 'www.nfl.com' : 'startwho.com';
	if (url.protocol !== 'https:' || url.host !== host || url.username || url.password || url.hash)
		throw new Error('Unsupported provenance');
	return url.href;
}
function failure(error: unknown, output: NflSourceResult) {
	const details = z.object({
		code: z.string().optional(),
		status: z.number().optional(),
		chargeId: z.string().optional(),
		requiresAction: z.object({ url: z.string() }).optional(),
	}).safeParse(error);
	output.chargeIdPresent = details.success && Boolean(details.data.chargeId);
	if (details.success && details.data.code === 'THIRD_PARTY_DATA_TERMS_REQUIRED') {
		output.status = 'terms_required';
		const url = details.data.requiresAction?.url;
		if (url === 'https://www.firecrawl.dev/app/settings?tab=data-sources')
			output.adminActionUrl = url;
	} else if (details.success && [401, 403].includes(details.data.status ?? 0)) {
		output.status = 'access_denied';
	} else {
		output.status = output.credits === null ? 'unknown_outcome' : 'upstream_error';
	}
}
function optionsFor(input: NflSourceInput): Record<string, string | number> {
	if (input.operation === 'injuries')
		return { season: input.season, season_type: 'REG', week: input.week, team: input.team };
	if (input.operation === 'news')
		return { tag: clubs[input.team], limit: 10 };
	return { week: input.week, position: input.position, scoring: input.scoring, limit: 100 };
}
function admit(raw: unknown[], input: NflSourceInput) {
	const route = routes[input.operation];
	const identity = z.object({ provider: z.literal(route.provider), capability: z.literal(route.capability) });
	const matches = raw.filter(item => identity.safeParse(item).success);
	if (matches.length !== 1)
		throw new Error('Contract unavailable');
	const contract = contractSchema.parse(matches[0]);
	// A keyed response describes each row's fields, not the containing array.
	const fields = input.operation === 'weekly-results'
		? { player_id: 'string', projected_points: 'number', actual_points: 'number', actual_stats: 'object' }
		: { [route.field]: 'object[]' };
	if (contract.creditsCost !== 5 || contract.execute.provider !== route.provider
		|| contract.execute.capability !== route.capability || contract.response.key !== route.key
		|| Object.entries(fields).some(([name, type]) =>
			!contract.response.fields.some(field => field.name === name && field.type === type))) {
		throw new Error('Unsupported contract or price');
	}
	const options = optionsFor(input);
	if (contract.options.some(option => option.required && !Object.hasOwn(options, option.name))
		|| contract.requiresOneOf?.some(group => !group.some(name => Object.hasOwn(options, name)))) {
		throw new Error('Unsupported required option');
	}
	for (const [name, value] of Object.entries(options)) {
		const entries = contract.options.filter(option => option.name === name);
		if (entries.length !== 1)
			throw new Error('Unsupported option');
		const option = entries[0]!;
		const matchingType = typeof value === 'number' ? option.type === 'number' : option.type === 'string';
		if (!matchingType || (option.oneOf && !option.oneOf.includes(value))
			|| (typeof value === 'number' && (option.min === undefined || option.max === undefined
				|| value < option.min || value > option.max))
			|| option.pattern !== undefined) {
			throw new Error('Unsupported option value');
		}
	}
	return options;
}
function normalize(data: unknown, input: NflSourceInput, output: NflSourceResult, retrievedAtUtc: string) {
	const route = routes[input.operation];
	const envelope = z.object({
		source_url: z.string().max(2048),
		observed_at_ms: observed,
		count: credits,
	}).passthrough().parse(data);
	const maximumRows = input.operation === 'news' ? 10 : input.operation === 'weekly-results' ? 100 : 500;
	const rows = z.array(z.unknown()).max(maximumRows).parse(envelope[route.field]);
	if (envelope.count !== rows.length)
		throw new Error('Inconsistent record count');
	let sourceDate: string | null = null;
	let truncated = false;
	if (input.operation === 'injuries') {
		const scope = z.object({
			season,
			week,
			season_type: z.literal('REG'),
			report_date: date.nullable(),
			team: z.object({ abbreviation: team }),
			weeks_available: z.array(week).max(30),
		}).parse(envelope);
		if (scope.season !== input.season || scope.week !== input.week || scope.team.abbreviation !== input.team)
			throw new Error('Scope mismatch');
		sourceDate = scope.report_date;
		if (!scope.weeks_available.includes(input.week))
			output.gaps.push('week_unavailable');
	} else if (input.operation === 'news') {
		const scope = z.object({
			tag: z.literal(clubs[input.team]),
			next_cursor: z.string().max(4096).nullable(),
			generated_at: instant,
		}).parse(envelope);
		truncated = scope.next_cursor !== null;
	} else {
		const scope = z.object({ season, week, position, scoring, total_count: credits }).parse(envelope);
		if (scope.season !== input.season || scope.week !== input.week || scope.position !== input.position
			|| scope.scoring !== input.scoring || scope.total_count < rows.length) {
			throw new Error('Scope mismatch');
		}
		truncated = scope.total_count > rows.length;
	}
	const url = sourceUrl(envelope.source_url, route.provider);
	if (input.operation === 'injuries' && new URL(url).pathname !== `/injuries/league/${input.season}/reg${input.week}`)
		throw new Error('Provenance scope mismatch');
	if (input.operation === 'weekly-results') {
		const source = new URL(url);
		const format = input.scoring === 'HALF' ? 'Half-PPR' : input.scoring;
		if (source.pathname !== '/api/week-results' || source.searchParams.get('week') !== String(input.week)
			|| source.searchParams.get('format') !== format || source.searchParams.get('position') !== input.position) {
			throw new Error('Provenance scope mismatch');
		}
	}
	output.source = {
		provider: route.provider,
		capability: route.capability,
		scope: input,
		url,
		retrievedAtUtc,
		observedAtUtc: new Date(envelope.observed_at_ms).toISOString(),
		sourceDate,
		// The provider's pregame label is not proof of an immutable pre-kickoff capture.
		snapshotAsOfUtc: null,
		licenseState: 'unknown',
		scoring: input.operation === 'weekly-results' ? input.scoring : null,
		coverage: input.operation === 'injuries' ? 'week-report' : input.operation === 'news' ? 'recent-headlines' : 'current-season-week',
		truncated,
	};
	const ids = new Set<string>();
	let ambiguous = false;
	for (const row of rows) {
		try {
			let record: NflSourceRecord;
			if (input.operation === 'injuries') {
				const item = injuryRow.parse(row);
				if (item.report_date === null)
					output.gaps.push('source_date_unknown');
				if (item.team.abbreviation !== input.team || item.season !== input.season || item.week !== input.week)
					throw new Error('Subject mismatch');
				record = { kind: 'injury', sourceId: item.player.id, gsisId: item.player.gsis_id, name: item.player.display_name, position: item.player.position, team: item.team.abbreviation, sourceDate: item.report_date, designation: item.injury_status, injuries: item.injuries, practiceInjuries: item.practice_injuries, practiceStatus: item.practice_status, practiceDays: item.practice_days };
			} else if (input.operation === 'news') {
				const item = newsRow.parse(row);
				const articleUrl = sourceUrl(item.web_url, route.provider);
				if (!item.tags.some(tag => tag.slug === clubs[input.team]) || !new URL(articleUrl).pathname.startsWith('/news/'))
					throw new Error('Subject mismatch');
				if (item.publish_date === null)
					output.gaps.push('source_date_unknown');
				record = { kind: 'news-summary', sourceId: item.id, title: item.title, description: item.description, summary: item.summary, url: articleUrl, publishedAtUtc: item.publish_date, updatedAtUtc: item.last_updated };
			} else {
				const item = resultRow.parse(row);
				if (item.projected_points === null)
					output.gaps.push('projection_unavailable');
				if (item.game_kickoff_at === null)
					output.gaps.push('kickoff_unavailable');
				if (item.status === 'final' && item.actual_points === null)
					throw new Error('Final result has no actual points');
				const positions = input.position === 'ALL' ? ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] : input.position === 'FLX' ? ['RB', 'WR', 'TE'] : [input.position];
				if (!positions.includes(item.position))
					throw new Error('Subject mismatch');
				record = { kind: 'weekly-result', sourceId: item.player_id, name: item.name, teamName: item.team, position: item.position, opponent: item.opponent, projectedPoints: item.projected_points, actualPoints: item.actual_points, actualStats: item.actual_stats, kickoffAtUtc: item.game_kickoff_at, status: item.status };
			}
			if (ids.has(record.sourceId)) {
				ambiguous = true;
				throw new Error('Ambiguous source identity');
			}
			ids.add(record.sourceId);
			output.records.push(record);
		} catch { output.gaps.push('malformed_record'); }
	}
	if (ambiguous)
		throw new Error('Ambiguous source identity');
	if (truncated)
		output.gaps.push('truncated_results');
	output.gaps = [...new Set(output.gaps)];
	output.status = output.gaps.includes('week_unavailable')
		? 'blocked'
		: rows.length === 0
			? truncated ? 'partial' : 'empty'
			: output.records.length === 0 ? 'invalid_response' : output.gaps.length ? 'partial' : 'success';
}

/** One fresh public-NFL task: one catalogue, at most three distinct reads, no automatic retries. */
export function createNflSourceTask(config: {
	currentSeason: number;
	apiKey: string;
	apiUrl?: string;
	now?: () => Date;
}) {
	const currentSeason = season.parse(config.currentSeason);
	if (!config.apiKey.trim())
		throw new Error('NFL research credentials unavailable.');
	const client = new Firecrawl({ apiKey: config.apiKey, apiUrl: config.apiUrl ?? 'https://api.firecrawl.dev', maxRetries: 1 });
	const now = config.now ?? (() => new Date());
	let halted = false;
	let catalogueId: string | null = null;
	let contracts: Promise<unknown[] | NflSourceResult> | undefined;
	const reads = new Map<string, Promise<NflSourceResult>>();
	async function execute(
		provider: string,
		capability: string,
		options: Record<string, unknown>,
		price: number,
		output: NflSourceResult,
	) {
		output.requestId = crypto.randomUUID();
		output.quotedCredits = price;
		try {
			const response = await client.scrape({
				alexandria: { provider, capability, options },
				requestId: output.requestId,
				timeout: 20_000,
			});
			output.credits = credits.parse(response.creditsCost);
			const item = z.object({
				provider: z.literal(provider),
				capability: z.literal(capability),
				creditsCost: credits,
				upstreamStatus: z.number().int().optional(),
				error: z.unknown().optional(),
				data: z.unknown().optional(),
			}).parse(z.array(z.unknown()).length(1).parse(response.alexandria)[0]);
			if (item.creditsCost !== output.credits || output.credits > price)
				throw new Error('Unexpected charge');
			if (item.error !== undefined) {
				failure(item.error, output);
			} else if (item.upstreamStatus !== undefined && (item.upstreamStatus < 200 || item.upstreamStatus >= 300)) {
				failure({ status: item.upstreamStatus }, output);
			} else if (item.data === undefined) {
				throw new Error('Missing source data');
			} else {
				return item.data;
			}
		} catch (error) {
			if (output.credits === null)
				failure(error, output);
			else
				output.status = 'invalid_response';
		}
		if (output.status !== 'upstream_error')
			halted = true;
		return undefined;
	}
	async function inspect() {
		const output = empty();
		const data = await execute('firecrawl', 'find-tools', {
			providers: ['nfl-com', 'startwho-com'],
			capabilities: Object.values(routes).map(route => route.capability),
			level: 'tools',
			expand: ['options', 'response'],
			limit: 3,
		}, 0, output);
		catalogueId = output.requestId;
		if (data === undefined) {
			halted = true;
			return output;
		}
		try {
			return z.object({ items: z.array(z.unknown()).max(3) }).parse(data).items;
		} catch {
			halted = true;
			output.status = 'invalid_response';
			return output;
		}
	}
	async function run(input: NflSourceInput) {
		const output = empty();
		const inspected = await (contracts ??= inspect());
		if (!Array.isArray(inspected))
			return inspected;
		output.catalogueRequestId = catalogueId;
		if (halted) {
			output.gaps.push('task_stopped');
			return output;
		}
		let options: Record<string, string | number>;
		try {
			options = admit(inspected, input);
		} catch {
			output.gaps.push('pricing_or_contract_unsupported');
			return output;
		}
		const route = routes[input.operation];
		const data = await execute(route.provider, route.capability, options, 5, output);
		if (data !== undefined) {
			try {
				normalize(data, input, output, now().toISOString());
			} catch {
				output.status = 'invalid_response';
				output.records = [];
				output.source = null;
			}
		}
		if (output.status === 'invalid_response') {
			halted = true;
			output.gaps.push('invalid_response');
		}
		return output;
	}
	return async (raw: unknown): Promise<NflSourceResult> => {
		const parsed = nflSourceInputSchema.safeParse(raw);
		const output = empty();
		if (!parsed.success) {
			output.gaps.push('invalid_public_projection');
			return output;
		}
		if (parsed.data.operation === 'weekly-results' && parsed.data.season !== currentSeason) {
			output.gaps.push('older_season_projections_unsupported');
			return output;
		}
		const key = JSON.stringify(parsed.data);
		const previous = reads.get(key);
		if (previous)
			return previous;
		if (halted || reads.size >= 3) {
			output.gaps.push(halted ? 'task_stopped' : 'request_budget_exhausted');
			return output;
		}
		const result = run(parsed.data);
		reads.set(key, result);
		return result;
	};
}
