/**
 * Map zones for deep lead searches. Google lists at most ~120 businesses per
 * search, so a deep search covers an area (a city, district or whole country)
 * zone by zone: the area is split into Web Mercator map tiles and each tile is
 * searched on its own. Tiles are global, so a zone always has the same key —
 * the memory of searched zones (scrape_coverage) carries over between runs and
 * between overlapping locations ("Lahore" and "Gulberg, Lahore").
 *
 * Planning is breadth-first from the area's centre outwards: first the whole
 * area at a coarse zoom, then closer in (four sub-zones) wherever a zone was
 * still yielding many new businesses.
 */

export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface Area {
  /** What was typed ("Gulberg, Lahore"). */
  query: string;
  /** What it resolved to ("Gulberg, Lahore, Punjab, Pakistan"). */
  label: string;
  /** ISO country code of the place, when known. */
  country: string | null;
  lat: number;
  lng: number;
  bbox: Bbox;
}

export interface Tile {
  z: number;
  x: number;
  y: number;
}

/** Finest zone: ~2.4 km at the equator. Closer in, Google mostly repeats the same businesses. */
export const MAX_TILE_ZOOM = 14;
/** Coarsest zone (~1,250 km): whole large countries. */
export const MIN_TILE_ZOOM = 5;
/** First pass over an area: the finest zoom that still covers it in at most this many zones. */
export const MAX_BASE_ZONES = 36;
/** The browser shows a tile best at this many zoom levels closer in (the map is ~1,000 px wide). */
export const MAP_ZOOM_OFFSET = 2;

const clampLat = (lat: number) => Math.max(-85.0511, Math.min(85.0511, lat));

export function lngToX(lng: number, z: number): number {
  const n = 2 ** z;
  return Math.min(n - 1, Math.max(0, Math.floor(((lng + 180) / 360) * n)));
}

export function latToY(lat: number, z: number): number {
  const n = 2 ** z;
  const rad = (clampLat(lat) * Math.PI) / 180;
  return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)));
}

const yToLat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
const xToLng = (x: number, z: number) => (x / 2 ** z) * 360 - 180;

export function tileBounds(t: Tile): Bbox {
  return { north: yToLat(t.y, t.z), south: yToLat(t.y + 1, t.z), west: xToLng(t.x, t.z), east: xToLng(t.x + 1, t.z) };
}

export function tileCenter(t: Tile): { lat: number; lng: number } {
  return { lat: yToLat(t.y + 0.5, t.z), lng: xToLng(t.x + 0.5, t.z) };
}

export const tileKey = (t: Tile) => `${t.z}/${t.x}/${t.y}`;

/** Longitude span of a box; a box crossing the antimeridian (west > east) wraps around. */
const lngSpan = (b: Bbox) => (b.east >= b.west ? b.east - b.west : 360 - b.west + b.east);

/** Tiles at zoom `z` covering the box. */
export function coverTiles(b: Bbox, z: number): Tile[] {
  // A box that crosses the antimeridian is treated as spanning every longitude (rare: Fiji, Russia…).
  const [west, east] = b.east >= b.west ? [b.west, b.east] : [-180, 180];
  const x0 = lngToX(west, z);
  const x1 = lngToX(east, z);
  const y0 = latToY(b.north, z);
  const y1 = latToY(b.south, z);
  const out: Tile[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ z, x, y });
  return out;
}

export function countTiles(b: Bbox, z: number): number {
  const [west, east] = b.east >= b.west ? [b.west, b.east] : [-180, 180];
  return (lngToX(east, z) - lngToX(west, z) + 1) * (latToY(b.south, z) - latToY(b.north, z) + 1);
}

/** The finest zoom (≤ MAX_TILE_ZOOM) at which the box needs at most MAX_BASE_ZONES tiles. */
export function baseZoom(b: Bbox): number {
  for (let z = MAX_TILE_ZOOM; z > MIN_TILE_ZOOM; z--) if (countTiles(b, z) <= MAX_BASE_ZONES) return z;
  return MIN_TILE_ZOOM;
}

export function intersects(t: Tile, b: Bbox): boolean {
  const tb = tileBounds(t);
  if (tb.south > b.north || tb.north < b.south) return false;
  if (b.east < b.west) return true; // crosses the antimeridian: every longitude
  return !(tb.west > b.east || tb.east < b.west);
}

/** The four zones one level closer in that still overlap the area. */
export function children(t: Tile, within: Bbox): Tile[] {
  if (t.z >= MAX_TILE_ZOOM) return [];
  const out: Tile[] = [];
  for (const dx of [0, 1]) for (const dy of [0, 1]) out.push({ z: t.z + 1, x: t.x * 2 + dx, y: t.y * 2 + dy });
  return out.filter((c) => intersects(c, within));
}

/** Rough distance in km, for ordering zones from the centre out. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dy = (a.lat - b.lat) * 111.32;
  const dx = (a.lng - b.lng) * 111.32 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.sqrt(dx * dx + dy * dy);
}

const byDistanceFrom = (center: { lat: number; lng: number }) => (a: Tile, b: Tile) =>
  distanceKm(tileCenter(a), center) - distanceKm(tileCenter(b), center);

/** A zone already searched for this keyword (scrape_coverage row). */
export interface CoveredZone {
  dense: boolean;
  searchedAt: number;
}

/**
 * The zones to search next for one keyword in one area, centre first. Zones
 * searched since `freshAfter` are skipped; a skipped zone that was dense is
 * replaced by its sub-zones, so every run reaches businesses earlier runs could
 * not. Stops at `limit` zones (null: no limit, capped at `hardCap`).
 */
export function planZones(
  area: Pick<Area, 'lat' | 'lng' | 'bbox'>,
  covered: ReadonlyMap<string, CoveredZone>,
  opts: { limit: number | null; freshAfter: number; hardCap?: number },
): Tile[] {
  const limit = Math.min(opts.limit ?? Infinity, opts.hardCap ?? 2000);
  const center = { lat: area.lat, lng: area.lng };
  const queue = coverTiles(area.bbox, baseZoom(area.bbox)).sort(byDistanceFrom(center));
  const out: Tile[] = [];
  const queued = new Set(queue.map(tileKey));
  for (let i = 0; i < queue.length && out.length < limit; i++) {
    const t = queue[i]!;
    const c = covered.get(tileKey(t));
    if (c && c.searchedAt >= opts.freshAfter) {
      if (c.dense) {
        for (const k of children(t, area.bbox).sort(byDistanceFrom(center))) {
          if (!queued.has(tileKey(k))) {
            queued.add(tileKey(k));
            queue.push(k);
          }
        }
      }
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * Whether a searched zone is worth splitting next time: Google's list was cut
 * off (it never lists more than ~120, or we stopped at the per-zone limit) and
 * a good share of it was new to the workspace.
 */
export function isDense(r: { listed: number; fresh: number; exhausted: boolean; cap: number }): boolean {
  const cutOff = !r.exhausted || r.listed >= r.cap * 0.8;
  return cutOff && r.fresh >= Math.max(5, Math.round(r.cap / 6));
}

/** Normalised keyword for the zone memory: "  Dental  Clinics " → "dental clinics". */
export const keywordKey = (k: string) => k.trim().toLowerCase().replace(/\s+/g, ' ');
