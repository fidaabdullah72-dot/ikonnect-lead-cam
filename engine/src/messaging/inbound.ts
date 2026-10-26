/**
 * Incoming WhatsApp traffic: replies, messages the user typed on their phone,
 * and delivery/read receipts.
 */
import { downloadMediaMessage, isJidGroup, proto, toNumber, type WAMessage, type WAMessageKey, type WAMessageUpdate } from 'baileys';
import { isOptOut, normalizePhone, type Lead, type RecipientStatus } from '@batsols/shared';
import { db } from '../db';
import { baileysLogger, log } from '../log';
import { firstStageOfKind, getWorkspace, logActivity, notify, settingsOf, stagesOf, touchConversation } from '../common';
import { errMsg, nowIso, sleep } from '../util';
import { extFromMime, extractContent, extractReaction, partnerDigits, previewOf } from '../wa/content';
import type { WaSession } from '../wa/session';

export type ReplyListener = (args: { workspaceId: string; leadId: string; accountId: string; text: string; firstReply: boolean }) => Promise<void>;

const replyListeners: ReplyListener[] = [];
export const onReply = (fn: ReplyListener) => replyListeners.push(fn);

const MAX_MEDIA_BYTES = 12 * 1024 * 1024;

/**
 * WhatsApp Business greeting and away messages are sent by the lead's phone the moment our message reaches it,
 * so they arrive within seconds of the send (or of the delivery tick, if the phone was offline). People need
 * longer than that to read a message and answer it.
 */
const AUTO_REPLY_WINDOW_MS = 20_000;
/** WhatsApp's message times are whole seconds and come from its servers, ours from this machine. */
const CLOCK_SKEW_MS = 5_000;

let replyColumns: { ok: boolean; checkedAt: number } | null = null;
/** Whether the database has messages.auto_reply and delivered_at (database update of 26 Oct 2026). */
async function hasReplyColumns(): Promise<boolean> {
  if (replyColumns && (replyColumns.ok || Date.now() - replyColumns.checkedAt < 5 * 60_000)) return replyColumns.ok;
  const { error } = await db.from('messages').select('auto_reply, delivered_at').limit(1);
  replyColumns = { ok: !error, checkedAt: Date.now() };
  if (error) log.warn('messages.auto_reply is missing: run the database update so automatic replies can be flagged');
  return replyColumns.ok;
}

/**
 * The campaign of the message an incoming message at `at` automatically answers, or null when it is a real reply:
 * it came within seconds of our last campaign message to this lead on this number being sent or delivered.
 */
async function autoReplyTo(accountId: string, leadId: string, at: string): Promise<string | null> {
  const t = Date.parse(at);
  const withDelivery = await hasReplyColumns();
  const fetchLast = async () => {
    const q = db
      .from('messages')
      .select(withDelivery ? 'id, campaign_id, status, created_at, delivered_at' : 'id, campaign_id, status, created_at')
      .eq('account_id', accountId)
      .eq('lead_id', leadId)
      .eq('direction', 'out')
      .not('campaign_id', 'is', null)
      .lte('created_at', new Date(t + CLOCK_SKEW_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(1);
    const { data } = await q.maybeSingle();
    return data as { id: string; campaign_id: string; status: string; created_at: string; delivered_at?: string | null } | null;
  };
  const near = (iso: string | null | undefined) => {
    if (!iso) return false;
    const gap = t - Date.parse(iso);
    return gap >= -CLOCK_SKEW_MS && gap <= AUTO_REPLY_WINDOW_MS;
  };
  let last = await fetchLast();
  if (!last) return null;
  if (near(last.created_at) || near(last.delivered_at)) return last.campaign_id;
  // Their phone has just received our message and the delivery tick is still on its way: check again shortly.
  if (withDelivery && last.status === 'sent' && !last.delivered_at) {
    await sleep(3000);
    last = await fetchLast();
    if (last && near(last.delivered_at)) return last.campaign_id;
  }
  return null;
}

async function storeMedia(session: WaSession, msg: WAMessage, workspaceId: string, mimetype: string | null): Promise<string | null> {
  try {
    const sock = session.sock;
    if (!sock) return null;
    const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage });
    if (!buf || buf.length > MAX_MEDIA_BYTES) return null;
    const path = `${workspaceId}/inbound/${msg.key.id ?? crypto.randomUUID()}.${extFromMime(mimetype)}`;
    const { error } = await db.storage.from('media').upload(path, buf, { contentType: mimetype ?? 'application/octet-stream', upsert: true });
    if (error) return null;
    return db.storage.from('media').getPublicUrl(path).data.publicUrl;
  } catch (e) {
    log.debug({ err: errMsg(e) }, 'media download failed');
    return null;
  }
}

export async function handleUpsert(session: WaSession, upsert: { messages: WAMessage[]; type: string }) {
  for (const msg of upsert.messages) {
    try {
      await handleOne(session, msg, upsert.type);
    } catch (e) {
      log.error({ acc: session.accountId, err: errMsg(e) }, 'inbound message failed');
    }
  }
}

async function handleOne(session: WaSession, msg: WAMessage, type: string) {
  const key = msg.key;
  if (!key.id || !key.remoteJid || isJidGroup(key.remoteJid)) return;
  const fromMe = Boolean(key.fromMe);
  // Our own sends are recorded when we send them; skip their echoes. The echo can arrive before
  // the send is saved, so the session's own list is checked first, then the database.
  if (fromMe && session.isOwnSend(key.id)) return;
  if (fromMe) {
    const { data: known } = await db.from('messages').select('id').eq('account_id', session.accountId).eq('wa_message_id', key.id).maybeSingle();
    if (known) return;
  }
  if (type !== 'notify' && !fromMe) return;

  const reaction = extractReaction(msg);
  if (reaction) return handleReaction(session, fromMe, reaction);

  const content = extractContent(msg);
  if (!content) return;
  const digits = await partnerDigits(key, (lid) => session.resolveLid(lid));
  if (!digits) {
    log.debug({ acc: session.accountId }, 'could not resolve sender number');
    return;
  }

  const workspaceId = session.account.workspace_id;
  const ws = await getWorkspace(workspaceId);
  if (!ws) return;
  const settings = settingsOf(ws);

  // Dedupe re-deliveries.
  const { data: dupe } = await db.from('messages').select('id').eq('account_id', session.accountId).eq('wa_message_id', key.id).maybeSingle();
  if (dupe) return;

  let { data: lead } = await db.from('leads').select('*').eq('workspace_id', workspaceId).eq('phone', digits).maybeSingle();
  if (!lead) {
    if (fromMe || !settings.capture_unknown_inbound) return; // personal chats stay private
    const n = normalizePhone(digits, ws.default_country);
    const { data: created, error } = await db
      .from('leads')
      .insert({
        workspace_id: workspaceId,
        business_name: msg.pushName?.trim() || `+${digits}`,
        contact_name: msg.pushName?.trim() || null,
        phone: digits,
        phone_type: n?.type ?? 'unknown',
        wa_status: 'valid',
        source: 'inbound',
        owner_id: session.account.owner_id,
      })
      .select('*')
      .single();
    if (error) {
      log.warn({ err: error.message }, 'inbound lead create failed');
      return;
    }
    lead = created;
  }

  const ts = msg.messageTimestamp ? toNumber(msg.messageTimestamp) : 0;
  const at = new Date((ts > 0 ? ts : Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const direction = fromMe ? 'out' : 'in';
  const autoReplyCampaign = fromMe ? null : await autoReplyTo(session.accountId, lead.id, at);
  const conversationId = await touchConversation({
    workspaceId,
    accountId: session.accountId,
    leadId: lead.id,
    preview: previewOf(content),
    direction,
    at,
    markRead: fromMe,
  });

  let mediaUrl: string | null = null;
  if (content.mediaType && ['image', 'document', 'audio', 'video', 'sticker'].includes(content.mediaType)) {
    mediaUrl = await storeMedia(session, msg, workspaceId, content.mimetype);
  }

  const { error: insErr } = await db.from('messages').insert({
    workspace_id: workspaceId,
    conversation_id: conversationId,
    lead_id: lead.id,
    account_id: session.accountId,
    direction,
    body: content.text,
    media_type: content.mediaType,
    media_url: mediaUrl,
    media_name: content.mediaName,
    wa_message_id: key.id,
    status: fromMe ? 'sent' : 'received',
    created_at: at,
    ...(autoReplyCampaign && (await hasReplyColumns()) ? { auto_reply: true } : {}),
  });
  if (insErr) throw new Error(`message insert failed: ${insErr.message}`);

  if (fromMe) {
    await db.from('leads').update({ last_contacted_at: at }).eq('id', lead.id);
    return;
  }

  // ---- An automatic reply: shown in the chat, but the lead hasn't answered yet -------
  if (autoReplyCampaign) {
    await db.from('campaign_events').insert({
      workspace_id: workspaceId,
      campaign_id: autoReplyCampaign,
      lead_id: lead.id,
      account_id: session.accountId,
      type: 'info',
      message: `${lead.business_name}: automatic reply, not counted as a reply`,
    });
    return;
  }

  // ---- A real reply from the lead -------------------------------------------------
  const firstReply = !lead.last_replied_at;
  const patch: Partial<Lead> = { last_replied_at: at, wa_status: 'valid' };
  if (settings.auto_stage_on_reply && lead.stage_id) {
    const stages = await stagesOf(workspaceId);
    const current = stages.find((s) => s.id === lead!.stage_id);
    if (current && (current.kind === 'new' || current.kind === 'contacted')) {
      const replied = await firstStageOfKind(workspaceId, 'replied');
      if (replied) patch.stage_id = replied;
    }
  }
  const optOut = isOptOut(content.text, settings.opt_out_keywords);
  if (optOut) patch.opted_out = true;
  await db.from('leads').update(patch).eq('id', lead.id);

  // Stop campaign sequences for this lead. A reply counts for a campaign only if that campaign messaged the lead
  // from this number before the reply; an opt-out cancels every campaign.
  const { data: active } = await db
    .from('campaign_recipients')
    .select('id, campaign_id, status, steps_sent, account_id, last_sent_at, campaigns!inner(settings, status, created_by)')
    .eq('lead_id', lead.id)
    .in('status', ['pending', 'waiting', 'sending', 'completed']);
  type ActiveRecipient = {
    id: string;
    campaign_id: string;
    status: string;
    steps_sent: number;
    account_id: string | null;
    last_sent_at: string | null;
    campaigns: { settings: { stop_on_reply?: boolean }; created_by: string | null };
  };
  for (const r of (active ?? []) as unknown as ActiveRecipient[]) {
    if (!optOut) {
      if (r.steps_sent === 0 || (r.account_id && r.account_id !== session.accountId)) continue;
      const { data: first } = await db.from('messages').select('created_at').eq('recipient_id', r.id).eq('direction', 'out').order('created_at').limit(1).maybeSingle();
      const firstAt = first?.created_at ?? r.last_sent_at;
      if (firstAt && Date.parse(at) < Date.parse(firstAt) - CLOCK_SKEW_MS) continue;
    }
    const stop = optOut || r.campaigns.settings?.stop_on_reply !== false || r.status === 'completed';
    const next: RecipientStatus = optOut ? 'cancelled' : stop ? 'replied' : (r.status as RecipientStatus);
    await db.from('campaign_recipients').update({ status: next, replied_at: at }).eq('id', r.id);
    await db.from('campaign_events').insert({
      workspace_id: workspaceId,
      campaign_id: r.campaign_id,
      lead_id: lead.id,
      account_id: session.accountId,
      type: optOut ? 'opted_out' : 'replied',
      message: `${lead.business_name}: ${content.text.slice(0, 120) || previewOf(content)}`,
    });
  }

  if (optOut) await logActivity(workspaceId, lead.id, 'opted_out', { via: 'reply', text: content.text.slice(0, 200) });
  else if (firstReply) await logActivity(workspaceId, lead.id, 'replied', { account_id: session.accountId });

  // Notify the lead's owner (or the number's owner), at most once per 10 minutes per chat.
  const { count: recent } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .gte('created_at', new Date(Date.now() - 10 * 60_000).toISOString());
  if ((recent ?? 0) <= 1) {
    await notify(workspaceId, [lead.owner_id ?? session.account.owner_id], {
      type: 'reply',
      title: `${lead.business_name} replied`,
      body: content.text.slice(0, 160) || previewOf(content),
      link: `/inbox?c=${conversationId}`,
    });
  }

  for (const fn of replyListeners) {
    await fn({ workspaceId, leadId: lead.id, accountId: session.accountId, text: content.text, firstReply }).catch((e) =>
      log.warn({ err: errMsg(e) }, 'reply listener failed'),
    );
  }
}

/** An emoji reaction to a message in the chat, by the lead or by us from the phone. */
async function handleReaction(session: WaSession, fromMe: boolean, reaction: { targetId: string; emoji: string }) {
  const { data: target } = await db
    .from('messages')
    .select('id, lead_id, body')
    .eq('account_id', session.accountId)
    .eq('wa_message_id', reaction.targetId)
    .maybeSingle();
  if (!target) return; // a message we never stored, e.g. a personal chat
  const emoji = reaction.emoji || null;
  if (fromMe) {
    await db.from('messages').update({ reaction_out: emoji }).eq('id', target.id);
    return;
  }
  await db.from('messages').update({ reaction_in: emoji }).eq('id', target.id);
  if (!emoji) return;

  const workspaceId = session.account.workspace_id;
  const { data: lead } = await db.from('leads').select('id, business_name, owner_id').eq('id', target.lead_id).maybeSingle();
  if (!lead) return;
  const quoted = target.body ? `“${target.body.slice(0, 60)}”` : 'your message';
  const conversationId = await touchConversation({
    workspaceId,
    accountId: session.accountId,
    leadId: lead.id,
    preview: `Reacted ${emoji} to ${quoted}`,
    direction: 'in',
    at: nowIso(),
  });
  await notify(workspaceId, [lead.owner_id ?? session.account.owner_id], {
    type: 'reply',
    title: `${lead.business_name} reacted ${emoji}`,
    body: target.body.slice(0, 160) || null,
    link: `/inbox?c=${conversationId}`,
  });
}

const STATUS_RANK: Record<string, number> = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4, failed: -1, received: 0 };
const DELIVERY_RANK: Record<string, number> = { none: 0, sent: 1, delivered: 2, read: 3 };

export async function handleUpdates(session: WaSession, updates: WAMessageUpdate[]) {
  for (const u of updates) {
    const status = u.update.status;
    if (status === undefined || status === null || !u.key.id || !u.key.fromMe) continue;
    const mapped =
      status === proto.WebMessageInfo.Status.SERVER_ACK
        ? 'sent'
        : status === proto.WebMessageInfo.Status.DELIVERY_ACK
          ? 'delivered'
          : status === proto.WebMessageInfo.Status.READ || status === proto.WebMessageInfo.Status.PLAYED
            ? 'read'
            : status === proto.WebMessageInfo.Status.ERROR
              ? 'failed'
              : null;
    if (!mapped) continue;
    const { data: m } = await db
      .from('messages')
      .select('id, status, recipient_id')
      .eq('account_id', session.accountId)
      .eq('wa_message_id', u.key.id)
      .maybeSingle();
    if (!m) continue;
    if (mapped !== 'failed' && (STATUS_RANK[mapped] ?? 0) <= (STATUS_RANK[m.status] ?? 0)) continue;
    // The moment it reached their phone, which is when a WhatsApp Business automatic reply goes out.
    const reached = (mapped === 'delivered' || mapped === 'read') && (STATUS_RANK[m.status] ?? 0) < STATUS_RANK.delivered! && (await hasReplyColumns());
    await db
      .from('messages')
      .update({
        status: mapped,
        ...(mapped === 'failed' ? { error: 'WhatsApp reported a delivery error' } : {}),
        ...(reached ? { delivered_at: nowIso() } : {}),
      })
      .eq('id', m.id);
    if (m.recipient_id && mapped !== 'failed') {
      const { data: r } = await db.from('campaign_recipients').select('delivery').eq('id', m.recipient_id).maybeSingle();
      if (r && (DELIVERY_RANK[mapped] ?? 0) > (DELIVERY_RANK[r.delivery] ?? 0)) {
        await db.from('campaign_recipients').update({ delivery: mapped as 'sent' | 'delivered' | 'read' }).eq('id', m.recipient_id);
      }
    }
  }
}

/** WhatsApp asks for a message's content when a recipient's device needs a retry. */
export async function getMessage(session: WaSession, key: WAMessageKey): Promise<proto.IMessage | undefined> {
  if (!key.id) return undefined;
  const { data } = await db.from('messages').select('body').eq('account_id', session.accountId).eq('wa_message_id', key.id).maybeSingle();
  return data ? { conversation: data.body } : undefined;
}
