import { describe, expect, it } from 'vitest';
import { isWithinWindow, localDayKey, nextWindowStart, randomBetween, warmupLimit, zonedTimeToUtc } from '../src/schedule';

const KHI = 'Asia/Karachi'; // UTC+5, no DST
const weekdays = { start: '09:00', end: '19:00', days: [1, 2, 3, 4, 5, 6], timezone: KHI };

describe('sending window', () => {
  it('converts wall-clock time to UTC', () => {
    expect(zonedTimeToUtc(2026, 10, 3, 9 * 60, KHI).toISOString()).toBe('2026-10-03T04:00:00.000Z');
    expect(zonedTimeToUtc(2026, 7, 1, 9 * 60, 'Europe/London').toISOString()).toBe('2026-07-01T08:00:00.000Z');
  });

  it('checks the window in the workspace timezone', () => {
    // Sat 2026-10-03 10:00 PKT
    expect(isWithinWindow(new Date('2026-10-03T05:00:00Z'), weekdays)).toBe(true);
    // Sat 20:00 PKT
    expect(isWithinWindow(new Date('2026-10-03T15:00:00Z'), weekdays)).toBe(false);
    // Sun 12:00 PKT (Sunday excluded)
    expect(isWithinWindow(new Date('2026-10-04T07:00:00Z'), weekdays)).toBe(false);
  });

  it('handles windows that cross midnight', () => {
    const night = { start: '22:00', end: '02:00', days: [1], timezone: 'UTC' };
    expect(isWithinWindow(new Date('2026-10-05T23:00:00Z'), night)).toBe(true); // Mon 23:00
    expect(isWithinWindow(new Date('2026-10-06T01:00:00Z'), night)).toBe(true); // Tue 01:00 (Mon night)
    expect(isWithinWindow(new Date('2026-10-06T23:00:00Z'), night)).toBe(false); // Tue 23:00
  });

  it('finds the next opening', () => {
    // Sat 20:00 PKT -> next allowed is Mon 09:00 PKT (Sunday off)
    expect(nextWindowStart(new Date('2026-10-03T15:00:00Z'), weekdays).toISOString()).toBe('2026-10-05T04:00:00.000Z');
    // Sat 07:00 PKT -> same day 09:00
    expect(nextWindowStart(new Date('2026-10-03T02:00:00Z'), weekdays).toISOString()).toBe('2026-10-03T04:00:00.000Z');
    // already inside -> unchanged
    const inside = new Date('2026-10-03T05:00:00Z');
    expect(nextWindowStart(inside, weekdays)).toBe(inside);
  });

  it('keys days in local time', () => {
    expect(localDayKey(new Date('2026-10-03T20:00:00Z'), KHI)).toBe('2026-10-04');
    expect(localDayKey(new Date('2026-10-03T20:00:00Z'), 'UTC')).toBe('2026-10-03');
  });
});

describe('warm-up and delays', () => {
  const start = new Date('2026-10-01T00:00:00Z');
  it('ramps from 20% to 100% over 14 days', () => {
    expect(warmupLimit(50, null, start)).toBe(50);
    expect(warmupLimit(50, start, start)).toBe(10);
    expect(warmupLimit(50, start, new Date('2026-10-08T00:00:00Z'))).toBe(30);
    expect(warmupLimit(50, start, new Date('2026-10-20T00:00:00Z'))).toBe(50);
    expect(warmupLimit(10, start, start)).toBe(5);
  });

  it('random delays stay in range', () => {
    for (let i = 0; i < 100; i++) {
      const d = randomBetween(30, 60);
      expect(d).toBeGreaterThanOrEqual(30);
      expect(d).toBeLessThanOrEqual(60);
    }
  });
});
