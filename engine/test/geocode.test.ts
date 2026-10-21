import { beforeAll, describe, expect, it } from 'vitest';
import type { GeoCandidate } from '../src/scraper/geocode';

// geocode.ts reads the engine config, which requires these.
process.env.SUPABASE_URL ??= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';

let choosePlace: (inCountry: GeoCandidate[], anywhere: GeoCandidate[]) => GeoCandidate | null;
beforeAll(async () => {
  ({ choosePlace } = await import('../src/scraper/geocode'));
});

const place = (name: string, cc: string, importance: number, category = 'place', type = 'city'): GeoCandidate => ({
  display_name: name,
  lat: '1',
  lon: '1',
  boundingbox: ['0', '2', '0', '2'],
  category,
  type,
  importance,
  address: { country_code: cc },
});

describe('choosing the place meant', () => {
  it('prefers the match in the search country', () => {
    const sindh = place('Hyderabad, Sindh', 'pk', 0.55);
    const india = place('Hyderabad, Telangana', 'in', 0.7);
    expect(choosePlace([sindh], [india, sindh])?.display_name).toBe('Hyderabad, Sindh');
  });

  it('ignores streets of that name and takes the real place elsewhere', () => {
    const road = place('London Road, Hyderabad', 'pk', 0.1, 'highway', 'residential');
    const london = place('London, UK', 'gb', 0.9, 'boundary', 'administrative');
    expect(choosePlace([road], [london])?.display_name).toBe('London, UK');
  });

  it('takes a far better-known place abroad over an obscure local one', () => {
    const local = place('Dubai Town', 'pk', 0.15, 'place', 'neighbourhood');
    const dubai = place('Dubai', 'ae', 0.8);
    expect(choosePlace([local], [dubai])?.display_name).toBe('Dubai');
  });

  it('falls back to any match, then nothing', () => {
    const mall = place('Packages Mall', 'pk', 0.3, 'shop', 'mall');
    expect(choosePlace([mall], [])?.display_name).toBe('Packages Mall');
    expect(choosePlace([], [])).toBeNull();
  });
});
