import { expect, test } from 'bun:test';

import { geocodeQueries, zipQuery } from '../geocode';

test('geocodeQueries tries the text as typed, then the US-state form, then the bare city', () => {
	expect(geocodeQueries('Mundelein, IL')).toEqual(['Mundelein, IL', 'Mundelein,IL,US', 'Mundelein']);
});

test('geocodeQueries keeps a valid-looking country form but still falls back to the bare city', () => {
	expect(geocodeQueries('Toronto, CA')).toEqual(['Toronto, CA', 'Toronto,CA,US', 'Toronto']);
});

test('geocodeQueries passes a bare city through once', () => {
	expect(geocodeQueries('Chicago')).toEqual(['Chicago']);
});

test('zipQuery detects a bare ZIP as US', () => {
	expect(zipQuery('60060')).toEqual({ zip: '60060', country: 'US' });
	expect(zipQuery(' 00150, FI ')).toEqual({ zip: '00150', country: 'FI' });
});

test('zipQuery ignores city names', () => {
	expect(zipQuery('Mundelein')).toBeNull();
});
