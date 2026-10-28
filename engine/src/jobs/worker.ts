/**
 * Background jobs requested from the dashboard:
 *  - verify_whatsapp: check which leads' numbers are on WhatsApp (gentle pace)
 *  - enrich_leads: fetch websites for emails & social profiles
 */
import { SAFE_CHECKS_PER_DAY, type EngineJob, type Lead } from '@batsols/shared';
import { db } from '../db';
import { log } from '../log';
import { notify } from '../common';
import { chunk, errMsg, sleep } from '../util';
import { enrichWebsite } from '../scraper/enrich';
import type { SessionManager } from '../wa/manager';
import { CheckLimitError } from '../wa/session';

export class JobsWorker {
  private running = false;
  constructor(private manager: SessionManager) {}

  async recover() {
    await db.from('engine_jobs').update({ status: 'queued' }).eq('status', 'running');
  }

  async tick() {
    if (this.running) return;
    const { data: job } = await db.from('engine_jobs').select('*').eq('status', 'queued').order('created_at').limit(1).maybeSingle();
    if (!job) return;
    const { data: claimed } = await db
      .from('engine_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('*')
      .maybeSingle();
    if (!claimed) return;
    this.running = true;
    try {
      if (claimed.type === 'verify_whatsapp') await this.verify(claimed);
      else if (claimed.type === 'enrich_leads') await this.enrich(claimed);
    } catch (e) {
      log.warn({ job: claimed.id, err: errMsg(e) }, 'job failed');
      await db.from('engine_jobs').update({ status: 'failed', error: errMsg(e), finished_at: new Date().toISOString() }).eq('id', claimed.id);
    } finally {
      this.running = false;
    }
  }

  private async cancelled(id: string) {
    const { data } = await db.from('engine_jobs').select('status').eq('id', id).maybeSingle();
    return data?.status === 'cancelled';
  }

  private async verify(job: EngineJob) {
    const ids = job.payload.lead_ids ?? [];
    const accountId = job.payload.account_id;
    const result = { valid: 0, invalid: 0, skipped: 0 };
    let done = 0;
    // Safe mode: look-ups of many unknown numbers are a strong ban signal, so each WhatsApp number does at most
    // SAFE_CHECKS_PER_DAY a day, 20–40 seconds apart; numbers already checked are not looked up again.
    let limitReached = false;
    for (const part of chunk(ids, 50)) {
      if (await this.cancelled(job.id)) return;
      const { data: leads } = await db.from('leads').select('id, phone, wa_status').eq('workspace_id', job.workspace_id).in('id', part);
      for (const l of leads ?? []) {
        const session = accountId ? this.manager.openSession(accountId) : null;
        if (!session) throw new Error('The WhatsApp number used for checking is not connected.');
        if (limitReached || !l.phone || l.wa_status !== 'unknown') {
          result.skipped++;
        } else {
          try {
            const exists = await session.checkNumber(l.phone);
            await db.from('leads').update({ wa_status: exists ? 'valid' : 'invalid', wa_checked_at: new Date().toISOString() }).eq('id', l.id);
            if (exists) result.valid++;
            else result.invalid++;
            await sleep(20_000 + Math.random() * 20_000);
          } catch (e) {
            result.skipped++;
            if (e instanceof CheckLimitError) limitReached = true;
            else log.debug({ err: errMsg(e) }, 'number check failed');
          }
        }
        done++;
        if (done % 10 === 0 || limitReached) await db.from('engine_jobs').update({ progress: { done, total: ids.length }, result }).eq('id', job.id);
      }
    }
    await db.from('engine_jobs').update({ status: 'completed', progress: { done, total: ids.length }, result, finished_at: new Date().toISOString() }).eq('id', job.id);
    await notify(job.workspace_id, [job.created_by], {
      type: 'scrape_completed',
      title: limitReached ? 'WhatsApp check stopped at today\'s safe limit' : 'WhatsApp check finished',
      body: `${result.valid} on WhatsApp · ${result.invalid} not on WhatsApp${limitReached ? ` · each number checks at most ${SAFE_CHECKS_PER_DAY} a day to stay safe; run it again tomorrow for the rest` : ''}`,
      link: '/leads',
    });
  }

  private async enrich(job: EngineJob) {
    const ids = job.payload.lead_ids ?? [];
    const result = { enriched: 0, emails: 0 };
    let done = 0;
    for (const part of chunk(ids, 30)) {
      if (await this.cancelled(job.id)) return;
      const { data: leads } = await db.from('leads').select('id, website, email, socials').eq('workspace_id', job.workspace_id).in('id', part);
      for (const group of chunk(leads ?? [], 3)) {
        await Promise.all(
          group.map(async (l) => {
            if (!l.website) return;
            const { emails, socials } = await enrichWebsite(l.website);
            const patch: Partial<Lead> = {};
            if (!l.email && emails[0]) {
              patch.email = emails[0];
              result.emails++;
            }
            if (Object.keys(socials).length) patch.socials = { ...socials, ...(l.socials ?? {}) };
            if (Object.keys(patch).length) {
              await db.from('leads').update(patch).eq('id', l.id);
              result.enriched++;
            }
          }),
        );
        done += group.length;
        await db.from('engine_jobs').update({ progress: { done, total: ids.length }, result }).eq('id', job.id);
      }
    }
    await db.from('engine_jobs').update({ status: 'completed', progress: { done, total: ids.length }, result, finished_at: new Date().toISOString() }).eq('id', job.id);
    await notify(job.workspace_id, [job.created_by], { type: 'scrape_completed', title: 'Website enrichment finished', body: `${result.emails} emails found`, link: '/leads' });
  }
}
