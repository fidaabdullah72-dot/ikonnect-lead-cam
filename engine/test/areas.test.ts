import { describe, expect, it } from 'vitest';
import {
  MAX_BASE_ZONES,
  MAX_TILE_ZOOM,
  baseZoom,
  children,
  countTiles,
  coverTiles,
  intersects,
  isDense,
  keywordKey,
  latToY,
  lngToX,
  planZones,
  tileBounds,
  tileCenter,
  tileKey,
  type CoveredZone,
} from '../src/scraper/areas';

// Nominatim's answers for "Lahore" (a city) and "Pakistan" (a country).
const lahore = { lat: 31.5656822, lng: 74.3141829, bbox: { south: 31.4056822, north: 31.7256822, west: 74.1541829, east: 74.4741829 } };
const pakistan = { lat: 30.3308401, lng: 71.247499, bbox: { south: 23.4341977, north: 37.091675, west: 60.872855, east: 77.1203914 } };
const gulberg = { lat: 31.5204, lng: 74.3587, bbox: { south: 31.5104, north: 31.5304, west: 74.3487, east: 74.3687 } };

describe('map tiles', () => {
  it('converts between coordinates and tiles', () => {
    const t = { z: 13, x: lngToX(74.3587, 13), y: latToY(31.5204, 13) };
    const b = tileBounds(t);
    expect(b.west).toBeLessThanOrEqual(74.3587);
    expect(b.east).toBeGreaterThan(74.3587);
    expect(b.south).toBeLessThanOrEqual(31.5204);
    expect(b.north).toBeGreaterThan(31.5204);
    const c = tileCenter(t);
    expect(c.lat).toBeGreaterThan(b.south);
    expect(c.lat).toBeLessThan(b.north);
    expect(tileKey(t)).toBe(`13/${t.x}/${t.y}`);
  });

  it('covers a box completely with the counted number of tiles', () => {
    const tiles = coverTiles(lahore.bbox, 12);
    expect(tiles).toHaveLength(countTiles(lahore.bbox, 12));
    for (const corner of [
      { lat: lahore.bbox.south, lng: lahore.bbox.west },
      { lat: lahore.bbox.north, lng: lahore.bbox.east },
    ]) {
      expect(tiles.some((t) => { const b = tileBounds(t); return corner.lat >= b.south && corner.lat <= b.north && corner.lng >= b.west && corner.lng <= b.east; })).toBe(true);
    }
  });

  it('picks a zoom that fits the area in a handful of zones', () => {
    for (const area of [lahore, pakistan, gulberg]) {
      const z = baseZoom(area.bbox);
      expect(countTiles(area.bbox, z)).toBeLessThanOrEqual(MAX_BASE_ZONES);
      if (z < MAX_TILE_ZOOM) expect(countTiles(area.bbox, z + 1)).toBeGreaterThan(MAX_BASE_ZONES);
    }
    expect(baseZoom(pakistan.bbox)).toBeLessThan(baseZoom(lahore.bbox));
    expect(baseZoom(lahore.bbox)).toBeLessThan(baseZoom(gulberg.bbox));
  });

  it('splits a zone into the sub-zones that overlap the area', () => {
    const t = coverTiles(lahore.bbox, 12)[0]!;
    const kids = children(t, lahore.bbox);
    expect(kids.length).toBeGreaterThan(0);
    expect(kids.length).toBeLessThanOrEqual(4);
    for (const k of kids) {
      expect(k.z).toBe(13);
      expect(intersects(k, lahore.bbox)).toBe(true);
    }
    expect(children({ z: MAX_TILE_ZOOM, x: 1, y: 1 }, lahore.bbox)).toEqual([]);
  });
});

describe('planning zones', () => {
  const none = new Map<string, CoveredZone>();
  const now = Date.now();

  it('starts at the centre and respects the limit', () => {
    const plan = planZones(lahore, none, { limit: 5, freshAfter: 0 });
    expect(plan).toHaveLength(5);
    const first = tileBounds(plan[0]!);
    expect(lahore.lat).toBeGreaterThanOrEqual(first.south - 0.1);
    expect(lahore.lat).toBeLessThanOrEqual(first.north + 0.1);
    expect(new Set(plan.map(tileKey)).size).toBe(5);
  });

  it('skips zones searched recently and continues with the next ones', () => {
    const first = planZones(lahore, none, { limit: 5, freshAfter: now - 1000 });
    const covered = new Map(first.map((t) => [tileKey(t), { dense: false, searchedAt: now }]));
    const second = planZones(lahore, covered, { limit: 5, freshAfter: now - 1000 });
    expect(second).toHaveLength(5);
    expect(second.some((t) => covered.has(tileKey(t)))).toBe(false);
  });

  it('searches old zones again, and every zone again when asked to', () => {
    const first = planZones(lahore, none, { limit: 3, freshAfter: 0 });
    const covered = new Map(first.map((t) => [tileKey(t), { dense: false, searchedAt: now - 100 * 86_400_000 }]));
    expect(planZones(lahore, covered, { limit: 3, freshAfter: now - 90 * 86_400_000 }).map(tileKey)).toEqual(first.map(tileKey));
  });

  it('goes closer in where a searched zone was busy', () => {
    const base = planZones(lahore, none, { limit: null, freshAfter: 0 });
    const covered = new Map<string, CoveredZone>(base.map((t, i) => [tileKey(t), { dense: i === 0, searchedAt: now }]));
    const next = planZones(lahore, covered, { limit: null, freshAfter: now - 1000 });
    expect(next.length).toBeGreaterThan(0);
    expect(next.length).toBeLessThanOrEqual(4);
    for (const t of next) expect(t.z).toBe(base[0]!.z + 1);
  });

  it('is done when every zone was searched and none was busy', () => {
    const base = planZones(lahore, none, { limit: null, freshAfter: 0 });
    const covered = new Map(base.map((t) => [tileKey(t), { dense: false, searchedAt: now }]));
    expect(planZones(lahore, covered, { limit: null, freshAfter: now - 1000 })).toEqual([]);
  });
});

describe('busy zones', () => {
  it('splits a zone only when Google cut the list off and much of it was new', () => {
    expect(isDense({ listed: 120, fresh: 70, exhausted: true, cap: 120 })).toBe(true);
    expect(isDense({ listed: 60, fresh: 60, exhausted: false, cap: 60 })).toBe(true);
    expect(isDense({ listed: 120, fresh: 4, exhausted: true, cap: 120 })).toBe(false);
    expect(isDense({ listed: 35, fresh: 35, exhausted: true, cap: 120 })).toBe(false);
  });

  it('normalises keywords', () => {
    expect(keywordKey('  Dental   Clinics ')).toBe('dental clinics');
  });
});
