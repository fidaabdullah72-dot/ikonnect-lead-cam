/**
 * Automations: "when X happens to a lead, do Y".
 * Triggers come from the DB queue (stage changes, new leads), from inbound
 * replies (reply_received / keyword) and from finished campaign sequences
 * (campaign_no_reply). Actions run through the automation-tagged client so
 * they never re-trigger automations (no loops).
 */
import { buildTemplateVars, isWithinWindow, renderTemplate, type Automation, type AutomationAction, type Lead } from '@batsols/shared';
import { db, dbAutomation } from '../db';
import { log } from '../log';
import { adminsOf, getWorkspace, notify } from '../common';
import { errMsg } from '../util';

interface AutoEvent {
  workspaceId: string;
  trigger: Automation['trigger'];
  leadId: string;
  accountId?: string | null;
  text?: string;
  firstReply?: boolean;
  payload?: Record<string, unknown>;
  /** Run only this automation (used by time-based triggers). */
  automationId?: string;
}

const roundRobin = new Map<string, number>();

function keywordMatch(text: string, keywords: string[], mode: 'any' | 'exact' = 'any') {
  const t = text.toLowerCase().trim();
  return keywords.some((k) => {
    const kw = k.toLowerCase().trim();
    if (!kw) return false;
    return mode === 'exact' ? t === kw : new RegExp(`(^|\\W)${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`, 'i').test(t);
  });
}

async function appliesTo(a: Automation, lead: Lead, accountOwner: string | null): Promise<boolean> {
  if (a.owner_id) return lead.owner_id === a.owner_id || accountOwner === a.owner_id;
  const { data: grants } = await db.from('resource_access').select('user_id, team_id').eq('resource_type', 'automation').eq('resource_id', a.id);
  if (!grants?.length) return true; // workspace-wide
  const people = [lead.owner_id, accountOwner].filter(Boolean) as string[];
  if (grants.some((g) => g.user_id && people.includes(g.user_id))) return true;
  const teamIds = grants.map((g) => g.team_id).filter(Boolean) as string[];
  if (!teamIds.length || !people.length) return false;
  const { count } = await db.from('team_members').select('user_id', { count: 'exact', head: true }).in('team_id', teamIds).in('user_id', people);
  return (count ?? 0) > 0;
}

async function conditionsHold(a: Automation, e: AutoEvent, lead: Lead): Promise<boolean> {
  const c = a.conditions ?? {};
  if (a.trigger === 'keyword') {
    if (!e.text || !c.keywords?.length || !keywordMatch(e.text, c.keywords, c.match ?? 'any')) return false;
  }
  if ((a.trigger === 'reply_received' || a.trigger === 'keyword') && c.first_reply_only && !e.firstReply) return false;
  if (a.trigger === 'stage_changed') {
    if (c.stage_id && e.payload?.to !== c.stage_id) return false;
    if (c.from_stage_id && e.payload?.from !== c.from_stage_id) return false;
  }
  if (a.trigger === 'campaign_no_reply' && c.campaign_id && e.payload?.campaign_id !== c.campaign_id) return false;
  if (a.trigger === 'lead_created' && c.sources?.length && !c.sources.includes(lead.source)) return false;
  if (c.outside_hours && isWithinWindow(new Date(), c.outside_hours)) return false; // "only outside working hours"
  return true;
}

async function pickAccount(e: AutoEvent, lead: Lead): Promise<string | null> {
  if (e.accountId) return e.accountId;
  const { data: conv } = await db.from('conversations').select('account_id').eq('lead_id', lead.id).order('last_message_at', { ascending: false }).limit(1).maybeSingle();
  if (conv?.account_id) return conv.account_id;
  const { data: acc } = await db
    .from('whatsapp_accounts')
    .select('id')
    .eq('workspace_id', lead.workspace_id)
    .eq('status', 'connected')
    .eq('owner_id', lead.owner_id ?? '00000000-0000-0000-0000-000000000000')
    .limit(1)
    .maybeSingle();
  return acc?.id ?? null;
}

async function runAction(action: AutomationAction, a: Automation, e: AutoEvent, lead: Lead): Promise<string> {
  switch (action.type) {
    case 'send_template':
    case 'send_text': {
      if (!lead.phone || lead.opted_out) return 'skipped send (no phone / opted out)';
      let body = action.type === 'send_text' ? action.body : '';
      if (action.type === 'send_template') {
        const { data: t } = await db.from('message_templates').select('body').eq('id', action.template_id).maybeSingle();
        if (!t) return 'template missing';
        body = t.body;
      }
      const ws = await getWorkspace(lead.workspace_id);
      const text = renderTemplate(body, buildTemplateVars(lead, { company_name: ws?.settings.company_name ?? ws?.name ?? '' }));
      const accountId = await pickAccount(e, lead);
      if (!accountId) return 'no WhatsApp number available';
      const { error } = await dbAutomation.from('messages').insert({ workspace_id: lead.workspace_id, lead_id: lead.id, account_id: accountId, direction: 'out', body: text, status: 'queued' });
      if (error) throw new Error(error.message);
      return 'message queued';
    }
    case 'move_stage': {
      const { error } = await dbAutomation.from('leads').update({ stage_id: action.stage_id }).eq('id', lead.id);
      if (error) throw new Error(error.message);
      return 'stage moved';
    }
    case 'assign': {
      let userId: string | null = action.user_id === 'round_robin' ? null : action.user_id;
      if (action.user_id === 'round_robin') {
        const { data: members } = await db.from('workspace_members').select('user_id').eq('workspace_id', lead.workspace_id).eq('role', 'member').eq('active', true).order('created_at');
        const pool = (members ?? []).map((m) => m.user_id);
        if (!pool.length) return 'no members to assign';
        const i = roundRobin.get(a.id) ?? 0;
        userId = pool[i % pool.length]!;
        roundRobin.set(a.id, i + 1);
      }
      const { error } = await dbAutomation.from('leads').update({ owner_id: userId }).eq('id', lead.id);
      if (error) throw new Error(error.message);
      return 'assigned';
    }
    case 'add_tag': {
      const tags = [...new Set([...(lead.tags ?? []), action.tag])];
      const { error } = await dbAutomation.from('leads').update({ tags }).eq('id', lead.id);
      if (error) throw new Error(error.message);
      lead.tags = tags;
      return 'tagged';
    }
    case 'create_task': {
      const assignee = action.assignee === 'owner' || !action.assignee ? lead.owner_id : action.assignee;
      const { error } = await dbAutomation.from('tasks').insert({
        workspace_id: lead.workspace_id,
        lead_id: lead.id,
        title: renderTemplate(action.title, buildTemplateVars(lead)),
        due_at: new Date(Date.now() + (action.due_in_hours ?? 24) * 3600_000).toISOString(),
        assignee_id: assignee,
        type: 'follow_up',
      });
      if (error) throw new Error(error.message);
      return 'task created';
    }
    case 'notify': {
      const targets = action.target === 'owner' ? [lead.owner_id] : action.target === 'admins' ? await adminsOf(lead.workspace_id) : [action.target];
      await notify(lead.workspace_id, targets, {
        type: 'automation',
        title: action.message ? renderTemplate(action.message, buildTemplateVars(lead)) : `Automation “${a.name}”: ${lead.business_name}`,
        body: e.text?.slice(0, 160) ?? null,
        link: `/leads?lead=${lead.id}`,
      });
      return 'notified';
    }
    default:
      return 'unknown action';
  }
}

export async function runAutomations(e: AutoEvent) {
  const triggers: Automation['trigger'][] = e.trigger === 'reply_received' ? ['reply_received', 'keyword'] : [e.trigger];
  let query = db.from('automations').select('*').eq('workspace_id', e.workspaceId).eq('enabled', true).in('trigger', triggers);
  if (e.automationId) query = query.eq('id', e.automationId);
  const { data: autos } = await query;
  if (!autos?.length) return;
  const { data: lead } = await db.from('leads').select('*').eq('id', e.leadId).maybeSingle();
  if (!lead) return;
  let accountOwner: string | null = null;
  if (e.accountId) {
    const { data: acc } = await db.from('whatsapp_accounts').select('owner_id').eq('id', e.accountId).maybeSingle();
    accountOwner = acc?.owner_id ?? null;
  }

  for (const a of autos as Automation[]) {
    try {
      if (!(await appliesTo(a, lead, accountOwner))) continue;
      if (!(await conditionsHold(a, e, lead))) continue;
      const done: string[] = [];
      for (const action of a.actions ?? []) done.push(await runAction(action, a, e, lead));
      await db.from('automation_runs').insert({ workspace_id: e.workspaceId, automation_id: a.id, lead_id: lead.id, status: 'success', detail: done.join(' · ') });
      await db.from('automations').update({ run_count: a.run_count + 1, last_run_at: new Date().toISOString() }).eq('id', a.id);
      a.run_count++;
    } catch (err) {
      log.warn({ automation: a.id, err: errMsg(err) }, 'automation failed');
      await db.from('automation_runs').insert({ workspace_id: e.workspaceId, automation_id: a.id, lead_id: lead.id, status: 'failed', detail: errMsg(err).slice(0, 300) });
    }
  }
}

/** Drain events queued by database triggers. */
export async function processAutomationQueue() {
  const { data: rows } = await db.from('automation_queue').select('*').is('processed_at', null).order('id').limit(100);
  for (const r of rows ?? []) {
    await db.from('automation_queue').update({ processed_at: new Date().toISOString() }).eq('id', r.id);
    if (!r.lead_id) continue;
    await runAutomations({ workspaceId: r.workspace_id, trigger: r.trigger as Automation['trigger'], leadId: r.lead_id, payload: r.payload }).catch((e) =>
      log.warn({ err: errMsg(e) }, 'queued automation failed'),
    );
  }
}

/** Keep the queue small (hourly). */
export async function cleanupAutomationQueue() {
  await db.from('automation_queue').delete().lt('processed_at', new Date(Date.now() - 7 * 86400_000).toISOString());
}

/** "Campaign finished without a reply" — fires once per lead after the configured wait. */
export async function processNoReply() {
  const { data: autos } = await db.from('automations').select('*').eq('enabled', true).eq('trigger', 'campaign_no_reply');
  for (const a of (autos ?? []) as Automation[]) {
    const waitHours = Number((a.conditions as { wait_hours?: number }).wait_hours ?? 48);
    const cutoff = new Date(Date.now() - waitHours * 3600_000).toISOString();
    let q = db
      .from('campaign_recipients')
      .select('lead_id, campaign_id, account_id')
      .eq('workspace_id', a.workspace_id)
      .eq('status', 'completed')
      .is('replied_at', null)
      .lt('last_sent_at', cutoff)
      .gt('last_sent_at', new Date(Date.now() - (waitHours + 72) * 3600_000).toISOString())
      .limit(200);
    if (a.conditions.campaign_id) q = q.eq('campaign_id', a.conditions.campaign_id);
    const { data: due } = await q;
    for (const r of due ?? []) {
      const { count } = await db.from('automation_runs').select('id', { count: 'exact', head: true }).eq('automation_id', a.id).eq('lead_id', r.lead_id);
      if (count) continue;
      await runAutomations({
        workspaceId: a.workspace_id,
        trigger: 'campaign_no_reply',
        leadId: r.lead_id,
        accountId: r.account_id,
        payload: { campaign_id: r.campaign_id },
        automationId: a.id,
      });
    }
  }
}
