/**
 * Headless-browser Google Maps scraper (Playwright). Searches by text or at a
 * spot of the map, scrolls the results feed — skipping businesses already saved
 * as they load — and reads each result card (name, phone, website, category,
 * address, rating); only cards without a usable phone are opened (in the side
 * panel, no page reload) for the rest — so it stays fast on a small server. Works without an API key,
 * but Google can rate-limit or CAPTCHA datacenter IPs — the Places API provider
 * is the reliable option on servers.
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import type { CardRef, PlaceResult, SearchOutcome } from './types';

export class BlockedError extends Error {}

export interface SearchTarget {
  /** Search text: "dentists in Lahore, Pakistan", or just "dentists" with `at`. */
  query: string;
  /** Search this spot of the map (zoom: Google Maps zoom level). */
  at?: { lat: number; lng: number; zoom: number };
  /** ISO country Google formats the results for. */
  country?: string | null;
}

/** Google place id ("ChIJ…") or Maps feature id ("0x…:0x…") from a Maps place link. */
export function placeIdFromUrl(url: string): string | null {
  return url.match(/!19s(ChIJ[^!?]+)/)?.[1] ?? url.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/)?.[1] ?? null;
}

/** Lower-case country name → ISO code ("pakistan" → "PK"). */
const COUNTRY_NAMES = (() => {
  const names = new Map<string, string>();
  const dn = new Intl.DisplayNames(['en'], { type: 'region' });
  const A = 'A'.charCodeAt(0);
  for (let i = 0; i < 26; i++)
    for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(A + i, A + j);
      try {
        const name = dn.of(code);
        if (name && name !== code) names.set(name.toLowerCase(), code);
      } catch {
        /* not a region */
      }
    }
  for (const [n, code] of [['usa', 'US'], ['uk', 'GB'], ['uae', 'AE'], ['united states of america', 'US']]) names.set(n!, code!);
  return names;
})();

/** Country code from a full Google Maps address ("…, Lahore, 54000, Pakistan" → "PK"); null for a bare street. */
export function countryFromAddress(address: string | null | undefined): string | null {
  const last = (address ?? '').split(',').pop()?.trim().toLowerCase();
  return (last && COUNTRY_NAMES.get(last)) || null;
}

/** "Pakistan" for "PK". */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * City from a Google Maps address such as "28K Sir Syed Rd, Gulberg 2, Lahore, 54000, Pakistan",
 * "1 Main St, Austin, TX 78701, United States" or "Torstraße 5, 10115 Berlin, Germany".
 */
export function cityFromAddress(address: string | null | undefined): string | null {
  const parts = (address ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  if (COUNTRY_NAMES.has(parts[parts.length - 1]!.toLowerCase())) parts.pop();
  for (let i = parts.length - 1; i >= 1; i--) {
    const part = parts[i]!;
    if (/^[\d\s-]+$/.test(part)) continue; // postcode on its own
    const postFirst = part.match(/^\d{3,}[\d\s-]*\s+(\D.*)$/); // "10115 Berlin"
    if (postFirst) return postFirst[1]!.trim();
    if (/\D\s+\d{3,}[\d\s-]*$/.test(part)) continue; // "TX 78701", "Punjab 54000": region + postcode
    const words = part.split(/\s+/).filter((w) => !/\d/.test(w)).join(' ');
    if (!words || /^[A-Z]{1,3}$/.test(words)) continue;
    return words;
  }
  return null;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const pause = (min: number, max: number) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

export async function browserAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    const b = await chromium.launch({ headless: true });
    await b.close();
    return true;
  } catch {
    return false;
  }
}

export class MapsBrowser {
  private browser: Browser | null = null;
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;

  async open() {
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({
      headless: true,
      // No WebGL: servers have no GPU, so drawing the map would burn the CPU; only the text is needed.
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--lang=en-US', '--disable-3d-apis', '--disable-gpu'],
    });
    this.ctx = await this.browser.newContext({ locale: 'en-US', userAgent: UA, viewport: { width: 1366, height: 900 } });
    // tsx (dev) compiles with keepNames, which wraps functions passed to page.evaluate in a __name()
    // helper that doesn't exist inside the page. Define a no-op so those functions run.
    await this.ctx.addInitScript('globalThis.__name = globalThis.__name || ((fn) => fn);');
    // Skip images, fonts and map tiles: faster and lighter on CPU and memory.
    await this.ctx.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'font' || t === 'media') return route.abort();
      return /\/maps\/vt[/?]|\/kh\/v=/.test(route.request().url()) ? route.abort() : route.continue();
    });
    this.page = await this.ctx.newPage();
  }

  async close() {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.ctx = null;
    this.page = null;
  }

  private async guard(page: Page) {
    const url = page.url();
    if (url.includes('consent.google')) {
      const btn = page.getByRole('button', { name: /accept all|reject all|i agree/i }).first();
      if (await btn.count()) {
        await btn.click().catch(() => undefined);
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      }
    }
    if (page.url().includes('/sorry/') || (await page.getByText(/unusual traffic/i).count()) > 0) {
      throw new BlockedError('Google is blocking automated searches from this server (CAPTCHA). Use the Google Places API provider instead.');
    }
  }

  /**
   * Searches Google Maps and reads the results, skipping businesses `known` says are already
   * saved and scrolling on until `max` new ones are found or Google's list ends.
   * - target.at: search this spot of the map (deep search zones) instead of wherever the text points.
   * - target.country: the country Google formats results for; local-format phone numbers then belong
   *   to it, so their listings don't need opening just to learn the country.
   * - details: which results to open for full details — those whose card shows no usable phone, or all
   *   (e.g. to get review counts).
   */
  async search(
    target: SearchTarget,
    max: number,
    opts: {
      onLog?: (text: string) => void;
      isCancelled?: () => Promise<boolean>;
      details?: 'missing-phone' | 'all';
      known?: (cards: CardRef[]) => Promise<Set<string>>;
    } = {},
  ): Promise<SearchOutcome> {
    const page = this.page;
    if (!page) throw new Error('Browser not open');
    const at = target.at ? `/@${target.at.lat.toFixed(6)},${target.at.lng.toFixed(6)},${target.at.zoom}z` : '';
    const gl = target.country ? `&gl=${target.country.toLowerCase()}` : '';
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(target.query)}${at}?hl=en${gl}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await this.guard(page);

    const feed = page.locator('div[role="feed"]');
    await Promise.race([feed.waitFor({ timeout: 20_000 }), page.locator('h1.DUwDvf').first().waitFor({ timeout: 20_000 })]).catch(() => undefined);
    await this.guard(page);

    if (!(await feed.count())) {
      // Google jumped straight to a single place.
      const one = await this.readPlace(page).catch(() => null);
      const isKnown = one && opts.known ? (await opts.known([{ href: one.mapsUrl ?? '', placeId: one.placeId, phone: one.phone }])).size > 0 : false;
      return { places: one && !isKnown ? [one] : [], listed: one ? 1 : 0, known: isKnown ? 1 : 0, exhausted: true };
    }

    // Scroll, checking new cards against the saved leads as they load.
    const knownHrefs = new Set<string>();
    const checked = new Set<string>();
    let fresh = 0;
    let last = 0;
    let stale = 0;
    let exhausted = false;
    for (let i = 0; i < 60; i++) {
      const refs = await page.locator('div[role="feed"] div.Nv2PK').evaluateAll((els) =>
        els.map((c) => ({
          href: (c.querySelector('a.hfpxzc') as HTMLAnchorElement | null)?.href ?? '',
          phone: c.querySelector('span.UsdlK')?.textContent?.trim() || null,
        })),
      );
      const unchecked = refs.filter((r) => r.href.includes('/maps/place/') && !checked.has(r.href));
      for (const r of unchecked) checked.add(r.href);
      const known = unchecked.length && opts.known ? await opts.known(unchecked.map((r) => ({ ...r, placeId: placeIdFromUrl(r.href) }))) : new Set<string>();
      for (const r of unchecked) {
        if (known.has(r.href)) knownHrefs.add(r.href);
        else fresh++;
      }
      if (fresh >= max) break;
      if (await page.getByText(/reached the end of the list/i).count()) {
        exhausted = true;
        break;
      }
      if (refs.length === last) {
        stale++;
        if (stale >= 4) {
          exhausted = true;
          break;
        }
      } else {
        stale = 0;
      }
      last = refs.length;
      await feed.evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await pause(1200, 2200);
      if (opts.isCancelled && i % 5 === 4 && (await opts.isCancelled())) break;
    }

    const cards = (await page.locator('div[role="feed"] div.Nv2PK').evaluateAll((els) =>
      els.map((c) => {
        const a = c.querySelector('a.hfpxzc') as HTMLAnchorElement | null;
        const name = a?.getAttribute('aria-label')?.trim() ?? '';
        const lines = (c as HTMLElement).innerText.split('\n').map((l) => l.trim()).filter(Boolean);
        // "Dentist · · 12 Main Blvd": category first, street address last.
        const info = lines.find((l) => l !== name && l.includes('·') && !/^(open|closed|closes|opens)\b/i.test(l)) ?? '';
        const parts = info.split('·').map((x) => x.trim()).filter(Boolean);
        return {
          href: a?.href ?? '',
          name,
          phone: c.querySelector('span.UsdlK')?.textContent?.trim() || null,
          website: (c.querySelector('a[data-value="Website"]') as HTMLAnchorElement | null)?.href ?? null,
          category: parts[0] ?? null,
          address: parts.length > 1 ? parts[parts.length - 1]! : null,
          rating: c.querySelector('span.MW4etd')?.textContent?.trim() ?? null,
          reviews: c.querySelector('span.UY7F9')?.textContent?.trim() ?? null,
          status: /permanently closed/i.test(lines.join(' ')) ? 'CLOSED_PERMANENTLY' : /temporarily closed/i.test(lines.join(' ')) ? 'CLOSED_TEMPORARILY' : 'OPERATIONAL',
        };
      }),
    )).filter((c) => c.name && c.href.includes('/maps/place/'));
    const seen = new Set<string>();
    const listed = cards.filter((c) => !seen.has(c.href) && seen.add(c.href));
    const unique = listed.filter((c) => !knownHrefs.has(c.href)).slice(0, max);

    // Google writes numbers from the country it formats results for without the country code. When
    // that country is known (target.country) they are read as its numbers; otherwise the listing is
    // opened: the full address in the panel says which country the number belongs to.
    const needsDetails = (c: { phone: string | null }) => opts.details === 'all' || !c.phone || (!c.phone.startsWith('+') && !target.country);
    const toOpen = unique.filter(needsDetails).length;
    opts.onLog?.(
      `Google listed ${listed.length}${knownHrefs.size ? ` · ${knownHrefs.size} already found before, skipped` : ''}${toOpen ? ` · opening ${toOpen} for details…` : ''}`,
    );

    const out: PlaceResult[] = [];
    let opened = 0;
    for (const card of unique) {
      // A card shows only the street, not the city: leave it empty so the searched location is used.
      const fromCard = { ...this.toResult({ ...card, phoneId: card.phone, url: card.href }), city: null };
      if (!needsDetails(card)) {
        out.push(fromCard);
        continue;
      }
      if (opts.isCancelled && opened % 5 === 4 && (await opts.isCancelled())) break;
      opened++;
      try {
        const full = await this.openFromFeed(page, card.href, card.name);
        // Keep what the card had where the panel shows less (e.g. a website link).
        out.push(full ? { ...fromCard, ...Object.fromEntries(Object.entries(full).filter(([, v]) => v != null)) } : fromCard);
      } catch (e) {
        if (e instanceof BlockedError) throw e;
        out.push(fromCard);
        opts.onLog?.(`Couldn’t open “${card.name.slice(0, 40)}”: ${(e as Error).message.slice(0, 80)}`);
      }
      if (opened % 10 === 0) opts.onLog?.(`Read ${opened}/${toOpen} listings`);
      await pause(300, 800);
    }
    return { places: out, listed: listed.length, known: knownHrefs.size, exhausted };
  }

  /** Opens a result from the feed in the side panel (no page reload) and reads it; falls back to loading its page. */
  private async openFromFeed(page: Page, href: string, name: string): Promise<PlaceResult | null> {
    const link = page.locator(`div[role="feed"] a.hfpxzc[aria-label="${name.replace(/(["\\])/g, '\\$1')}"]`).first();
    try {
      const before = await page.locator('h1.DUwDvf').first().textContent({ timeout: 500 }).catch(() => null);
      await link.scrollIntoViewIfNeeded({ timeout: 5_000 });
      await link.click({ timeout: 5_000 });
      // The panel title turns into this place (it can be spelled slightly differently from the card).
      await page.waitForFunction(
        ([n, prev]) => {
          const t = document.querySelector('h1.DUwDvf')?.textContent?.trim();
          return Boolean(t && (t === n || t !== prev?.trim()));
        },
        [name, before] as const,
        { timeout: 15_000 },
      );
    } catch {
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.guard(page);
      await page.locator('h1.DUwDvf').first().waitFor({ timeout: 12_000 });
    }
    await this.guard(page);
    await pause(400, 800);
    return this.readPlace(page, href);
  }

  private async readPlace(page: Page, href?: string): Promise<PlaceResult | null> {
    const data = await page.evaluate(() => {
      // The place panel only: the results list beside it has its own names and "closed" labels.
      const root: ParentNode = document.querySelector('h1.DUwDvf')?.closest('[role="main"]') ?? document;
      const text = (sel: string) => root.querySelector(sel)?.textContent?.trim() ?? null;
      const attr = (sel: string, a: string) => root.querySelector(sel)?.getAttribute(a) ?? null;
      const name = text('h1.DUwDvf');
      const ratingText = text('div.F7nice span[aria-hidden="true"]');
      const reviewsLabel = attr('div.F7nice span[aria-label*="review"]', 'aria-label') ?? text('div.F7nice span:last-child');
      const phoneId = root.querySelector('button[data-item-id^="phone:tel:"]')?.getAttribute('data-item-id') ?? null;
      const website = (root.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement | null)?.href ?? null;
      const addressLabel = attr('button[data-item-id="address"]', 'aria-label');
      const address = addressLabel?.replace(/^Address:\s*/i, '') ?? text('button[data-item-id="address"] .Io6YTe');
      const category = text('button.DkEaL');
      const body = (root instanceof HTMLElement ? root : document.body).innerText;
      const status = /Permanently closed/i.test(body) ? 'CLOSED_PERMANENTLY' : /Temporarily closed/i.test(body) ? 'CLOSED_TEMPORARILY' : 'OPERATIONAL';
      return { name, ratingText, reviewsLabel, phoneId, website, address, category, status, url: location.href };
    });
    if (!data.name) return null;
    return this.toResult({ ...data, name: data.name, url: href ?? data.url });
  }

  private toResult(data: {
    name: string;
    url: string;
    phoneId: string | null;
    website: string | null;
    address: string | null;
    category: string | null;
    ratingText?: string | null;
    rating?: string | null;
    reviewsLabel?: string | null;
    reviews?: string | null;
    status: string;
  }): PlaceResult {
    const url = data.url;
    const ratingText = data.ratingText ?? data.rating ?? null;
    const reviewsLabel = data.reviewsLabel ?? data.reviews ?? null;
    const placeId = placeIdFromUrl(url);
    const lat = Number(url.match(/!3d(-?\d+\.\d+)/)?.[1] ?? NaN);
    const lng = Number(url.match(/!4d(-?\d+\.\d+)/)?.[1] ?? NaN);
    let website = data.website;
    if (website?.includes('google.com/url')) {
      try {
        website = new URL(website).searchParams.get('q') ?? website;
      } catch {
        /* keep */
      }
    }
    const rating = ratingText ? Number(ratingText.replace(',', '.')) : NaN;
    const reviews = reviewsLabel ? Number((reviewsLabel.match(/[\d,.]+/)?.[0] ?? '').replace(/[,.]/g, '')) : NaN;
    return {
      placeId,
      name: data.name,
      phone: data.phoneId ? data.phoneId.replace(/^phone:tel:/, '').trim() : null,
      website: website && !website.includes('google.') ? website : null,
      address: data.address,
      city: cityFromAddress(data.address),
      country: countryFromAddress(data.address),
      category: data.category,
      rating: Number.isFinite(rating) ? rating : null,
      reviews: Number.isFinite(reviews) ? reviews : null,
      mapsUrl: url.split('?')[0] ?? url,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      businessStatus: data.status,
    };
  }
}
