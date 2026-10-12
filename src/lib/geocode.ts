const US_STATE_CODES = new Set(
	'AL,AK,AZ,AR,CO,CT,DE,FL,GA,HI,ID,IL,IN,IA,KS,KY,LA,ME,MD,MA,MI,MN,MS,MO,MT,NE,NV,NH,NJ,NM,NY,NC,ND,OH,OK,OR,PA,RI,SC,SD,TN,TX,UT,VT,VA,WA,WV,WI,WY,DC'.split(','),
);

/**
 * Query shapes OpenWeather's geocoding endpoints accept, derived from one operator input.
 * "Mundelein, IL" fails as typed (IL parses as Israel), so we also try the US-state form
 * and the bare city.
 * @param location - Operator or model text, e.g. "Mundelein, IL"
 * @returns Ordered direct-geocoding queries to try until one resolves
 */
export function geocodeQueries(location: string): string[] {
	const trimmed = location.trim();
	const attempts = [trimmed];
	const twoPart = trimmed.match(/^(.+),\s*([A-Z]{2})$/i);
	if (twoPart && US_STATE_CODES.has(twoPart[2].toUpperCase())) {
		attempts.push(`${twoPart[1]},${twoPart[2].toUpperCase()},US`);
	}
	const city = trimmed.split(',')[0].trim();
	if (city && !attempts.includes(city)) {
		attempts.push(city);
	}
	return attempts;
}

/**
 * @param location - Operator or model text
 * @returns A /geo/1.0/zip query when the input is a ZIP, else null
 */
export function zipQuery(
	location: string,
): { zip: string; country: string } | null {
	const m = location.trim().match(/^(\d{4,5})(?:\s*,\s*([A-Z]{2}))?$/i);
	if (!m)
		return null;
	return { zip: m[1], country: (m[2] ?? 'US').toUpperCase() };
}
