/**
 * Incoming WhatsApp traffic: replies, messages the user typed on their phone,
 * and delivery/read receipts.
 */
import { downloadMediaMessage, isJidGroup, proto, toNumber, type WAMessage, type WAMessageKey, type WAMessageUpdate } from 'baileys';
import { isOptOut, normalizePhone, type Lead, type RecipientStatus } from '@batsols/shared';
import { db } from '../db';
import { baileysLogger, log } from '../log';
import { firstStageOfKind, getWorkspace, logActivity, notify, settingsOf, stagesOf, touchConversation } from '../common';
import { errMsg, nowIso } from '../util';
import { extFromMime, extractContent, extractReaction, partnerDigits, previewOf } from '../wa/content';
import type { WaSession } from '../wa/session';

export type ReplyListener = (args: { workspaceId: string; leadId: string; accountId: string; text: string; firstReply: boolean }) => Promise<void>;

const replyListeners: ReplyListener[] = [];
export const onReply = (fn: ReplyListener) => replyListeners.push(fn);

const MAX_MEDIA_BYTES = 12 * 1024 * 1024;

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
  // Our own sends are recorded when we send them; skip their echoes.
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
  });
  if (insErr) throw new Error(`message insert failed: ${insErr.message}`);

  if (fromMe) {
    await db.from('leads').update({ last_contacted_at: at }).eq('id', lead.id);
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

  // Stop campaign sequences for this lead.
  const { data: active } = await db
    .from('campaign_recipients')
    .select('id, campaign_id, status, campaigns!inner(settings, status, created_by)')
    .eq('lead_id', lead.id)
    .in('status', ['pending', 'waiting', 'sending', 'completed']);
  for (const r of (active ?? []) as unknown as Array<{ id: string; campaign_id: string; status: string; campaigns: { settings: { stop_on_reply?: boolean }; created_by: string | null } }>) {
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
    await db
      .from('messages')
      .update({ status: mapped, ...(mapped === 'failed' ? { error: 'WhatsApp reported a delivery error' } : {}) })
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
