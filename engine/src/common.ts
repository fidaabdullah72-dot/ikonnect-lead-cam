/**
 * Small shared services: workspace settings cache, notifications, activity log,
 * conversation bookkeeping and per-number daily counters.
 */
import { localDayKey, type Conversation, type Workspace, type WorkspaceSettings } from '@batsols/shared';
import { db } from './db';
import { log } from './log';
import { errMsg } from './util';

// ---------------------------------------------------------------------------
// Workspace cache (settings change rarely; 30 s staleness is fine)
// ---------------------------------------------------------------------------

const wsCache = new Map<string, { at: number; ws: Workspace }>();

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const hit = wsCache.get(id);
  if (hit && Date.now() - hit.at < 30_000) return hit.ws;
  const { data, error } = await db.from('workspaces').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`workspace load failed: ${error.message}`);
  if (!data) return null;
  wsCache.set(id, { at: Date.now(), ws: data });
  return data;
}

export function settingsOf(ws: Workspace | null): Required<Pick<WorkspaceSettings, 'opt_out_keywords' | 'capture_unknown_inbound' | 'auto_stage_on_send' | 'auto_stage_on_reply'>> {
  const s = ws?.settings ?? {};
  return {
    opt_out_keywords: s.opt_out_keywords ?? ['stop', 'unsubscribe'],
    capture_unknown_inbound: s.capture_unknown_inbound ?? false,
    auto_stage_on_send: s.auto_stage_on_send ?? true,
    auto_stage_on_reply: s.auto_stage_on_reply ?? true,
  };
}

// ---------------------------------------------------------------------------
// Stage lookups
// ---------------------------------------------------------------------------

const stageCache = new Map<string, { at: number; stages: Array<{ id: string; kind: string; position: number }> }>();

export async function stagesOf(workspaceId: string) {
  const hit = stageCache.get(workspaceId);
  if (hit && Date.now() - hit.at < 60_000) return hit.stages;
  const { data } = await db.from('pipeline_stages').select('id, kind, position').eq('workspace_id', workspaceId).order('position');
  const stages = data ?? [];
  stageCache.set(workspaceId, { at: Date.now(), stages });
  return stages;
}

export async function firstStageOfKind(workspaceId: string, kind: string): Promise<string | null> {
  return (await stagesOf(workspaceId)).find((s) => s.kind === kind)?.id ?? null;
}

// ---------------------------------------------------------------------------
// Notifications & activity
// ---------------------------------------------------------------------------

export async function notify(workspaceId: string, userIds: Array<string | null | undefined>, n: { type: string; title: string; body?: string | null; link?: string | null }) {
  const users = [...new Set(userIds.filter((u): u is string => !!u))];
  if (!users.length) return;
  const { error } = await db
    .from('notifications')
    .insert(users.map((user_id) => ({ workspace_id: workspaceId, user_id, type: n.type, title: n.title, body: n.body ?? null, link: n.link ?? null })));
  if (error) log.warn({ err: error.message }, 'notify failed');
}

export async function adminsOf(workspaceId: string): Promise<string[]> {
  const { data } = await db.from('workspace_members').select('user_id').eq('workspace_id', workspaceId).in('role', ['owner', 'admin']).eq('active', true);
  return (data ?? []).map((r) => r.user_id);
}

export async function logActivity(workspaceId: string, leadId: string | null, type: string, data: Record<string, unknown> = {}, actorId: string | null = null) {
  const { error } = await db.from('activities').insert({ workspace_id: workspaceId, lead_id: leadId, actor_id: actorId, type, data });
  if (error) log.warn({ err: error.message, type }, 'activity log failed');
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/** Create or update the (number, lead) conversation; returns its id. */
export async function touchConversation(args: {
  workspaceId: string;
  accountId: string;
  leadId: string;
  preview: string;
  direction: 'in' | 'out';
  at: string;
  /** Outbound messages typed by a person mark the chat as read. */
  markRead?: boolean;
}): Promise<string> {
  const preview = args.preview.slice(0, 200);
  const { data: existing, error } = await db
    .from('conversations')
    .select('id, unread_count, last_message_at')
    .eq('account_id', args.accountId)
    .eq('lead_id', args.leadId)
    .maybeSingle();
  if (error) throw new Error(`conversation lookup failed: ${error.message}`);
  if (existing) {
    const newer = !existing.last_message_at || existing.last_message_at <= args.at;
    const patch: Partial<Conversation> = {};
    if (newer) Object.assign(patch, { last_message_at: args.at, last_message_preview: preview, last_direction: args.direction });
    if (args.direction === 'in') Object.assign(patch, { unread_count: existing.unread_count + 1, archived: false });
    else if (args.markRead) patch.unread_count = 0;
    if (Object.keys(patch).length) await db.from('conversations').update(patch).eq('id', existing.id);
    return existing.id;
  }
  const { data: created, error: insErr } = await db
    .from('conversations')
    .insert({
      workspace_id: args.workspaceId,
      account_id: args.accountId,
      lead_id: args.leadId,
      last_message_at: args.at,
      last_message_preview: preview,
      last_direction: args.direction,
      unread_count: args.direction === 'in' ? 1 : 0,
    })
    .select('id')
    .single();
  if (insErr) {
    // Lost a race with another writer: use theirs.
    const { data: again } = await db.from('conversations').select('id').eq('account_id', args.accountId).eq('lead_id', args.leadId).maybeSingle();
    if (again) return again.id;
    throw new Error(`conversation insert failed: ${insErr.message}`);
  }
  return created.id;
}

// ---------------------------------------------------------------------------
// Per-number daily send counters (in the workspace's time zone)
// ---------------------------------------------------------------------------

const counters = new Map<string, { day: string; total: number; byCampaign: Map<string, number> }>();

async function counterFor(accountId: string, timezone: string) {
  const day = localDayKey(new Date(), timezone);
  const c = counters.get(accountId);
  if (c && c.day === day) return c;
  // First use today: rebuild from the database so restarts don't reset limits.
  const start = new Date(Date.now() - 36 * 3600_000).toISOString();
  const { data, error } = await db
    .from('messages')
    .select('created_at, campaign_id')
    .eq('account_id', accountId)
    .eq('direction', 'out')
    .in('status', ['sending', 'sent', 'delivered', 'read'])
    .gte('created_at', start)
    .limit(5000);
  if (error) throw new Error(`counter load failed: ${error.message}`);
  const fresh = { day, total: 0, byCampaign: new Map<string, number>() };
  for (const m of data ?? []) {
    if (localDayKey(new Date(m.created_at), timezone) !== day) continue;
    fresh.total++;
    if (m.campaign_id) fresh.byCampaign.set(m.campaign_id, (fresh.byCampaign.get(m.campaign_id) ?? 0) + 1);
  }
  counters.set(accountId, fresh);
  return fresh;
}

export async function sentToday(accountId: string, timezone: string, campaignId?: string) {
  const c = await counterFor(accountId, timezone);
  return { total: c.total, campaign: campaignId ? (c.byCampaign.get(campaignId) ?? 0) : 0 };
}

export async function countSend(accountId: string, timezone: string, campaignId?: string | null) {
  try {
    const c = await counterFor(accountId, timezone);
    c.total++;
    if (campaignId) c.byCampaign.set(campaignId, (c.byCampaign.get(campaignId) ?? 0) + 1);
  } catch (e) {
    log.warn({ err: errMsg(e) }, 'counter update failed');
  }
}
