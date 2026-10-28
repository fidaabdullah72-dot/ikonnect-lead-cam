/**
 * Time-zone aware sending windows, warm-up limits and delays.
 * Uses Intl only, so it works the same in the browser and in Node.
 */

export interface SendingWindow {
  /** "09:00" (24h, local to `timezone`) */
  start: string;
  /** "19:00". If end <= start the window wraps past midnight. */
  end: string;
  /** ISO weekdays allowed: 1 = Monday … 7 = Sunday */
  days: number[];
  timezone: string;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday 1..7 */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatterCache.set(timezone, f);
  }
  return f;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    formatter(timezone);
    return true;
  } catch {
    return false;
  }
}

export function localParts(date: Date, timezone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timezone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? 'Mon'] ?? 1,
  };
}

/** "2026-10-03" in the given zone. Used for per-day counters such as "sent today". */
export function localDayKey(date: Date, timezone: string): string {
  const p = localParts(date, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function parseHm(hm: string): number {
  const [h, m] = hm.split(':').map((x) => Number(x));
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Offset (minutes) of `timezone` from UTC at `date`. */
function tzOffsetMinutes(date: Date, timezone: string): number {
  const p = localParts(date, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** Convert a wall-clock time in `timezone` to a real instant. */
export function zonedTimeToUtc(year: number, month: number, day: number, minutesOfDay: number, timezone: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, minutesOfDay);
  let offset = tzOffsetMinutes(new Date(guess), timezone);
  let result = guess - offset * 60000;
  // Second pass handles DST transitions between the guess and the result.
  const offset2 = tzOffsetMinutes(new Date(result), timezone);
  if (offset2 !== offset) {
    offset = offset2;
    result = guess - offset * 60000;
  }
  return new Date(result);
}

export function isWithinWindow(date: Date, w: SendingWindow): boolean {
  const p = localParts(date, w.timezone);
  const minutes = p.hour * 60 + p.minute;
  const start = parseHm(w.start);
  const end = parseHm(w.end);
  if (start === end) return w.days.includes(p.weekday); // 24h window
  if (start < end) return w.days.includes(p.weekday) && minutes >= start && minutes < end;
  // Overnight window (e.g. 20:00–02:00): the part after midnight belongs to the previous day.
  if (minutes >= start) return w.days.includes(p.weekday);
  if (minutes < end) return w.days.includes(p.weekday === 1 ? 7 : p.weekday - 1);
  return false;
}

/** The next instant (>= `from`) at which sending is allowed. */
export function nextWindowStart(from: Date, w: SendingWindow): Date {
  if (isWithinWindow(from, w)) return from;
  if (!w.days.length) return new Date(from.getTime() + 365 * 86400000);
  const start = parseHm(w.start);
  const p = localParts(from, w.timezone);
  for (let i = 0; i <= 8; i++) {
    // Walk forward day by day from the local calendar date.
    const base = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    const y = base.getUTCFullYear();
    const m = base.getUTCMonth() + 1;
    const d = base.getUTCDate();
    const weekday = ((base.getUTCDay() + 6) % 7) + 1;
    if (!w.days.includes(weekday)) continue;
    const candidate = zonedTimeToUtc(y, m, d, start, w.timezone);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  return new Date(from.getTime() + 86400000);
}

/**
 * Warm-up schedule for new WhatsApp numbers: starts at 20% of the daily limit (min 5)
 * and ramps linearly to the full limit over `days`.
 */
export function warmupLimit(dailyLimit: number, warmupStartedAt: Date | string | null, now: Date, days = 14): number {
  if (!warmupStartedAt) return dailyLimit;
  const started = new Date(warmupStartedAt).getTime();
  const elapsedDays = Math.max(0, Math.floor((now.getTime() - started) / 86400000));
  if (elapsedDays >= days) return dailyLimit;
  const floor = Math.min(dailyLimit, Math.max(5, Math.round(dailyLimit * 0.2)));
  return Math.round(floor + ((dailyLimit - floor) * elapsedDays) / days);
}

/** Safe mode: the most one WhatsApp number may send in a day, whatever its own limit says. */
export const SAFE_MAX_DAILY = 80;
/** Safe mode: "is this number on WhatsApp?" look-ups per WhatsApp number per day. */
export const SAFE_CHECKS_PER_DAY = 100;
/** Safe mode: a new number (or one with warm-up switched on) steps up over its first 14 days. */
const SAFE_WARMUP_STEPS: Array<[untilDay: number, limit: number]> = [
  [4, 10],
  [8, 20],
  [14, 40],
];

/**
 * Messages a number may send today in safe mode. Its first 14 days — counted from when warm-up was switched on,
 * or else from when it was added — allow 10, then 20, then 40 a day; after that its own limit, never more than
 * SAFE_MAX_DAILY.
 */
export function safeDailyLimit(dailyLimit: number, warmupStartedAt: Date | string | null, addedAt: Date | string | null, now: Date): number {
  const cap = Math.max(1, Math.min(dailyLimit, SAFE_MAX_DAILY));
  const start = warmupStartedAt ?? addedAt;
  if (!start) return cap;
  const day = Math.floor((now.getTime() - new Date(start).getTime()) / 86400000);
  for (const [untilDay, limit] of SAFE_WARMUP_STEPS) if (day < untilDay) return Math.min(cap, limit);
  return cap;
}

/** Uniform random integer in [min, max]. */
export function randomBetween(min: number, max: number, rng: () => number = Math.random): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(lo + rng() * (hi - lo + 1));
}

/** How long a human would take to type `text` (ms), bounded so campaigns don't crawl. */
export function typingDurationMs(text: string, rng: () => number = Math.random): number {
  const perChar = 40 + rng() * 30; // ~ 200–300 chars/minute
  return Math.min(8000, Math.max(1200, Math.round(text.length * perChar)));
}
