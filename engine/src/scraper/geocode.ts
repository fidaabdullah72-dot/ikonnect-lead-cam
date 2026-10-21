/**
 * Turns a typed location — any city, district, region or country in the world
 * — into a map area, with OpenStreetMap's Nominatim geocoder (free, no key).
 * Nominatim asks for at most one request per second and an identifying
 * User-Agent; results are cached for the life of the process.
 * GEOCODER_URL can point at another Nominatim server.
 */
import { config } from '../config';
import { countryName } from './browser';
import type { Area } from './areas';

export interface GeoCandidate {
  lat?: string;
  lon?: string;
  display_name?: string;
  boundingbox?: [string, string, string, string]; // south, north, west, east
  category?: string;
  type?: string;
  importance?: number;
  address?: { country_code?: string };
}

const cache = new Map<string, Area | null>();
let queue: Promise<unknown> = Promise.resolve();

/** One request at a time, at least 1.1 s apart. */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => new Promise((r) => setTimeout(r, 1100)),
    () => new Promise((r) => setTimeout(r, 1100)),
  );
  return run;
}

async function lookup(q: string, country: string | null): Promise<GeoCandidate[]> {
  const url = new URL('/search', config.geocoderUrl);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'en');
  if (country) url.searchParams.set('countrycodes', country.toLowerCase());
  if (config.geocoderEmail) url.searchParams.set('email', config.geocoderEmail);
  const res = await throttled(() =>
    fetch(url, { headers: { 'User-Agent': 'CoreNexa-LeadFinder/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) }),
  );
  if (!res.ok) throw new Error(`Geocoder error ${res.status}`);
  return ((await res.json()) as GeoCandidate[]).filter((p) => p.lat && p.lon && p.boundingbox?.length === 4);
}

/** A city, town, district, neighbourhood or region — not a street, shop or building of that name. */
const isPlace = (p: GeoCandidate) => p.category === 'place' || (p.category === 'boundary' && p.type === 'administrative');

/**
 * Picks the place meant: the best match in the search's country, unless that is
 * only a street or a far less known place than the best match worldwide — so
 * "Hyderabad" in a Pakistan search is Hyderabad, Sindh, while "London" (there is
 * a London Road in Hyderabad) is still London, UK.
 */
export function choosePlace(inCountry: GeoCandidate[], anywhere: GeoCandidate[]): GeoCandidate | null {
  const local = inCountry.find(isPlace);
  const world = anywhere.find(isPlace);
  if (local && world && (world.importance ?? 0) - (local.importance ?? 0) >= 0.25 && world.address?.country_code !== local.address?.country_code) return world;
  return local ?? world ?? inCountry[0] ?? anywhere[0] ?? null;
}

function toArea(query: string, p: GeoCandidate): Area | null {
  const [south, north, west, east] = p.boundingbox!.map(Number) as [number, number, number, number];
  if (![south, north, west, east].every(Number.isFinite)) return null;
  return {
    query,
    label: p.display_name ?? query,
    country: p.address?.country_code?.toUpperCase() ?? null,
    lat: Number(p.lat),
    lng: Number(p.lon),
    bbox: { south, north, west, east },
  };
}

/**
 * The map area for a location, preferring a match in `country` (the search's
 * country) — see choosePlace. Null when nothing matches; throws when the
 * geocoder can't be reached.
 */
export async function geocode(location: string, country: string | null): Promise<Area | null> {
  const key = `${country ?? ''}|${location.trim().toLowerCase()}`;
  if (cache.has(key)) return cache.get(key)!;
  const inCountry = country ? await lookup(location, country) : [];
  const anywhere = await lookup(location, null);
  const best = choosePlace(inCountry, anywhere);
  const area = best ? toArea(location, best) : null;
  cache.set(key, area);
  return area;
}

/** The whole country as an area (for searches without a location). */
export async function geocodeCountry(country: string): Promise<Area | null> {
  const key = `country|${country}`;
  if (cache.has(key)) return cache.get(key)!;
  const found = await lookup(countryName(country), country);
  const best = found.find((p) => p.category === 'boundary' && p.type === 'administrative') ?? found[0];
  const area = best ? toArea(countryName(country), best) : null;
  cache.set(key, area);
  return area;
}
