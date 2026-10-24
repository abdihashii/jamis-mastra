import type { NflSourceInput } from './nfl-sources.schema';
import type { NflSourceRecord, NflSourceResult } from './nfl-sources.types';
import { z } from 'zod';
import { clubs, position, scoring, season, team, week } from './nfl-sources.schema';

const routes = {
	'injuries': { provider: 'nfl-com', capability: 'sports-league-data/injury_report', key: '', field: 'reports' },
	'news': { provider: 'nfl-com', capability: 'sports-league-data/news', key: '', field: 'articles' },
	'weekly-results': { provider: 'startwho-com', capability: 'fantasy-sports-rankings/weekly_results', key: 'players', field: 'players' },
} as const;
export const nflSourceCatalogueOptions = {
	providers: ['nfl-com', 'startwho-com'],
	capabilities: Object.values(routes).map(route => route.capability),
	level: 'tools',
	expand: ['options', 'response'],
	limit: 3,
};
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
function sourceUrl(value: string, provider: string) {
	const url = new URL(value);
	const host = provider === 'nfl-com' ? 'www.nfl.com' : 'startwho.com';
	if (url.protocol !== 'https:' || url.host !== host || url.username || url.password || url.hash)
		throw new Error('Unsupported provenance');
	return url.href;
}
function optionsFor(input: NflSourceInput): Record<string, string | number> {
	if (input.operation === 'injuries')
		return { season: input.season, season_type: 'REG', week: input.week, team: input.team };
	if (input.operation === 'news')
		return { tag: clubs[input.team], limit: 10 };
	return { week: input.week, position: input.position, scoring: input.scoring, limit: 100 };
}
export function admitNflSourceRequest(raw: unknown[], input: NflSourceInput) {
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
	return { provider: route.provider, capability: route.capability, options };
}
export function normalizeNflSourceResult(
	data: unknown,
	input: NflSourceInput,
	output: NflSourceResult,
	retrievedAtUtc: string,
) {
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
