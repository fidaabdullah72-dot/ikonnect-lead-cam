import type { PhoneType } from '@batsols/shared';
import type { PlaceResult, QualifyRules } from './types';

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Lead-quality gate applied to every scraped business before it is saved. */
export function qualify(p: PlaceResult, phoneType: PhoneType | null, rules: QualifyRules): Verdict {
  const skipClosed = rules.skip_closed ?? true;
  if (skipClosed && p.businessStatus && p.businessStatus !== 'OPERATIONAL') {
    return { ok: false, reason: p.businessStatus === 'CLOSED_PERMANENTLY' ? 'permanently closed' : 'temporarily closed' };
  }
  if (rules.min_rating && (p.rating ?? 0) < rules.min_rating) {
    return { ok: false, reason: `rating ${p.rating ?? 'none'} < ${rules.min_rating}` };
  }
  if (rules.min_reviews && (p.reviews ?? 0) < rules.min_reviews) {
    return { ok: false, reason: `${p.reviews ?? 0} reviews < ${rules.min_reviews}` };
  }
  if (rules.website === 'with' && !p.website) return { ok: false, reason: 'no website' };
  if (rules.website === 'without' && p.website) return { ok: false, reason: 'has a website' };
  if (rules.require_mobile && phoneType === 'landline') return { ok: false, reason: 'landline number' };
  const name = p.name.toLowerCase();
  const hit = (rules.exclude_keywords ?? []).map((k) => k.trim().toLowerCase()).find((k) => k && name.includes(k));
  if (hit) return { ok: false, reason: `name contains “${hit}”` };
  return { ok: true };
}
