/**
 * Sends messages people typed in the dashboard (inbox, lead chat, automations).
 * They are queued as rows with status 'queued'; we send them in order, one at a
 * time per number, and record the result.
 */
import type { Lead } from '@batsols/shared';
import { db } from '../db';
import { log } from '../log';
import { countSend, firstStageOfKind, getWorkspace, settingsOf, stagesOf, touchConversation } from '../common';
import { errMsg, KeyedQueue, nowIso } from '../util';
import { mimeFromName } from '../wa/content';
import { NotConnectedError } from '../wa/session';
import type { SessionManager } from '../wa/manager';

const perAccount = new KeyedQueue();
const inFlight = new Set<string>();

export async function processOutbox(manager: SessionManager) {
  const { data, error } = await db
    .from('messages')
    .select('id, workspace_id, lead_id, account_id, body, media_url, media_type, media_name, sent_by')
    .eq('direction', 'out')
    .eq('status', 'queued')
    .order('created_at')
    .limit(50);
  if (error) throw new Error(`outbox load failed: ${error.message}`);

  for (const m of data ?? []) {
    if (inFlight.has(m.id)) continue;
    if (!m.account_id) {
      await db.from('messages').update({ status: 'failed', error: 'The WhatsApp number was removed' }).eq('id', m.id);
      continue;
    }
    const session = manager.openSession(m.account_id);
    if (!session) continue; // stays queued until the number is back
    inFlight.add(m.id);
    void perAccount
      .run(m.account_id, async () => {
        // Claim it (another tick may have raced us).
        const { data: claimed } = await db.from('messages').update({ status: 'sending' }).eq('id', m.id).eq('status', 'queued').select('id');
        if (!claimed?.length) return;

        const { data: lead } = await db.from('leads').select('id, phone, opted_out, stage_id, business_name').eq('id', m.lead_id).maybeSingle();
        if (!lead?.phone) {
          await db.from('messages').update({ status: 'failed', error: 'This lead has no phone number' }).eq('id', m.id);
          return;
        }
        if (lead.opted_out) {
          await db.from('messages').update({ status: 'failed', error: 'This lead opted out of messages' }).eq('id', m.id);
          return;
        }
        try {
          const waId = await session.send(lead.phone, {
            text: m.body,
            mediaUrl: m.media_url,
            mediaType: m.media_type,
            mediaName: m.media_name,
            mimetype: mimeFromName(m.media_name ?? m.media_url),
          });
          const at = nowIso();
          const conversationId = await touchConversation({
            workspaceId: m.workspace_id,
            accountId: m.account_id!,
            leadId: lead.id,
            preview: m.body || m.media_name || 'Attachment',
            direction: 'out',
            at,
            markRead: Boolean(m.sent_by),
          });
          await db.from('messages').update({ status: 'sent', wa_message_id: waId, conversation_id: conversationId, error: null }).eq('id', m.id);

          const ws = await getWorkspace(m.workspace_id);
          const patch: Partial<Lead> = { last_contacted_at: at, wa_status: 'valid' };
          if (settingsOf(ws).auto_stage_on_send && lead.stage_id) {
            const current = (await stagesOf(m.workspace_id)).find((s) => s.id === lead.stage_id);
            if (current?.kind === 'new') {
              const contacted = await firstStageOfKind(m.workspace_id, 'contacted');
              if (contacted) patch.stage_id = contacted;
            }
          }
          await db.from('leads').update(patch).eq('id', lead.id);
          await countSend(m.account_id!, ws?.timezone ?? 'UTC');
        } catch (e) {
          if (e instanceof NotConnectedError) {
            await db.from('messages').update({ status: 'queued' }).eq('id', m.id);
            return;
          }
          log.warn({ msg: m.id, err: errMsg(e) }, 'manual send failed');
          await db.from('messages').update({ status: 'failed', error: errMsg(e).slice(0, 300) }).eq('id', m.id);
        }
      })
      .catch((e) => log.error({ msg: m.id, err: errMsg(e) }, 'outbox task failed'))
      .finally(() => inFlight.delete(m.id));
  }
}

/** Messages stuck in 'sending' (engine crashed mid-send) are surfaced as failed so people can resend. */
export async function recoverStuckMessages() {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  await db
    .from('messages')
    .update({ status: 'failed', error: 'Sending was interrupted. It may not have been delivered — please resend.' })
    .eq('status', 'sending')
    .lt('updated_at', cutoff);
}

/** Emoji reactions people picked in the inbox (messages with reaction_out_pending). */
export async function processReactions(manager: SessionManager) {
  const { data, error } = await db
    .from('messages')
    .select('id, lead_id, account_id, direction, wa_message_id, reaction_out')
    .eq('reaction_out_pending', true)
    .order('updated_at')
    .limit(50);
  if (error) throw new Error(`reaction queue load failed: ${error.message}`);

  for (const m of data ?? []) {
    const flight = `reaction:${m.id}`;
    if (inFlight.has(flight)) continue;
    if (!m.account_id || !m.wa_message_id) {
      await db.from('messages').update({ reaction_out_pending: false }).eq('id', m.id);
      continue;
    }
    const session = manager.openSession(m.account_id);
    if (!session) continue; // waits until the number is back
    inFlight.add(flight);
    void perAccount
      .run(m.account_id, async () => {
        const { data: lead } = await db.from('leads').select('phone').eq('id', m.lead_id).maybeSingle();
        let sent = Boolean(lead?.phone);
        if (lead?.phone) {
          try {
            await session.react(lead.phone, { id: m.wa_message_id!, fromMe: m.direction === 'out' }, m.reaction_out ?? '');
          } catch (e) {
            if (e instanceof NotConnectedError) return; // retried on the next tick
            log.warn({ msg: m.id, err: errMsg(e) }, 'reaction failed');
            sent = false;
          }
        }
        // Leave it pending if someone picked a different emoji meanwhile.
        let done = db.from('messages').update(sent ? { reaction_out_pending: false } : { reaction_out_pending: false, reaction_out: null }).eq('id', m.id);
        done = m.reaction_out === null ? done.is('reaction_out', null) : done.eq('reaction_out', m.reaction_out);
        await done;
      })
      .catch((e) => log.error({ msg: m.id, err: errMsg(e) }, 'reaction task failed'))
      .finally(() => inFlight.delete(flight));
  }
}
