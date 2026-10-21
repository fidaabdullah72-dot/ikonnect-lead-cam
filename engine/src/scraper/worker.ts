/**
 * Runs lead searches (scrape_jobs) one at a time with live progress, logs and
 * stats; applies the qualifier rules; dedupes by phone and place id; assigns
 * owners; optionally enriches websites; supports cancellation.
 *
 * A standard search runs one Google search per keyword × location. A deep
 * search looks each location up on the map (any city, area or country) and
 * searches it zone by zone, remembering searched zones (scrape_coverage) so the
 * next run reaches businesses this one couldn't. Either way, businesses already
 * saved are skipped while Google's list loads, so time goes to new ones.
 */
import { normalizePhone, type ScrapeJob, type ScrapeLog, type ScrapeStats } from '@batsols/shared';
import { db } from '../db';
import { config } from '../config';
import { log } from '../log';
import { getWorkspace, notify } from '../common';
import { errMsg, sleep } from '../util';
import { type Area, type CoveredZone, type Tile, MAP_ZOOM_OFFSET, intersects, isDense, keywordKey, planZones, tileBounds, tileCenter, tileKey } from './areas';
import { BlockedError, MapsBrowser, countryName } from './browser';
import { enrichWebsite } from './enrich';
import { geocode, geocodeCountry } from './geocode';
import { PlacesApiError, searchPlaces } from './places';
import { qualify } from './qualify';
import type { CardRef, PlaceResult, QualifyRules, SearchOutcome } from './types';

const MAX_LOGS = 300;
// Time limits, so one hung page, website or request can never freeze a search.
const SEARCH_LIMIT_MS = { browser: 30 * 60_000, places: 5 * 60_000 };
const DB_LIMIT_MS = 60_000;
const SITE_LIMIT_MS = 30_000;
/** Deep searches skip zones searched for the same keyword more recently than this (unless "search again" is on). */
const COVERAGE_TTL_MS = 90 * 24 * 3600_000;
/** The most businesses Google lists for one search. */
const LIST_CAP = { browser: 120, places: 60 };

/** Rejects when `p` takes longer than `ms`. */
function within<T>(p: PromiseLike<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took too long`)), ms);
  });
  return Promise.race([Promise.resolve(p), limit]).finally(() => clearTimeout(timer));
}

/**
 * Which lead-search sources this engine runs. Without a browser, Google Maps
 * browser searches are left queued for a scraper-only engine (ENGINE_ROLE=scraper).
 */
const PROVIDERS: Array<ScrapeJob['provider']> =
  config.role === 'scraper' ? ['browser'] : config.browserScraper ? ['places', 'browser'] : ['places'];

async function placesKey(workspaceId: string): Promise<string | null> {
  const { data } = await db.from('workspace_integrations').select('google_places_api_key').eq('workspace_id', workspaceId).maybeSingle();
  return data?.google_places_api_key?.trim() || config.placesApiKey || null;
}

/** A browser can run Google Maps searches: this engine's own, or a scraper-only engine that checked in recently. */
async function browserSearchOnline(): Promise<boolean> {
  if (config.browserScraper) return true;
  const { data } = await db.from('engine_status').select('heartbeat_at').eq('id', 'scraper').maybeSingle();
  return Boolean(data?.heartbeat_at && Date.now() - new Date(data.heartbeat_at).getTime() < 120_000);
}

export class ScrapeWorker {
  running: string | null = null;
  /** When the running search last made progress (the scraper-only engine restarts itself if this stalls). */
  lastActivity = Date.now();

  async tick() {
    if (this.running) return;
    const { data: next } = await db
      .from('scrape_jobs')
      .select('*')
      .eq('status', 'queued')
      .in('provider', PROVIDERS)
      .order('created_at')
      .limit(1)
      .maybeSingle();
    if (!next) return;
    if (next.cancel_requested) {
      // Stopped before it started.
      await db.from('scrape_jobs').update({ status: 'cancelled', finished_at: new Date().toISOString() }).eq('id', next.id).eq('status', 'queued');
      return;
    }
    // No Places API key: run it as a (free) Google Maps browser search instead of failing it.
    if (next.provider === 'places' && !(await placesKey(next.workspace_id)) && (await browserSearchOnline())) {
      await db.from('scrape_jobs').update({ provider: 'browser' }).eq('id', next.id).eq('status', 'queued');
      if (!PROVIDERS.includes('browser')) return; // the scraper-only engine picks it up on its next check
      next.provider = 'browser';
    }
    const { data: claimed } = await db
      .from('scrape_jobs')
      .update({ status: 'running', started_at: new Date().toISOString(), error: null })
      .eq('id', next.id)
      .eq('status', 'queued')
      .select('*')
      .maybeSingle();
    if (!claimed) return;
    this.running = claimed.id;
    this.lastActivity = Date.now();
    try {
      await new SearchRun(claimed, () => (this.lastActivity = Date.now())).execute();
    } finally {
      this.running = null;
    }
  }

  /** Jobs left 'running' by a crashed engine are re-queued (and resume where they stopped); ones the user stopped are finished. */
  async recover() {
    await db
      .from('scrape_jobs')
      .update({ status: 'cancelled', finished_at: new Date().toISOString() })
      .eq('status', 'running')
      .eq('cancel_requested', true)
      .in('provider', PROVIDERS);
    await db.from('scrape_jobs').update({ status: 'queued' }).eq('status', 'running').in('provider', PROVIDERS);
  }
}

/** One Google search: a text search (standard) or one map zone (deep). */
interface Step {
  keyword: string | null;
  location: string | null;
  /** Country for phone numbers and for Google's formatting. */
  country: string;
  text: string;
  tile?: Tile;
  /** For logs and errors. */
  label: string;
}

interface StepResult {
  listed: number;
  fresh: number;
  inserted: number;
  exhausted: boolean;
}

/** A searched zone as remembered (scrape_coverage row). */
type Covered = CoveredZone & { jobId: string | null; area: string };

/** One keyword in one location of a deep search. */
interface Pair {
  keyword: string;
  location: string | null;
  /** The location as remembered with its zones ("lahore", or "country:PK" for the whole country). */
  areaKey: string;
  area: Area | null;
  /** Zones this job already searched for the pair (after a restart). */
  done: number;
  /** Zones still planned. */
  left: number;
}

class SearchRun {
  private readonly logs: ScrapeLog[];
  private readonly stats: Required<ScrapeStats>;
  private progress: { current: number; total: number; query: string };
  private readonly resuming: boolean;
  private dirty = true;
  private cancelled = false;
  private browser: MapsBrowser | null = null;
  private apiKey: string | null = null;
  private readonly rules: QualifyRules;
  private readonly owner: string | null;
  private country = 'PK';
  private readonly areas = new Map<string, Area | null>();
  /** Businesses already handled in this run (place ids, phone digits): zones overlap. */
  private readonly seenPlaces = new Set<string>();
  private readonly seenPhones = new Set<string>();
  private stepsRun = 0;

  constructor(
    private readonly job: ScrapeJob,
    private readonly onActivity: () => void,
  ) {
    this.logs = Array.isArray(job.logs) ? [...job.logs] : [];
    // A search interrupted by a restart continues where it stopped, with its numbers so far.
    this.resuming = (job.progress?.current ?? 0) > 0;
    this.stats = {
      found: 0,
      inserted: 0,
      duplicates: 0,
      no_phone: 0,
      with_website: 0,
      without_website: 0,
      enriched: 0,
      errors: 0,
      disqualified: 0,
      ...(this.resuming ? job.stats : {}),
    };
    this.progress = { current: 0, total: job.queries.length, query: '' };
    this.rules = job.qualify ?? {};
    this.owner = job.assign_to ?? job.created_by;
  }

  private add(level: ScrapeLog['level'], text: string) {
    this.onActivity();
    this.logs.push({ t: new Date().toISOString(), level, text });
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    this.dirty = true;
  }

  private async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    await within(db.from('scrape_jobs').update({ logs: this.logs, stats: this.stats, progress: this.progress }).eq('id', this.job.id), DB_LIMIT_MS, 'Saving progress');
  }

  private async isCancelled() {
    if (this.cancelled) return true;
    const { data } = await within(db.from('scrape_jobs').select('cancel_requested').eq('id', this.job.id).maybeSingle(), DB_LIMIT_MS, 'Checking for stop');
    this.cancelled = Boolean(data?.cancel_requested);
    return this.cancelled;
  }

  async execute() {
    const job = this.job;
    const flusher = setInterval(() => void this.flush().catch(() => undefined), 2000);
    // "Stop" works even in the middle of a step: closing the browser ends whatever it is doing.
    const stopWatch = setInterval(() => {
      void this.isCancelled()
        .then((c) => (c ? this.browser?.close() : undefined))
        .catch(() => undefined);
    }, 5000);

    const ws = await getWorkspace(job.workspace_id);
    // The search's own country (picked on the form), else the workspace's.
    this.country = job.country ?? ws?.default_country ?? 'PK';

    try {
      if (job.provider === 'places') {
        this.apiKey = await placesKey(job.workspace_id);
        if (!this.apiKey) throw new Error('No Google Places API key. Add one in Settings → Integrations, or use the browser scraper.');
      } else {
        if (!config.browserScraper) throw new Error('The browser scraper is disabled on this server. Use the Google Places API provider.');
        this.browser = new MapsBrowser();
        await this.browser.open();
      }

      const more = job.depth === 'deep' ? await this.runDeep() : await this.runStandard();

      const s = this.stats;
      const status = this.cancelled ? 'cancelled' : 'completed';
      this.add(this.cancelled ? 'warning' : 'success', this.cancelled ? 'Stopped by user' : `Done: ${s.inserted} new leads, ${s.duplicates} already saved, ${s.disqualified} filtered out`);
      if (more && !this.cancelled) this.add('info', 'More map areas are left — run this search again to continue with them.');
      clearInterval(flusher);
      clearInterval(stopWatch);
      this.dirty = true;
      await this.flush();
      await db.from('scrape_jobs').update({ status, finished_at: new Date().toISOString() }).eq('id', job.id);
      await notify(job.workspace_id, [job.created_by], {
        type: 'scrape_completed',
        title: this.cancelled ? 'Lead search stopped' : 'Lead search finished',
        body: `${job.name || job.queries[0] || 'Search'}: ${s.inserted} new leads`,
        link: `/scraper/${job.id}`,
      });
    } catch (e) {
      clearInterval(flusher);
      clearInterval(stopWatch);
      const msg = errMsg(e);
      this.add('error', msg);
      this.dirty = true;
      await this.flush().catch(() => undefined);
      await db.from('scrape_jobs').update({ status: 'failed', error: msg, finished_at: new Date().toISOString() }).eq('id', job.id);
      await notify(job.workspace_id, [job.created_by], { type: 'scrape_failed', title: 'Lead search failed', body: msg, link: `/scraper/${job.id}` });
      log.warn({ job: job.id, err: msg }, 'scrape job failed');
    } finally {
      clearInterval(flusher);
      clearInterval(stopWatch);
      await this.browser?.close();
    }
  }

  private get sourceLabel() {
    return this.job.provider === 'places' ? 'Google Places API' : 'the Google Maps browser scraper';
  }

  /** One Google search per keyword × location (job.queries). Returns false: nothing is left for a next run. */
  private async runStandard(): Promise<boolean> {
    const job = this.job;
    const queries = job.queries;
    const resumeAt = Math.min(Math.max(0, (job.progress?.current ?? 0) - 1), queries.length);
    this.progress = { current: resumeAt, total: queries.length, query: '' };
    this.add(
      'info',
      resumeAt ? `Resuming at search ${resumeAt + 1} of ${queries.length}` : `Starting ${queries.length} search${queries.length === 1 ? '' : 'es'} with ${this.sourceLabel}`,
    );

    for (let i = resumeAt; i < queries.length; i++) {
      if (await this.isCancelled()) break;
      const query = queries[i]!;
      const keyword = job.keywords.find((k) => query.toLowerCase().startsWith(k.toLowerCase())) ?? null;
      const location = job.locations.find((l) => query.toLowerCase().endsWith(l.toLowerCase())) ?? null;
      // The place's own country: "London" in a search set to Pakistan is still London, UK.
      const country = (location && (await this.resolve(location))?.country) || this.country;
      // Pin the search to its country: "dentists in Springfield" alone could land anywhere,
      // and without a location Google searches around the server.
      const where = countryName(country);
      const text = !location ? `${query} in ${where}` : query.toLowerCase().includes(where.toLowerCase()) ? query : `${query}, ${where}`;
      this.progress = { current: i + 1, total: queries.length, query };
      await this.beforeStep();
      this.add('info', `Searching “${text}”`);
      await this.flush();

      const zone = `q:${text.toLowerCase()}`;
      const before = await this.searchedBefore(keyword ?? query, zone);
      if (before) {
        this.add(
          'info',
          `This exact search ran before (${before.toISOString().slice(0, 10)}): Google shows the same top ~${LIST_CAP[job.provider]} businesses, so expect mostly ones already saved. A deep search reaches the rest of the area.`,
        );
      }
      const r = await this.searchStep({ keyword, location, country, text, label: query });
      if (r) await this.remember(keyword ?? query, zone, (location ?? '').toLowerCase(), r, false);
    }
    return false;
  }

  /**
   * Zone by zone across each location's map area, up to job.area_limit zones per keyword ×
   * location. Returns true when zones are left for a next run.
   */
  private async runDeep(): Promise<boolean> {
    const job = this.job;
    const freshAfter = job.recheck ? Date.parse(job.created_at) : Date.now() - COVERAGE_TTL_MS;
    const limit = job.area_limit;
    const remaining = (p: Pair) => (limit === null ? null : Math.max(0, limit - p.done));

    const coverage = new Map<string, Map<string, Covered>>();
    for (const k of new Set(job.keywords.map(keywordKey))) coverage.set(k, await this.loadCoverage(k));
    const covOf = (p: Pair) => coverage.get(keywordKey(p.keyword))!;

    const pairs: Pair[] = [];
    for (const keyword of job.keywords) {
      for (const location of job.locations.length ? job.locations : [null]) {
        const area = location ? await this.resolve(location) : await this.resolveCountry();
        const areaKey = location ? location.toLowerCase() : `country:${this.country}`;
        const pair: Pair = { keyword, location, areaKey, area, done: 0, left: 0 };
        pair.done = [...covOf(pair).values()].filter((c) => c.jobId === job.id && c.area === areaKey).length;
        pair.left = area ? planZones(area, covOf(pair), { limit: remaining(pair), freshAfter }).length : pair.done ? 0 : 1;
        pairs.push(pair);
      }
    }
    const done = pairs.reduce((n, p) => n + p.done, 0);
    const recount = () => (this.progress.total = this.progress.current + pairs.reduce((n, p) => n + p.left, 0));
    this.progress = { current: done, total: 0, query: '' };
    recount();
    this.add(
      'info',
      this.resuming
        ? `Resuming the deep search (${done} map area${done === 1 ? '' : 's'} done)`
        : `Deep search with ${this.sourceLabel}: ${limit ? `up to ${limit} map areas` : 'every map area'} per keyword and place, areas already searched are skipped`,
    );

    for (const pair of pairs) {
      if (await this.isCancelled()) break;
      const place = pair.location ?? countryName(this.country);
      const cov = covOf(pair);

      if (!pair.area) {
        // Not on the map: one plain text search instead.
        if (pair.done || !pair.left) continue;
        this.add('warning', `Couldn’t find “${place}” on the map — searching it as text instead`);
        const text = pair.location ? `${pair.keyword} in ${pair.location}, ${countryName(this.country)}` : `${pair.keyword} in ${place}`;
        this.progress.current++;
        this.progress.query = `${pair.keyword} in ${place}`;
        pair.left = 0;
        await this.beforeStep();
        await this.flush();
        const r = await this.searchStep({ keyword: pair.keyword, location: pair.location, country: this.country, text, label: this.progress.query });
        if (r) await this.remember(pair.keyword, `q:${text.toLowerCase()}`, pair.areaKey, r, false);
        continue;
      }

      const area = pair.area;
      const skipped = [...cov.entries()].filter(([zone, c]) => c.searchedAt >= freshAfter && c.jobId !== job.id && zoneIn(zone, area)).length;
      if (!pair.left) {
        if (!pair.done) {
          this.add(
            'warning',
            `Every map area of ${place} was searched for “${pair.keyword}” in the last 90 days. Turn on “Search areas again”, or try other keywords or places.`,
          );
        }
        continue;
      }
      this.add(
        'info',
        `“${pair.keyword}” in ${area.label}: ${pair.left} map area${pair.left === 1 ? '' : 's'} to search${skipped ? ` · ${skipped} searched before, skipped` : ''}`,
      );

      while (remaining(pair) !== 0) {
        if (await this.isCancelled()) break;
        const [tile] = planZones(area, cov, { limit: 1, freshAfter });
        if (!tile) break;
        const zone = tileKey(tile);
        const n = pair.done + 1;
        const label = `${pair.keyword} · ${place} · area ${n}${limit ? ` of ${limit}` : ''}`;
        this.progress.current++;
        this.progress.query = label;
        await this.beforeStep();
        const c = tileCenter(tile);
        this.add('info', `Searching “${pair.keyword}” in ${place}, map area ${n} (around ${c.lat.toFixed(3)}, ${c.lng.toFixed(3)})`);
        await this.flush();

        const r = await this.searchStep({ keyword: pair.keyword, location: pair.location, country: area.country ?? this.country, text: pair.keyword, tile, label });
        if (r) {
          const dense = isDense({ ...r, cap: Math.min(LIST_CAP[job.provider], job.max_per_query) });
          cov.set(zone, { dense, searchedAt: Date.now(), jobId: job.id, area: pair.areaKey });
          await this.remember(pair.keyword, zone, pair.areaKey, r, dense);
        } else {
          // Failed: not remembered, so a next run tries it again; skip it for the rest of this one.
          cov.set(zone, { dense: false, searchedAt: Date.now(), jobId: null, area: '' });
        }
        pair.done++;
        // Busy zones add their sub-zones to the plan when the limit allows.
        pair.left = planZones(area, cov, { limit: remaining(pair), freshAfter }).length;
        recount();
      }
    }
    return pairs.some((p) => p.area && planZones(p.area, covOf(p), { limit: 1, freshAfter: Date.now() - COVERAGE_TTL_MS }).length > 0);
  }

  /** Pause between Google searches (not before the first). */
  private async beforeStep() {
    if (this.stepsRun++ > 0) await sleep(this.job.provider === 'places' ? 1500 : 4000 + Math.random() * 5000);
  }

  /** The map area for a typed location (cached for the run); null when it can't be found. */
  private async resolve(location: string): Promise<Area | null> {
    const key = location.trim().toLowerCase();
    if (this.areas.has(key)) return this.areas.get(key)!;
    let area: Area | null = null;
    try {
      area = await geocode(location, this.country);
      if (area && this.job.depth === 'deep') this.add('info', `“${location}” → ${area.label}`);
    } catch (e) {
      this.add('warning', `Couldn’t look up “${location}” on the map: ${errMsg(e)}`);
    }
    this.areas.set(key, area);
    return area;
  }

  private async resolveCountry(): Promise<Area | null> {
    const key = `country:${this.country}`;
    if (this.areas.has(key)) return this.areas.get(key)!;
    const area = await geocodeCountry(this.country).catch((e: unknown) => {
      this.add('warning', `Couldn’t look up ${countryName(this.country)} on the map: ${errMsg(e)}`);
      return null;
    });
    this.areas.set(key, area);
    return area;
  }

  /** Zones already searched for a keyword (all of them; deep searches filter by age). */
  private async loadCoverage(keyword: string): Promise<Map<string, Covered>> {
    const out = new Map<string, Covered>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await within(
        db
          .from('scrape_coverage')
          .select('zone, dense, searched_at, job_id, area')
          .eq('workspace_id', this.job.workspace_id)
          .eq('keyword', keyword)
          .range(from, from + 999),
        DB_LIMIT_MS,
        'Loading searched areas',
      );
      if (error) throw new Error(`Loading searched areas failed: ${error.message}`);
      for (const r of data ?? []) out.set(r.zone, { dense: r.dense, searchedAt: Date.parse(r.searched_at), jobId: r.job_id, area: r.area });
      if (!data || data.length < 1000) break;
    }
    return out;
  }

  private async searchedBefore(keyword: string, zone: string): Promise<Date | null> {
    const { data } = await db.from('scrape_coverage').select('searched_at').eq('workspace_id', this.job.workspace_id).eq('keyword', keywordKey(keyword)).eq('zone', zone).maybeSingle();
    return data ? new Date(data.searched_at) : null;
  }

  private async remember(keyword: string, zone: string, area: string, r: StepResult, dense: boolean) {
    const { error } = await within(
      db.from('scrape_coverage').upsert(
        {
          workspace_id: this.job.workspace_id,
          keyword: keywordKey(keyword),
          zone,
          area,
          found: r.listed,
          fresh: r.fresh,
          dense,
          job_id: this.job.id,
          searched_at: new Date().toISOString(),
        },
        { onConflict: 'workspace_id,keyword,zone' },
      ),
      DB_LIMIT_MS,
      'Saving the searched area',
    ).catch((e: unknown) => ({ error: { message: errMsg(e) } }));
    if (error) this.add('warning', `Couldn’t remember this area as searched: ${error.message}`);
  }

  /**
   * Which of these result cards are businesses already saved in the workspace (or already
   * handled in this run). `tally.saved` counts the ones found in the workspace.
   */
  private async known(cards: CardRef[], country: string, tally: { saved: number }): Promise<Set<string>> {
    const out = new Set<string>();
    const byPlace = new Map<string, string[]>();
    const byPhone = new Map<string, string[]>();
    for (const c of cards) {
      const digits = c.phone ? (normalizePhone(c.phone, country)?.digits ?? null) : null;
      if ((c.placeId && this.seenPlaces.has(c.placeId)) || (digits && this.seenPhones.has(digits))) {
        out.add(c.href);
        continue;
      }
      if (c.placeId) byPlace.set(c.placeId, [...(byPlace.get(c.placeId) ?? []), c.href]);
      if (digits) byPhone.set(digits, [...(byPhone.get(digits) ?? []), c.href]);
    }
    const saved = new Set<string>();
    try {
      const ids = [...byPlace.keys()];
      for (let i = 0; i < ids.length; i += 50) {
        const { data, error } = await within(
          db.from('leads').select('place_id').eq('workspace_id', this.job.workspace_id).in('place_id', ids.slice(i, i + 50)),
          DB_LIMIT_MS,
          'Checking saved leads',
        );
        if (error) throw new Error(error.message);
        for (const { place_id } of data ?? []) {
          if (!place_id) continue;
          this.seenPlaces.add(place_id);
          for (const href of byPlace.get(place_id) ?? []) saved.add(href);
        }
      }
      const phones = [...byPhone.keys()];
      for (let i = 0; i < phones.length; i += 50) {
        const { data, error } = await within(
          db.from('leads').select('phone').eq('workspace_id', this.job.workspace_id).in('phone', phones.slice(i, i + 50)),
          DB_LIMIT_MS,
          'Checking saved leads',
        );
        if (error) throw new Error(error.message);
        for (const { phone } of data ?? []) {
          if (!phone) continue;
          this.seenPhones.add(phone);
          for (const href of byPhone.get(phone) ?? []) saved.add(href);
        }
      }
    } catch (e) {
      // Not fatal: saving still refuses duplicates, it just costs a little time.
      log.warn({ job: this.job.id, err: errMsg(e) }, 'saved-lead check failed');
    }
    for (const href of saved) out.add(href);
    tally.saved += saved.size;
    return out;
  }

  /** Runs one Google search and saves what it finds. Null when the search failed (it's logged). */
  private async searchStep(step: Step): Promise<StepResult | null> {
    const job = this.job;
    const tally = { saved: 0 };
    const known = (cards: CardRef[]) => this.known(cards, step.country, tally);
    const isCancelled = () => this.isCancelled();
    let outcome: SearchOutcome;
    try {
      if (job.provider === 'places') {
        const r = await within(
          searchPlaces(this.apiKey!, step.text, job.max_per_query, { regionCode: step.country, within: step.tile ? tileBounds(step.tile) : undefined, isCancelled }),
          SEARCH_LIMIT_MS.places,
          `“${step.label}”`,
        );
        const ref = (p: PlaceResult) => p.placeId ?? p.mapsUrl ?? p.name;
        const skip = await known(r.places.map((p) => ({ href: ref(p), placeId: p.placeId, phone: p.phone })));
        const fresh = r.places.filter((p) => !skip.has(ref(p)));
        outcome = { places: fresh, listed: r.places.length, known: r.places.length - fresh.length, exhausted: r.exhausted };
      } else {
        const at = step.tile ? { ...tileCenter(step.tile), zoom: step.tile.z + MAP_ZOOM_OFFSET } : undefined;
        outcome = await within(
          this.browser!.search({ query: step.text, at, country: step.country }, job.max_per_query, {
            onLog: (t) => this.add('info', t),
            isCancelled,
            details: this.rules.min_reviews ? 'all' : 'missing-phone', // result cards don't show review counts
            known,
          }),
          SEARCH_LIMIT_MS.browser,
          `“${step.label}”`,
        );
      }
    } catch (e) {
      if (e instanceof BlockedError || (e instanceof PlacesApiError && [403, 429].includes(e.status))) throw e;
      if (await this.isCancelled().catch(() => false)) return null;
      this.stats.errors++;
      this.add('error', `“${step.label}” failed: ${errMsg(e)}`);
      if (this.browser) {
        // Start the next search with a fresh browser: the old one may be hung or gone.
        await this.browser.close();
        this.browser = new MapsBrowser();
        await this.browser.open();
      }
      return null;
    }
    this.stats.found += tally.saved + outcome.places.length;
    this.stats.duplicates += tally.saved;
    const inserted = await this.save(outcome.places, step);
    this.add(
      'success',
      `“${step.label}”: ${outcome.listed} listed · ${inserted} new lead${inserted === 1 ? '' : 's'}${tally.saved ? ` · ${tally.saved} already in BatSols` : ''}`,
    );
    return { listed: outcome.listed, fresh: outcome.places.length, inserted, exhausted: outcome.exhausted };
  }

  /** Qualifies and saves businesses as leads (skipping duplicates), then enriches their websites. Returns how many were added. */
  private async save(places: PlaceResult[], step: Step): Promise<number> {
    const job = this.job;
    const stats = this.stats;
    const enrichQueue: Array<{ id: string; website: string }> = [];
    let inserted = 0;

    for (const p of places) {
      const phone = normalizePhone(p.phone, p.country ?? step.country);
      if (p.placeId) this.seenPlaces.add(p.placeId);
      if (phone) this.seenPhones.add(phone.digits);
      const verdict = qualify(p, phone?.type ?? null, this.rules);
      if (!verdict.ok) {
        stats.disqualified++;
        this.add('warning', `Skipped ${p.name}: ${verdict.reason}`);
        continue;
      }
      if (!phone) {
        stats.no_phone++;
        this.add('warning', `Skipped ${p.name}: no phone number`);
        continue;
      }
      const row = {
        workspace_id: job.workspace_id,
        business_name: p.name.slice(0, 300),
        phone: phone.digits,
        phone_raw: p.phone,
        phone_type: phone.type,
        website: p.website,
        address: p.address,
        city: p.city ?? step.location,
        country: p.country ?? phone.country ?? null,
        category: p.category ?? step.keyword,
        rating: p.rating !== null ? Math.round(p.rating * 10) / 10 : null,
        reviews_count: p.reviews,
        google_maps_url: p.mapsUrl,
        place_id: p.placeId,
        latitude: p.lat,
        longitude: p.lng,
        source: 'scraper' as const,
        scrape_job_id: job.id,
        tags: [...job.tags, ...(step.keyword ? [step.keyword.toLowerCase()] : [])],
        owner_id: this.owner,
        created_by: job.created_by,
      };
      const { data: saved, error } = await within(
        db.from('leads').upsert(row, { onConflict: 'workspace_id,phone', ignoreDuplicates: true }).select('id'),
        DB_LIMIT_MS,
        'Saving the lead',
      ).catch((e: unknown) => ({ data: null, error: { code: 'timeout', message: errMsg(e) } }));
      if (error) {
        if (error.code === '23505') {
          stats.duplicates++;
          this.add('info', `Already in BatSols: ${p.name}`);
        } else {
          stats.errors++;
          this.add('error', `Couldn’t save ${p.name}: ${error.message}`);
        }
        continue;
      }
      if (!saved?.length) {
        stats.duplicates++;
        this.add('info', `Already in BatSols: ${p.name}`);
        continue;
      }
      inserted++;
      stats.inserted++;
      if (p.website) stats.with_website++;
      else stats.without_website++;
      this.add('success', `Saved ${p.name} · ${phone.display}${p.website ? ' · has website' : ' · no website'}`);
      if (job.enrich && p.website) enrichQueue.push({ id: saved[0]!.id, website: p.website });
    }

    // Website enrichment, 3 at a time.
    const enrichedBefore = stats.enriched;
    for (let k = 0; k < enrichQueue.length; k += 3) {
      if (await this.isCancelled()) break;
      await Promise.all(
        enrichQueue.slice(k, k + 3).map(async ({ id, website }) => {
          try {
            const { emails, socials } = await within(enrichWebsite(website), SITE_LIMIT_MS, 'Website check');
            if (!emails.length && !Object.keys(socials).length) return;
            await within(db.from('leads').update({ ...(emails[0] ? { email: emails[0] } : {}), socials }).eq('id', id), DB_LIMIT_MS, 'Saving email');
            stats.enriched++;
          } catch {
            // A slow or broken website is skipped.
          }
        }),
      );
    }
    if (enrichQueue.length) this.add('info', `Found emails or social profiles on ${stats.enriched - enrichedBefore} of ${enrichQueue.length} websites`);
    return inserted;
  }
}

/** Whether a remembered zone ("zoom/x/y") lies in the area. */
function zoneIn(zone: string, area: Area): boolean {
  const m = zone.match(/^(\d+)\/(\d+)\/(\d+)$/);
  return Boolean(m && intersects({ z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) }, area.bbox));
}
