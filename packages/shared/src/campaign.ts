import type { SendingWindow } from './schedule';
import type { TemplateVars } from './template';

export interface CampaignSettings {
  /** Random pause between two messages from the same number. */
  min_delay_sec: number;
  max_delay_sec: number;
  /** Cap per sender number per day for this campaign (on top of the number's own limit). */
  daily_limit: number | null;
  /** After this many messages from one number, take a longer break. */
  batch_size: number;
  batch_pause_min: number;
  window: SendingWindow;
  /** Show "typing…" for a realistic time before each message. */
  typing: boolean;
  skip_landlines: boolean;
  /** Check the number is on WhatsApp right before sending; skip if not. */
  verify_whatsapp: boolean;
  stop_on_reply: boolean;
  /** Values for {{sender_name}} / {{company_name}}. */
  sender_name: string;
  company_name: string;
}

export interface CampaignVariant {
  body: string;
  media_url?: string | null;
  media_type?: 'image' | 'document' | 'video' | null;
  media_name?: string | null;
}

export const DEFAULT_WINDOW = (timezone: string): SendingWindow => ({
  start: '10:00',
  end: '19:00',
  days: [1, 2, 3, 4, 5, 6],
  timezone,
});

/**
 * Safe mode: the fastest any campaign may send, old campaigns included. WhatsApp bans numbers that message
 * many strangers quickly, so every number waits at least 2 minutes between messages and takes a break of at
 * least 15 minutes after every 10.
 */
export const SAFE_PACE = { minDelaySec: 120, minMaxDelaySec: 180, maxBatchSize: 10, minBatchPauseMin: 15 } as const;

export function defaultCampaignSettings(timezone: string): CampaignSettings {
  return {
    min_delay_sec: 150,
    max_delay_sec: 300,
    daily_limit: null,
    batch_size: 8,
    batch_pause_min: 20,
    window: DEFAULT_WINDOW(timezone),
    typing: true,
    skip_landlines: true,
    // Looking up many unknown numbers is one of the strongest ban signals: off unless switched on.
    verify_whatsapp: false,
    stop_on_reply: true,
    sender_name: '',
    company_name: '',
  };
}

const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
};

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Fill defaults and clamp unsafe values. Safe to call on untrusted JSON. */
export function normalizeCampaignSettings(raw: unknown, timezone: string): CampaignSettings {
  const d = defaultCampaignSettings(timezone);
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<CampaignSettings> & { window?: Partial<SendingWindow> };
  const min = clamp(r.min_delay_sec, SAFE_PACE.minDelaySec, 3600, d.min_delay_sec);
  const max = clamp(r.max_delay_sec, SAFE_PACE.minMaxDelaySec, 7200, d.max_delay_sec);
  const w: Partial<SendingWindow> = r.window ?? {};
  const days = Array.isArray(w.days) ? [...new Set(w.days.map(Number).filter((x) => x >= 1 && x <= 7))].sort() : d.window.days;
  return {
    min_delay_sec: Math.min(min, max),
    // At least a minute of randomness, so gaps never look regular.
    max_delay_sec: Math.max(min + 60, max),
    daily_limit: r.daily_limit === null || r.daily_limit === undefined ? null : clamp(r.daily_limit, 1, 1000, 40),
    batch_size: clamp(r.batch_size, 1, SAFE_PACE.maxBatchSize, d.batch_size),
    batch_pause_min: clamp(r.batch_pause_min, SAFE_PACE.minBatchPauseMin, 600, d.batch_pause_min),
    window: {
      start: typeof w.start === 'string' && HM.test(w.start) ? w.start : d.window.start,
      end: typeof w.end === 'string' && HM.test(w.end) ? w.end : d.window.end,
      days: days.length ? days : d.window.days,
      timezone: typeof w.timezone === 'string' && w.timezone ? w.timezone : timezone,
    },
    typing: r.typing ?? d.typing,
    skip_landlines: r.skip_landlines ?? d.skip_landlines,
    verify_whatsapp: r.verify_whatsapp ?? d.verify_whatsapp,
    stop_on_reply: r.stop_on_reply ?? d.stop_on_reply,
    sender_name: typeof r.sender_name === 'string' ? r.sender_name.slice(0, 80) : '',
    company_name: typeof r.company_name === 'string' ? r.company_name.slice(0, 80) : '',
  };
}

/** Rough estimate of how long a campaign will take, for the review step. */
export function estimateCampaignDuration(
  recipients: number,
  senders: number,
  s: Pick<CampaignSettings, 'min_delay_sec' | 'max_delay_sec' | 'batch_size' | 'batch_pause_min' | 'daily_limit' | 'window'>,
  senderDailyLimit = 40,
): { perDay: number; days: number; hoursPerDay: number } {
  const avgDelay = (s.min_delay_sec + s.max_delay_sec) / 2;
  const perMessageSec = avgDelay + (s.batch_size > 0 ? (s.batch_pause_min * 60) / s.batch_size : 0);
  const [sh = 0, sm = 0] = s.window.start.split(':').map(Number);
  const [eh = 0, em = 0] = s.window.end.split(':').map(Number);
  let windowMin = eh * 60 + em - (sh * 60 + sm);
  if (windowMin <= 0) windowMin += 24 * 60;
  const byTime = Math.floor((windowMin * 60) / perMessageSec);
  const cap = Math.min(s.daily_limit ?? senderDailyLimit, senderDailyLimit);
  const perSenderDay = Math.max(1, Math.min(byTime, cap));
  const perDay = perSenderDay * Math.max(1, senders);
  const days = recipients > 0 ? Math.ceil(recipients / perDay) : 0;
  return { perDay, days, hoursPerDay: Math.round(((perSenderDay * perMessageSec) / 3600) * 10) / 10 };
}

export interface LeadLike {
  business_name: string;
  contact_name?: string | null;
  city?: string | null;
  category?: string | null;
  website?: string | null;
  address?: string | null;
  rating?: number | string | null;
  reviews_count?: number | null;
}

export function buildTemplateVars(lead: LeadLike, extra: { sender_name?: string; company_name?: string } = {}): TemplateVars {
  const contact = lead.contact_name?.trim() || '';
  return {
    business_name: lead.business_name,
    contact_name: contact,
    first_name: contact.split(/\s+/)[0] ?? '',
    city: lead.city ?? '',
    category: lead.category ?? '',
    website: (lead.website ?? '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''),
    address: lead.address ?? '',
    rating: lead.rating ?? '',
    reviews_count: lead.reviews_count ?? '',
    sender_name: extra.sender_name ?? '',
    company_name: extra.company_name ?? '',
  };
}

/** Does an inbound message look like an opt-out request? */
export function isOptOut(text: string, keywords: readonly string[]): boolean {
  // Punctuation becomes spaces so "Not interested, thanks!" matches "not interested".
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40) return false;
  return keywords.some((k) => {
    const kw = k.trim().toLowerCase();
    return kw !== '' && (t === kw || t.startsWith(`${kw} `) || t.endsWith(` ${kw}`));
  });
}
