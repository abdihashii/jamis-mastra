import { z } from 'zod';

export const clubs = {
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
export const team = z.enum(Object.keys(clubs) as [keyof typeof clubs, ...(keyof typeof clubs)[]]);
export const season = z.number().int().min(1920).max(2100);
export const week = z.number().int().min(1).max(22);
export const position = z.enum(['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'FLX', 'ALL']);
export const scoring = z.enum(['STD', 'HALF', 'PPR']);

export const nflSourceInputSchema = z.discriminatedUnion('operation', [
	z.object({ operation: z.literal('injuries'), season, week, team }).strict(),
	z.object({ operation: z.literal('news'), team }).strict(),
	z.object({ operation: z.literal('weekly-results'), season, week, position, scoring }).strict(),
]);
export type NflSourceInput = z.infer<typeof nflSourceInputSchema>;
