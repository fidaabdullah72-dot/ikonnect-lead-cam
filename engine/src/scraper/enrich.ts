/**
 * Website enrichment: visit a lead's website (and its contact page) to find
 * email addresses and social profiles.
 */
import type { LeadSocials } from '@batsols/shared';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
// Bounded runs: an unbounded pattern can take minutes on a huge page full of long tokens.
const EMAIL_RE = /[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}/gi;
const BAD_EMAIL = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(example|sentry|wixpress|sentry-next|domain|email)\.|^(your|name|user|test)@|godaddy|cloudflare/i;

const SOCIAL_PATTERNS: Array<[keyof LeadSocials, RegExp]> = [
  ['facebook', /https?:\/\/(?:www\.|m\.)?facebook\.com\/(?!sharer|share|dialog|plugins|tr\b|events\/)[A-Za-z0-9.\-_/%]+/i],
  ['instagram', /https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|explore|accounts)[A-Za-z0-9._]+/i],
  ['linkedin', /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in|school)\/[A-Za-z0-9\-_%]+/i],
  ['twitter', /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!share|intent|home)[A-Za-z0-9_]{2,}/i],
  ['youtube', /https?:\/\/(?:www\.)?youtube\.com\/(?:channel|c|user|@)[A-Za-z0-9\-_@/]+/i],
  ['tiktok', /https?:\/\/(?:www\.)?tiktok\.com\/@[A-Za-z0-9._]+/i],
];

async function fetchText(url: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('html')) return null;
    const text = await res.text();
    return text.slice(0, 600_000);
  } catch {
    return null;
  }
}

export function extractEmails(html: string, siteHost?: string): string[] {
  const decoded = html
    .replace(/&#64;|&commat;|%40|\[at\]|\(at\)/gi, '@')
    // URL-encoded characters in mailto links (e.g. "mailto:%20info@…") must not glue onto the address.
    .replace(/%[0-9a-f]{2}/gi, ' ')
    .replace(/mailto:/gi, ' ');
  const found = new Set<string>();
  for (const m of decoded.matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase().replace(/^[^a-z0-9]+/, '').replace(/[.]+$/, '');
    if (!BAD_EMAIL.test(e) && e.length < 80) found.add(e);
  }
  const list = [...found];
  // Prefer addresses on the business's own domain.
  if (siteHost) list.sort((a, b) => Number(b.endsWith(siteHost)) - Number(a.endsWith(siteHost)));
  return list.slice(0, 5);
}

export function extractSocials(html: string): LeadSocials {
  const out: LeadSocials = {};
  for (const [key, re] of SOCIAL_PATTERNS) {
    const m = html.match(re);
    if (m) out[key] = m[0].replace(/["'<>].*$/, '').replace(/\/$/, '');
  }
  return out;
}

export async function enrichWebsite(website: string): Promise<{ emails: string[]; socials: LeadSocials }> {
  let base: URL;
  try {
    base = new URL(website.startsWith('http') ? website : `https://${website}`);
  } catch {
    return { emails: [], socials: {} };
  }
  const host = base.hostname.replace(/^www\./, '');
  const home = await fetchText(base.toString());
  if (!home) return { emails: [], socials: {} };
  let emails = extractEmails(home, host);
  const socials = extractSocials(home);
  if (!emails.length) {
    // Look for a contact/about page link on the homepage, else try common paths.
    const linkMatch = home.match(/href=["']([^"']*(?:contact|about)[^"']*)["']/i);
    const candidates = [linkMatch?.[1], '/contact', '/contact-us'].filter(Boolean) as string[];
    for (const c of candidates.slice(0, 2)) {
      let url: string;
      try {
        url = new URL(c, base).toString();
      } catch {
        continue;
      }
      const page = await fetchText(url, 6000);
      if (!page) continue;
      emails = extractEmails(page, host);
      Object.assign(socials, { ...extractSocials(page), ...socials });
      if (emails.length) break;
    }
  }
  return { emails, socials };
}
