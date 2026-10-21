import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { differenceInCalendarDays, formatDistanceToNowStrict, format, isToday, isYesterday, isThisYear } from 'date-fns';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en');

export const formatNumber = (n: number | null | undefined) => integer.format(n ?? 0);
export const formatCompact = (n: number | null | undefined) => compact.format(n ?? 0);

export function formatMoney(n: number | null | undefined, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n ?? 0);
  } catch {
    return `${currency} ${integer.format(n ?? 0)}`;
  }
}

export function formatPercent(part: number, whole: number, digits = 0) {
  if (!whole) return '0%';
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

export function timeAgo(date: string | Date | null | undefined) {
  if (!date) return '—';
  const d = new Date(date);
  const diff = Date.now() - d.getTime();
  if (diff < 45_000 && diff > -45_000) return 'just now';
  return formatDistanceToNowStrict(d, { addSuffix: true });
}

/** Chat-list style: 14:05 / Yesterday / Mon 3 / 3 Oct 2025 */
export function shortDate(date: string | Date | null | undefined) {
  if (!date) return '';
  const d = new Date(date);
  if (isToday(d)) return format(d, 'HH:mm');
  if (isYesterday(d)) return 'Yesterday';
  if (isThisYear(d)) return format(d, 'd MMM');
  return format(d, 'd MMM yyyy');
}

/** Day separator: Today / Yesterday / Monday (past week) / Mon, 3 Oct / 3 Oct 2025 */
export function dayLabel(date: string | Date | null | undefined) {
  if (!date) return 'Earlier';
  const d = new Date(date);
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  if (differenceInCalendarDays(new Date(), d) < 7) return format(d, 'EEEE');
  if (isThisYear(d)) return format(d, 'EEE, d MMM');
  return format(d, 'd MMM yyyy');
}

export function fullDate(date: string | Date | null | undefined) {
  if (!date) return '—';
  return format(new Date(date), "d MMM yyyy 'at' HH:mm");
}

export function initials(name: string | null | undefined) {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0]![0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '')).toUpperCase();
}

/** Stable pleasant color for an avatar from any string. */
export function colorFor(seed: string | null | undefined) {
  const palette = ['#7c5cff', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b', '#ec4899', '#ef4444', '#8b5cf6', '#14b8a6', '#f97316'];
  let h = 0;
  for (const ch of seed ?? '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length]!;
}

export function hostname(url: string | null | undefined) {
  if (!url) return '';
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function pluralize(n: number, one: string, many = `${one}s`) {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

/** Postgres/PostgREST errors → a sentence for a toast. */
export function errorMessage(err: unknown): string {
  if (!err) return 'Something went wrong';
  if (typeof err === 'string') return err;
  const e = err as { message?: string; details?: string; code?: string };
  if (e.code === '23505') return 'That already exists (duplicate).';
  if (e.code === '42501' && !e.message) return "You don't have permission to do that.";
  if (e.message?.includes('row-level security')) return "You don't have permission to do that.";
  return e.message || 'Something went wrong';
}

export function downloadFile(filename: string, content: string, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
