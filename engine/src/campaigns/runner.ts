/**
 * Campaign runner. Each tick, for every running campaign and each of its
 * connected sender numbers, it claims the next due recipient and sends one
 * message — honouring sending windows, warm-up, daily caps, random delays,
 * batch pauses and stop-on-reply. Numbers send one message at a time and
 * share their pace and daily limit across campaigns.
 *
 * Ticks are frequent but cheap: campaign rows, steps and senders are cached
 * (refreshed by the 'campaigns' database signal or after a while), and nothing
 * touches the database while every number is pausing between messages.
 */
import {
  buildTemplateVars,
  isWithinWindow,
  normalizeCampaignSettings,
  randomBetween,
  renderTemplate,
  warmupLimit,
  type Campaign,
  type CampaignRecipient,
  type CampaignSettings,
  type CampaignStep,
  type Lead,
  type WhatsappAccount,
  type Workspace,
} from '@batsols/shared';
import { db } from '../db';
import { log } from '../log';
import { countSend, firstStageOfKind, getWorkspace, notify, sentToday, settingsOf, stagesOf, touchConversation } from '../common';
import { errMsg, nowIso } from '../util';
import { mimeFromName } from '../wa/content';
import { NotConnectedError } from '../wa/session';
import type { SessionManager } from '../wa/manager';

interface Ctx {
  campaign: Campaign;
  settings: CampaignSettings;
  steps: CampaignStep[];
  ws: Workspace;
  creatorName: string;
}

type Member = { user_id: string; role: string; active: boolean; permissions: Record<string, unknown>; full_name: string };

const MAX_ATTEMPTS = 3;

function isRateLimit(e: unknown) {
  const err = e as { output?: { statusCode?: number }; message?: string };
  return err?.output?.statusCode === 429 || /rate[- ]?(over)?limit|too many|spam/i.test(err?.message ?? '');
}

export class CampaignRunner {
  private busy = new Set<string>(); // accounts mid-send
  private nextAt = new Map<string, number>(); // account -> earliest next send (ms)
  private batch = new Map<string, number>(); // account -> sends since last break
  private variantTurn = new Map<string, number>(); // campaign -> round-robin variant counter
  private notes = new Map<string, string | null>(); // campaign -> last status note written

  // Caches that keep idle ticks off the database (Supabase egress).
  private running: Campaign[] = [];
  private stale = true; // a 'campaigns' signal arrived: re-read on the next tick
  private listedAt = 0;
  private promotedAt = 0;
  private sweptAt = 0;
  private idleUntil = new Map<string, number>(); // campaign -> skip ticks until (ms)
  private ctxCache = new Map<string, { version: string; at: number; ctx: Ctx }>();
  private senderCache = new Map<string, { at: number; list: Array<{ account: WhatsappAccount; owner: Member | null }> }>();

  constructor(private manager: SessionManager) {}

  activeCount = 0;

  /** Campaigns, recipients or numbers changed: re-read everything on the next tick. */
  invalidate() {
    this.stale = true;
    this.idleUntil.clear();
    this.ctxCache.clear();
    this.senderCache.clear();
  }

  async tick() {
    const now = Date.now();
    const refresh = this.stale || now - this.listedAt > 60_000;
    if (refresh || now - this.promotedAt > 30_000) {
      this.promotedAt = now;
      await this.promoteScheduled();
    }
    if (this.stale || now - this.sweptAt > 5 * 60_000) {
      this.sweptAt = now;
      await this.sweepCancelled();
    }
    if (refresh) {
      this.stale = false; // before the read, so a signal arriving during it isn't lost
      const { data: running, error } = await db.from('campaigns').select('*').eq('status', 'running');
      if (error) {
        this.stale = true;
        throw new Error(`campaigns load failed: ${error.message}`);
      }
      this.running = running ?? [];
      this.listedAt = now;
      this.activeCount = this.running.length;
    }
    for (const c of this.running) {
      try {
        await this.runCampaign(c);
      } catch (e) {
        log.error({ campaign: c.id, err: errMsg(e) }, 'campaign tick failed');
      }
    }
  }

  private async promoteScheduled() {
    const { data } = await db.from('campaigns').select('id, workspace_id, name').eq('status', 'scheduled').lte('scheduled_at', nowIso());
    for (const c of data ?? []) {
      const { data: updated } = await db
        .from('campaigns')
        .update({ status: 'running', started_at: nowIso() })
        .eq('id', c.id)
        .eq('status', 'scheduled')
        .select('id');
      if (updated?.length) await this.event(c.workspace_id, c.id, 'started', `Scheduled campaign “${c.name}” started`);
    }
  }

  /** Cancelled campaigns release their remaining recipients. */
  private async sweepCancelled() {
    const { data } = await db.from('campaigns').select('id').eq('status', 'cancelled').limit(50);
    for (const c of data ?? []) {
      await db.from('campaign_recipients').update({ status: 'cancelled' }).eq('campaign_id', c.id).in('status', ['pending', 'waiting']);
    }
  }

  private async event(workspaceId: string, campaignId: string, type: string, message: string, extra: { lead_id?: string; account_id?: string } = {}) {
    await db.from('campaign_events').insert({ workspace_id: workspaceId, campaign_id: campaignId, type: type as never, message, ...extra });
  }

  /** Status line shown on the campaign page ("Outside sending hours…"). */
  private async note(c: Campaign, text: string | null) {
    if (this.notes.get(c.id) === text && c.paused_reason === text) return;
    this.notes.set(c.id, text);
    if (c.paused_reason !== text) {
      await db.from('campaigns').update({ paused_reason: text }).eq('id', c.id);
      c.paused_reason = text; // keep the cached row in step
    }
  }

  private async context(c: Campaign): Promise<Ctx | null> {
    const hit = this.ctxCache.get(c.id);
    if (hit && hit.version === c.updated_at && Date.now() - hit.at < 5 * 60_000) return { ...hit.ctx, campaign: c };
    const ctx = await this.loadContext(c);
    if (ctx) this.ctxCache.set(c.id, { version: c.updated_at, at: Date.now(), ctx });
    return ctx;
  }

  private async loadContext(c: Campaign): Promise<Ctx | null> {
    const ws = await getWorkspace(c.workspace_id);
    if (!ws) return null;
    const { data: steps } = await db.from('campaign_steps').select('*').eq('campaign_id', c.id).order('position');
    const { data: creator } = c.created_by ? await db.from('profiles').select('full_name').eq('id', c.created_by).maybeSingle() : { data: null };
    return {
      campaign: c,
      settings: normalizeCampaignSettings(c.settings, ws.timezone),
      steps: (steps ?? []).filter((s) => Array.isArray(s.variants) && s.variants.some((v) => v.body?.trim() || v.media_url)),
      ws,
      creatorName: creator?.full_name ?? '',
    };
  }

  private async complete(c: Campaign) {
    const { data: updated } = await db
      .from('campaigns')
      .update({ status: 'completed', completed_at: nowIso(), paused_reason: null })
      .eq('id', c.id)
      .eq('status', 'running')
      .select('id');
    this.running = this.running.filter((x) => x.id !== c.id);
    this.activeCount = this.running.length;
    if (!updated?.length) return;
    const { data: stats } = await db.from('campaign_stats').select('*').eq('campaign_id', c.id).maybeSingle();
    await this.event(c.workspace_id, c.id, 'completed', `Campaign finished: ${stats?.sent ?? 0} sent, ${stats?.replied ?? 0} replied`);
    await notify(c.workspace_id, [c.created_by], {
      type: 'campaign_completed',
      title: `Campaign “${c.name}” finished`,
      body: `${stats?.sent ?? 0} leads messaged · ${stats?.replied ?? 0} replied · ${stats?.failed ?? 0} failed`,
      link: `/campaigns/${c.id}`,
    });
  }

  /** Which of the campaign's numbers may send right now, with their owners (cached for 30 s). */
  private async senders(c: Campaign): Promise<Array<{ account: WhatsappAccount; owner: Member | null }>> {
    const hit = this.senderCache.get(c.id);
    if (hit && Date.now() - hit.at < 30_000) return hit.list.filter((s) => this.manager.openSession(s.account.id));
    const list = await this.loadSenders(c);
    this.senderCache.set(c.id, { at: Date.now(), list });
    return list;
  }

  private async loadSenders(c: Campaign): Promise<Array<{ account: WhatsappAccount; owner: Member | null }>> {
    if (!c.account_ids?.length) return [];
    const [{ data: accounts }, { data: members }, { data: grants }] = await Promise.all([
      db.from('whatsapp_accounts').select('*').in('id', c.account_ids).eq('workspace_id', c.workspace_id),
      db.from('workspace_members').select('user_id, role, active, permissions, profiles(full_name)').eq('workspace_id', c.workspace_id),
      db.from('resource_access').select('resource_type, resource_id, user_id, team_id, access').eq('workspace_id', c.workspace_id).in('resource_type', ['campaign', 'whatsapp_account']),
    ]);
    const { data: teamRows } = await db.from('team_members').select('team_id, user_id').eq('workspace_id', c.workspace_id);
    const teamsOf = (uid: string) => new Set((teamRows ?? []).filter((t) => t.user_id === uid).map((t) => t.team_id));
    const memberMap = new Map(
      (members ?? []).map((m) => {
        const row = m as unknown as { user_id: string; role: string; active: boolean; permissions: Record<string, unknown>; profiles: { full_name: string } | null };
        return [row.user_id, { user_id: row.user_id, role: row.role, active: row.active, permissions: row.permissions ?? {}, full_name: row.profiles?.full_name ?? '' }];
      }),
    );
    const hasGrant = (type: string, id: string, uid: string | null, manage = true) => {
      if (!uid) return false;
      const teams = teamsOf(uid);
      return (grants ?? []).some(
        (g) => g.resource_type === type && g.resource_id === id && (g.user_id === uid || (g.team_id && teams.has(g.team_id))) && (!manage || g.access === 'manage'),
      );
    };
    const creator = c.created_by ? memberMap.get(c.created_by) : undefined;
    const creatorIsAdmin = creator?.active && (creator.role === 'owner' || creator.role === 'admin');
    const now = Date.now();

    const out: Array<{ account: WhatsappAccount; owner: Member | null }> = [];
    for (const a of accounts ?? []) {
      if (a.desired_state !== 'connected' || !this.manager.openSession(a.id)) continue;
      if (a.paused_until && new Date(a.paused_until).getTime() > now) continue;
      const owner = a.owner_id ? (memberMap.get(a.owner_id) ?? null) : null;
      if (!a.shared && (!owner || !owner.active)) continue; // suspended/removed member's personal number
      const allowed =
        a.owner_id === c.created_by ||
        a.shared ||
        creatorIsAdmin ||
        hasGrant('campaign', c.id, a.owner_id) ||
        hasGrant('whatsapp_account', a.id, c.created_by);
      if (!allowed) continue;
      out.push({ account: a, owner });
    }
    return out;
  }

  private async runCampaign(c: Campaign) {
    const nowMs = Date.now();
    if ((this.idleUntil.get(c.id) ?? 0) > nowMs) return;
    // Every number is mid-send or pausing between messages: nothing to do yet.
    if (c.account_ids?.length && c.account_ids.every((id) => this.busy.has(id) || (this.nextAt.get(id) ?? 0) > nowMs)) return;

    const ctx = await this.context(c);
    if (!ctx) return;
    if (!ctx.steps.length) {
      await db.from('campaigns').update({ status: 'paused', paused_reason: 'Add a message before starting this campaign.' }).eq('id', c.id);
      return;
    }

    const now = new Date();
    if (!isWithinWindow(now, ctx.settings.window)) {
      await this.note(c, 'Outside sending hours');
      this.idleUntil.set(c.id, nowMs + 60_000);
      return;
    }

    const senders = await this.senders(c);
    if (!senders.length) {
      await this.note(c, c.account_ids?.length ? 'Waiting for a connected WhatsApp number' : 'Choose at least one WhatsApp number to send from');
      this.idleUntil.set(c.id, nowMs + 15_000);
      return;
    }

    let limited = 0;
    let attempted = 0;
    let claimedAny = false;
    for (const { account, owner } of senders) {
      if (this.busy.has(account.id)) continue;
      if ((this.nextAt.get(account.id) ?? 0) > Date.now()) continue;

      const tz = ctx.ws.timezone;
      const today = await sentToday(account.id, tz, c.id);
      const numberCap = warmupLimit(account.daily_limit, account.warmup_started_at, now);
      if (today.total >= numberCap) {
        limited++;
        continue;
      }
      if (ctx.settings.daily_limit && today.campaign >= ctx.settings.daily_limit) {
        limited++;
        continue;
      }
      const memberCap = owner ? Number(owner.permissions.daily_message_cap ?? 0) : 0;
      if (memberCap > 0 && owner && owner.role === 'member' && (await this.memberSentToday(c.workspace_id, owner.user_id, tz)) >= memberCap) {
        limited++;
        continue;
      }

      attempted++;
      const { data: claimed, error } = await db.rpc('claim_next_recipient', { p_campaign: c.id, p_account: account.id });
      if (error) throw new Error(`claim failed: ${error.message}`);
      const r = (claimed as CampaignRecipient[] | null)?.[0];
      if (!r) continue;
      claimedAny = true;

      this.busy.add(account.id);
      void this.processRecipient(ctx, account, owner, r)
        .catch((e) => log.error({ campaign: c.id, err: errMsg(e) }, 'recipient failed'))
        .finally(() => this.busy.delete(account.id));
    }

    if (limited === senders.length) {
      await this.note(c, 'Daily sending limit reached · continues tomorrow');
      this.idleUntil.set(c.id, nowMs + 5 * 60_000);
      return;
    }
    await this.note(c, null);

    // Nobody was due: either everyone is done, or follow-ups are still waiting.
    if (attempted > 0 && !claimedAny) {
      const { count: open } = await db
        .from('campaign_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', c.id)
        .in('status', ['pending', 'waiting', 'sending']);
      if (!open) await this.complete(c);
      else this.idleUntil.set(c.id, nowMs + 30_000);
    }
  }

  private memberCache = new Map<string, { at: number; n: number }>();
  private async memberSentToday(workspaceId: string, userId: string, tz: string) {
    const hit = this.memberCache.get(userId);
    if (hit && Date.now() - hit.at < 60_000) return hit.n;
    const { data: accs } = await db.from('whatsapp_accounts').select('id').eq('workspace_id', workspaceId).eq('owner_id', userId);
    let n = 0;
    for (const a of accs ?? []) n += (await sentToday(a.id, tz)).total;
    this.memberCache.set(userId, { at: Date.now(), n });
    return n;
  }

  private async release(r: CampaignRecipient, delayMs = 0, error: string | null = null) {
    await db
      .from('campaign_recipients')
      .update({
        status: r.steps_sent > 0 ? 'waiting' : 'pending',
        next_send_at: delayMs ? new Date(Date.now() + delayMs).toISOString() : r.next_send_at,
        error,
      })
      .eq('id', r.id);
  }

  private async finish(r: CampaignRecipient, status: 'skipped' | 'failed' | 'completed' | 'replied', error: string | null) {
    await db.from('campaign_recipients').update({ status, error }).eq('id', r.id);
  }

  private async processRecipient(ctx: Ctx, account: WhatsappAccount, owner: Member | null, r: CampaignRecipient) {
    const c = ctx.campaign;
    const session = this.manager.openSession(account.id);
    if (!session) return this.release(r);

    const { data: lead } = await db.from('leads').select('*').eq('id', r.lead_id).maybeSingle();
    const skip = async (reason: string) => {
      await this.finish(r, 'skipped', reason);
      await this.event(c.workspace_id, c.id, 'skipped', `${lead?.business_name ?? 'Lead'}: ${reason}`, { lead_id: r.lead_id, account_id: account.id });
      this.nextAt.set(account.id, Date.now() + randomBetween(1500, 3500));
    };
    if (!lead) return skip('Lead was deleted');
    if (lead.opted_out) return skip('Opted out');
    if (!lead.phone) return skip('No phone number');
    if (ctx.settings.skip_landlines && lead.phone_type === 'landline') return skip('Landline number');
    if (ctx.settings.stop_on_reply && r.steps_sent > 0 && lead.last_replied_at && r.last_sent_at && lead.last_replied_at > r.last_sent_at) {
      await this.finish(r, 'replied', null);
      return;
    }
    const step = ctx.steps[r.steps_sent];
    if (!step) {
      await this.finish(r, 'completed', null);
      return;
    }

    // Verify the number right before the first message.
    if (ctx.settings.verify_whatsapp && lead.wa_status !== 'valid') {
      try {
        const exists = await session.checkNumber(lead.phone);
        await db.from('leads').update({ wa_status: exists ? 'valid' : 'invalid', wa_checked_at: nowIso() }).eq('id', lead.id);
        if (!exists) return skip('Not on WhatsApp');
      } catch (e) {
        if (e instanceof NotConnectedError) return this.release(r);
        log.debug({ err: errMsg(e) }, 'number check failed; sending anyway');
      }
    }

    const turn = this.variantTurn.get(c.id) ?? 0;
    const variantIndex = r.variant_index ?? turn;
    if (r.variant_index === null) this.variantTurn.set(c.id, turn + 1);
    const variant = step.variants[variantIndex % step.variants.length]!;
    const vars = buildTemplateVars(lead as Lead, {
      sender_name: ctx.settings.sender_name || owner?.full_name || ctx.creatorName,
      company_name: ctx.settings.company_name || ctx.ws.settings.company_name || ctx.ws.name,
    });
    const body = renderTemplate(variant.body ?? '', vars);

    try {
      const waId = await session.send(
        lead.phone,
        { text: body, mediaUrl: variant.media_url, mediaType: variant.media_type, mediaName: variant.media_name, mimetype: mimeFromName(variant.media_name ?? variant.media_url) },
        { typing: ctx.settings.typing },
      );
      const at = nowIso();
      const conversationId = await touchConversation({
        workspaceId: c.workspace_id,
        accountId: account.id,
        leadId: lead.id,
        preview: body || variant.media_name || 'Attachment',
        direction: 'out',
        at,
      });
      await db.from('messages').insert({
        workspace_id: c.workspace_id,
        conversation_id: conversationId,
        lead_id: lead.id,
        account_id: account.id,
        campaign_id: c.id,
        recipient_id: r.id,
        step: r.steps_sent,
        direction: 'out',
        body,
        media_url: variant.media_url ?? null,
        media_type: variant.media_type ?? null,
        media_name: variant.media_name ?? null,
        wa_message_id: waId,
        status: 'sent',
        created_at: at,
      });
      const next = ctx.steps[r.steps_sent + 1];
      await db
        .from('campaign_recipients')
        .update({
          steps_sent: r.steps_sent + 1,
          variant_index: variantIndex % step.variants.length,
          last_sent_at: at,
          delivery: r.delivery === 'none' ? 'sent' : r.delivery,
          status: next ? 'waiting' : 'completed',
          next_send_at: next ? new Date(Date.now() + next.delay_hours * 3600_000).toISOString() : null,
          error: null,
          attempts: 0,
        })
        .eq('id', r.id);

      const leadPatch: Partial<Lead> = { last_contacted_at: at, wa_status: 'valid' };
      if (settingsOf(ctx.ws).auto_stage_on_send && lead.stage_id) {
        const current = (await stagesOf(c.workspace_id)).find((s) => s.id === lead.stage_id);
        if (current?.kind === 'new') {
          const contacted = await firstStageOfKind(c.workspace_id, 'contacted');
          if (contacted) leadPatch.stage_id = contacted;
        }
      }
      await db.from('leads').update(leadPatch).eq('id', lead.id);
      await countSend(account.id, ctx.ws.timezone, c.id);
      await this.event(c.workspace_id, c.id, 'sent', `${lead.business_name} · ${r.steps_sent === 0 ? 'first message' : `follow-up ${r.steps_sent}`} from ${account.label}`, {
        lead_id: lead.id,
        account_id: account.id,
      });

      // Human-like pacing for this number.
      let delay = randomBetween(ctx.settings.min_delay_sec, ctx.settings.max_delay_sec) * 1000;
      const sentInBatch = (this.batch.get(account.id) ?? 0) + 1;
      if (ctx.settings.batch_size > 0 && sentInBatch >= ctx.settings.batch_size && ctx.settings.batch_pause_min > 0) {
        delay += ctx.settings.batch_pause_min * 60_000;
        this.batch.set(account.id, 0);
        await this.event(c.workspace_id, c.id, 'info', `${account.label} is taking a ${ctx.settings.batch_pause_min}-minute break after ${sentInBatch} messages`, { account_id: account.id });
      } else {
        this.batch.set(account.id, sentInBatch);
      }
      this.nextAt.set(account.id, Date.now() + delay);
    } catch (e) {
      if (e instanceof NotConnectedError) {
        await this.release(r);
        return;
      }
      if (isRateLimit(e)) {
        const until = new Date(Date.now() + 3600_000).toISOString();
        await db.from('whatsapp_accounts').update({ paused_until: until }).eq('id', account.id);
        await this.release(r, 0, 'WhatsApp rate limit — retrying later');
        await this.event(c.workspace_id, c.id, 'info', `WhatsApp slowed down ${account.label}; pausing it for 1 hour`, { account_id: account.id });
        await notify(c.workspace_id, [account.owner_id, c.created_by], {
          type: 'campaign_paused',
          title: `${account.label} hit WhatsApp's rate limit`,
          body: 'BatSols paused this number for an hour to protect it.',
          link: `/campaigns/${c.id}`,
        });
        return;
      }
      const msg = errMsg(e).slice(0, 300);
      if (r.attempts >= MAX_ATTEMPTS) {
        await this.finish(r, 'failed', msg);
        await this.event(c.workspace_id, c.id, 'failed', `${lead.business_name}: ${msg}`, { lead_id: lead.id, account_id: account.id });
      } else {
        await this.release(r, 5 * 60_000, msg);
      }
      this.nextAt.set(account.id, Date.now() + randomBetween(5_000, 15_000));
    }
  }

  /** Recipients stuck in 'sending' after a crash go back to the queue. */
  async recoverStuck() {
    const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    const { data } = await db.from('campaign_recipients').select('id, steps_sent, attempts').eq('status', 'sending').lt('updated_at', cutoff).limit(500);
    for (const r of data ?? []) {
      await db
        .from('campaign_recipients')
        .update({ status: r.attempts >= MAX_ATTEMPTS ? 'failed' : r.steps_sent > 0 ? 'waiting' : 'pending', error: r.attempts >= MAX_ATTEMPTS ? 'Interrupted repeatedly' : null })
        .eq('id', r.id);
    }
  }
}
