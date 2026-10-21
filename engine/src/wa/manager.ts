/**
 * Keeps live sessions in line with what users asked for in the dashboard
 * (whatsapp_accounts.desired_state), and routes events to the handlers.
 */
import type { WAMessage, WAMessageKey, WAMessageUpdate, proto } from 'baileys';
import { db } from '../db';
import { log } from '../log';
import { errMsg, sleep } from '../util';
import { hasStoredSession } from './auth-state';
import { WaSession, type AccountInfo, type SessionHooks } from './session';

export class SessionManager {
  private sessions = new Map<string, WaSession>();
  private busy = new Set<string>();
  private missed = false;
  /** Called when a reconcile skipped a busy number and that work has now finished. */
  onSettled: (() => void) | null = null;
  private hooks: SessionHooks;

  constructor(handlers: {
    onMessages: (s: WaSession, upsert: { messages: WAMessage[]; type: string }) => Promise<void>;
    onUpdates: (s: WaSession, updates: WAMessageUpdate[]) => Promise<void>;
    getMessage: (s: WaSession, key: WAMessageKey) => Promise<proto.IMessage | undefined>;
  }) {
    this.hooks = handlers;
  }

  get(accountId: string): WaSession | undefined {
    return this.sessions.get(accountId);
  }

  openSession(accountId: string): WaSession | null {
    const s = this.sessions.get(accountId);
    return s?.isOpen ? s : null;
  }

  stats() {
    let connected = 0;
    for (const s of this.sessions.values()) if (s.isOpen) connected++;
    return { sessions: this.sessions.size, connected };
  }

  /** One reconcile pass over every account in the database. */
  async reconcile() {
    const { data, error } = await db
      .from('whatsapp_accounts')
      .select('id, workspace_id, owner_id, label, desired_state, status, pairing_phone, disconnect_count');
    if (error) throw new Error(`accounts load failed: ${error.message}`);
    const seen = new Set<string>();

    for (const a of data ?? []) {
      seen.add(a.id);
      if (this.busy.has(a.id)) {
        this.missed = true; // look again once the current task finishes
        continue;
      }
      const info: AccountInfo = {
        id: a.id,
        workspace_id: a.workspace_id,
        owner_id: a.owner_id,
        label: a.label,
        pairing_phone: a.pairing_phone,
        disconnect_count: a.disconnect_count ?? 0,
      };
      const existing = this.sessions.get(a.id);
      if (existing) {
        existing.account = { ...existing.account, label: info.label, owner_id: info.owner_id };
        // A pairing code was requested while a QR was showing: restart into pairing mode.
        if (a.pairing_phone && !existing.account.pairing_phone && (existing.phase === 'qr' || existing.phase === 'connecting')) {
          existing.account.pairing_phone = a.pairing_phone;
          this.task(a.id, async () => {
            await existing.stop();
            this.sessions.delete(a.id);
          });
          continue;
        }
      }

      if (a.desired_state === 'connected') {
        if (!existing || existing.phase === 'stopped') {
          this.task(a.id, () =>
            this.oneAtATime(async () => {
              const s = new WaSession(info, this.hooks);
              this.sessions.set(a.id, s);
              await s.start();
            }),
          );
        }
      } else if (a.desired_state === 'disconnected') {
        if (existing && existing.phase !== 'stopped') {
          this.task(a.id, async () => {
            await existing.stop({ status: 'disconnected', last_error: null });
            await db.from('whatsapp_link_codes').delete().eq('account_id', a.id);
            this.sessions.delete(a.id);
          });
        } else if (!existing && !['disconnected', 'logged_out', 'error'].includes(a.status)) {
          this.task(a.id, async () => {
            await db.from('whatsapp_accounts').update({ status: 'disconnected' }).eq('id', a.id);
          });
        }
      } else if (a.desired_state === 'logged_out') {
        if (existing) {
          this.task(a.id, async () => {
            await existing.logout();
            this.sessions.delete(a.id);
          });
        } else if (a.status !== 'logged_out' || (await hasStoredSession(a.id))) {
          this.task(a.id, async () => {
            const s = new WaSession(info, this.hooks);
            await s.logout();
          });
        }
      }
    }

    // Accounts deleted from the dashboard: drop their sessions (credentials go with the row).
    for (const [id, s] of this.sessions) {
      if (!seen.has(id)) {
        this.task(id, async () => {
          await s.stop();
          this.sessions.delete(id);
        });
      }
    }
  }

  private startChain: Promise<void> = Promise.resolve();
  /** Start numbers one at a time, a few seconds apart: a burst of WhatsApp handshakes starves small servers. */
  private oneAtATime(fn: () => Promise<void>): Promise<void> {
    const run = this.startChain.then(fn);
    this.startChain = run.then(
      () => sleep(4000),
      () => sleep(4000),
    );
    return run;
  }

  private task(id: string, fn: () => Promise<void>) {
    this.busy.add(id);
    fn()
      .catch((e) => log.error({ acc: id, err: errMsg(e) }, 'session task failed'))
      .finally(() => {
        this.busy.delete(id);
        if (this.missed && !this.busy.size) {
          this.missed = false;
          this.onSettled?.();
        }
      });
  }

  async watchdog() {
    for (const s of this.sessions.values()) {
      await s.watchdog().catch((e) => log.warn({ acc: s.accountId, err: errMsg(e) }, 'watchdog failed'));
    }
  }

  async refreshLimits() {
    for (const s of this.sessions.values()) if (s.isOpen) await s.refreshLimits();
  }

  /** Close every socket but keep credentials, so the next engine resumes instantly. */
  async shutdown() {
    await Promise.all([...this.sessions.values()].map((s) => s.stop().catch(() => undefined)));
    this.sessions.clear();
  }
}
