/**
 * One live WhatsApp connection (one linked device) per account.
 *
 * Reliability rules:
 *  - credentials live in Postgres, so restarts reconnect without a new QR
 *  - any non-fatal close reconnects with capped exponential backoff, forever
 *  - "restart required" (515, normal right after pairing) reconnects at once
 *  - "connection replaced" (440) means another client took the session: back
 *    off, and stop after repeated conflicts instead of fighting over it
 *  - only "logged out" (401) / "multi-device mismatch" (411) wipe the session
 *  - a watchdog recreates sockets stuck in "connecting"
 */
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  generateMessageIDV2,
  isJidBroadcast,
  isJidNewsletter,
  isJidStatusBroadcast,
  type AnyMessageContent,
  type ConnectionState,
  type WAMessage,
  type WAMessageKey,
  type WAMessageUpdate,
  type WASocket,
  type proto,
} from 'baileys';
import type { Boom } from '@hapi/boom';
import { SAFE_CHECKS_PER_DAY, jidToDigits, toWhatsAppJid, typingDurationMs, type WhatsappAccount } from '@batsols/shared';
import { db } from '../db';
import { baileysLogger, log } from '../log';
import { adminsOf, notify } from '../common';
import { errMsg, sleep } from '../util';
import { clearSession, useDbAuthState } from './auth-state';

export interface AccountInfo {
  id: string;
  workspace_id: string;
  owner_id: string | null;
  label: string;
  pairing_phone: string | null;
  disconnect_count: number;
}

export interface SessionHooks {
  onMessages: (s: WaSession, upsert: { messages: WAMessage[]; type: string }) => Promise<void>;
  onUpdates: (s: WaSession, updates: WAMessageUpdate[]) => Promise<void>;
  getMessage: (s: WaSession, key: WAMessageKey) => Promise<proto.IMessage | undefined>;
}

export class NotConnectedError extends Error {
  constructor(label: string) {
    super(`WhatsApp number “${label}” is not connected`);
  }
}

/** Safe mode: this number has used today's look-ups ("is this number on WhatsApp?"). */
export class CheckLimitError extends Error {
  constructor(label: string) {
    super(`“${label}” has used today's ${SAFE_CHECKS_PER_DAY} WhatsApp number checks (safe mode)`);
  }
}

/** Safe mode: after WhatsApp restricts a number it rests at least this long, and its daily limit is halved. */
const RESTRICTION_PAUSE_MS = 48 * 3600_000;
const MIN_DAILY_LIMIT_AFTER_RESTRICTION = 10;

const MAX_QR_ROUNDS = 6; // ~3 minutes of QR codes before giving up
const BACKOFF = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000];
const STUCK_CONNECTING_MS = 120_000;
const NOTIFY_AFTER_DOWN_MS = 3 * 60_000;

let versionCache: { at: number; version: [number, number, number] } | null = null;
async function waVersion(): Promise<[number, number, number] | undefined> {
  if (versionCache && Date.now() - versionCache.at < 6 * 3600_000) return versionCache.version;
  try {
    const { version } = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(8_000) });
    versionCache = { at: Date.now(), version: version as [number, number, number] };
    return versionCache.version;
  } catch {
    return versionCache?.version; // fall back to Baileys' bundled version
  }
}

type Phase = 'idle' | 'connecting' | 'qr' | 'pairing' | 'open' | 'backoff' | 'stopped';

export class WaSession {
  readonly accountId: string;
  account: AccountInfo;
  sock: WASocket | null = null;
  phase: Phase = 'idle';
  /** Digits of the connected number. */
  phone: string | null = null;

  private generation = 0;
  private attempts = 0;
  private qrRounds = 0;
  private conflicts = 0;
  private pairingRequested = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private phaseSince = Date.now();
  private everOpened = false;
  private downSince: number | null = null;
  private downNotified = false;
  private stopRequested = false;

  constructor(
    account: AccountInfo,
    private hooks: SessionHooks,
  ) {
    this.accountId = account.id;
    this.account = account;
  }

  get isOpen() {
    return this.phase === 'open' && !!this.sock;
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseSince = Date.now();
  }

  private async patchAccount(patch: Partial<WhatsappAccount>) {
    const { error } = await db.from('whatsapp_accounts').update(patch).eq('id', this.accountId);
    if (error) log.warn({ acc: this.accountId, err: error.message }, 'account update failed');
  }

  /** Update some fields of whatsapp_accounts.limits, keeping the others (WhatsApp's quota, check counters). */
  private async mergeLimits(patch: WhatsappAccount['limits'], extra: Partial<WhatsappAccount> = {}) {
    const { data } = await db.from('whatsapp_accounts').select('limits').eq('id', this.accountId).maybeSingle();
    await this.patchAccount({ ...extra, limits: { ...(data?.limits ?? {}), ...patch } });
  }

  /**
   * WhatsApp restricted this number (until `until`). Safe mode: it rests for at least 48 hours, and the first
   * time (not on every repeat of the same restriction) its daily limit is halved for good. Returns whether this
   * was a new restriction.
   */
  private async onRestricted(until: Date, type: string): Promise<boolean> {
    const { data: row } = await db.from('whatsapp_accounts').select('paused_until, daily_limit, limits').eq('id', this.accountId).maybeSingle();
    const now = Date.now();
    const known = row?.limits?.timelock_until ? new Date(row.limits.timelock_until).getTime() > now : false;
    // The 48 hours count from when the restriction is first seen; later checks of the same one don't extend them.
    const pausedUntil = Math.max(until.getTime(), known ? 0 : now + RESTRICTION_PAUSE_MS, row?.paused_until ? new Date(row.paused_until).getTime() : 0);
    const extra: Partial<WhatsappAccount> = { paused_until: new Date(pausedUntil).toISOString() };
    if (!known && row && row.daily_limit > MIN_DAILY_LIMIT_AFTER_RESTRICTION) {
      extra.daily_limit = Math.max(MIN_DAILY_LIMIT_AFTER_RESTRICTION, Math.floor(row.daily_limit / 2));
    }
    await this.mergeLimits({ timelock_until: until.toISOString(), timelock_type: type, checked_at: new Date().toISOString() }, extra);
    log.warn({ acc: this.accountId, until, pausedUntil: extra.paused_until, dailyLimit: extra.daily_limit }, 'WhatsApp restricted this number; resting it');
    return !known;
  }

  private checks: { day: string; used: number } | null = null;

  /** Safe mode: count one number look-up; false once today's allowance is used. */
  private async takeCheck(): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    if (this.checks?.day !== day) {
      const { data } = await db.from('whatsapp_accounts').select('limits').eq('id', this.accountId).maybeSingle();
      const l = data?.limits;
      this.checks = { day, used: l?.checks_day === day ? Number(l.checks_used ?? 0) : 0 };
    }
    if (this.checks.used >= SAFE_CHECKS_PER_DAY) return false;
    this.checks.used++;
    await this.mergeLimits({ checks_day: day, checks_used: this.checks.used });
    return true;
  }

  private async setLinkCode(code: { qr?: string | null; pairing_code?: string | null } | null) {
    if (!code) {
      await db.from('whatsapp_link_codes').delete().eq('account_id', this.accountId);
      return;
    }
    await db
      .from('whatsapp_link_codes')
      .upsert({ account_id: this.accountId, workspace_id: this.account.workspace_id, qr: code.qr ?? null, pairing_code: code.pairing_code ?? null, updated_at: new Date().toISOString() });
  }

  async start() {
    this.stopRequested = false;
    if (this.phase !== 'idle' && this.phase !== 'stopped') return;
    await this.connect();
  }

  private async connect() {
    if (this.stopRequested) return;
    const gen = ++this.generation;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.setPhase('connecting');
    this.pairingRequested = false;
    await this.patchAccount({ status: 'connecting' });

    let sock: WASocket;
    try {
      const { state, saveCreds } = await useDbAuthState(this.accountId);
      const version = await waVersion();
      sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: state,
        logger: baileysLogger,
        browser: Browsers.macOS('Chrome'),
        markOnlineOnConnect: false, // keep the phone receiving notifications
        // Keep Baileys' default history policy (recent sync, no FULL sync): it delivers
        // the initial LID↔phone mappings that stable sessions depend on.
        syncFullHistory: false,
        connectTimeoutMs: 30_000,
        keepAliveIntervalMs: 25_000,
        defaultQueryTimeoutMs: 60_000,
        retryRequestDelayMs: 500,
        generateHighQualityLinkPreview: false,
        shouldIgnoreJid: (jid) => Boolean(isJidBroadcast(jid) || isJidNewsletter(jid) || isJidStatusBroadcast(jid)),
        getMessage: (key) => this.hooks.getMessage(this, key),
      });
      this.sock = sock;

      sock.ev.on('creds.update', () => {
        saveCreds().catch((e) => log.error({ acc: this.accountId, err: errMsg(e) }, 'saving credentials failed'));
      });
      sock.ev.on('connection.update', (u) => {
        if (gen !== this.generation) return;
        this.onConnectionUpdate(sock, u, state.creds.registered).catch((e) => log.error({ acc: this.accountId, err: errMsg(e) }, 'connection handler failed'));
      });
      sock.ev.on('messages.upsert', (upsert) => {
        if (gen !== this.generation) return;
        this.hooks.onMessages(this, upsert).catch((e) => log.error({ acc: this.accountId, err: errMsg(e) }, 'inbound handler failed'));
      });
      sock.ev.on('messages.update', (updates) => {
        if (gen !== this.generation) return;
        this.hooks.onUpdates(this, updates).catch((e) => log.error({ acc: this.accountId, err: errMsg(e) }, 'receipt handler failed'));
      });
    } catch (e) {
      log.error({ acc: this.accountId, err: errMsg(e) }, 'socket setup failed');
      this.scheduleReconnect(`setup failed: ${errMsg(e)}`);
    }
  }

  private async onConnectionUpdate(sock: WASocket, u: Partial<ConnectionState>, registered: boolean) {
    const { connection, lastDisconnect, qr, isNewLogin, reachoutTimeLock } = u;

    if (qr) {
      if (this.account.pairing_phone && !registered && !sock.authState.creds.registered) {
        if (!this.pairingRequested) {
          this.pairingRequested = true;
          try {
            const code = await sock.requestPairingCode(this.account.pairing_phone);
            const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
            await this.setLinkCode({ pairing_code: pretty });
            this.setPhase('pairing');
            await this.patchAccount({ status: 'pairing', last_error: null });
            log.info({ acc: this.accountId }, 'pairing code issued');
          } catch (e) {
            await this.patchAccount({ last_error: `Could not get a pairing code: ${errMsg(e)}. Scan the QR code instead.`, pairing_phone: null });
            this.account.pairing_phone = null;
          }
        }
        return;
      }
      this.qrRounds++;
      if (this.qrRounds > MAX_QR_ROUNDS) {
        log.info({ acc: this.accountId }, 'QR not scanned in time; stopping');
        await this.halt({ status: 'disconnected', desired_state: 'disconnected', last_error: 'The QR code expired before it was scanned. Click Connect to get a new one.' });
        return;
      }
      await this.setLinkCode({ qr });
      this.setPhase('qr');
      await this.patchAccount({ status: 'qr', last_error: null });
    }

    if (reachoutTimeLock) {
      if (reachoutTimeLock.isActive) {
        const until = reachoutTimeLock.timeEnforcementEnds ?? new Date(Date.now() + 3600_000);
        const fresh = await this.onRestricted(until, reachoutTimeLock.enforcementType ?? 'DEFAULT');
        if (fresh) await notify(this.account.workspace_id, [this.account.owner_id, ...(await adminsOf(this.account.workspace_id))], {
          type: 'whatsapp_disconnected',
          title: `WhatsApp paused sending on “${this.account.label}”`,
          body: `WhatsApp temporarily restricted new messages until ${until.toUTCString()}. BatWos rests this number for at least 48 hours and halves its daily limit.`,
          link: '/whatsapp',
        });
      }
    }

    if (connection === 'open') {
      const wasDown = this.downSince;
      this.setPhase('open');
      this.attempts = 0;
      this.qrRounds = 0;
      this.conflicts = 0;
      this.downSince = null;
      const me = sock.user;
      this.phone = jidToDigits(me?.id) ?? this.phone;
      await this.setLinkCode(null);
      await this.patchAccount({
        status: 'connected',
        phone: this.phone,
        display_name: me?.name ?? me?.verifiedName ?? null,
        connected_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        last_error: null,
        pairing_phone: null,
      });
      this.account.pairing_phone = null;
      log.info({ acc: this.accountId, phone: this.phone }, 'WhatsApp connected');
      if (isNewLogin || !this.everOpened) {
        if (isNewLogin) {
          await notify(this.account.workspace_id, [this.account.owner_id], {
            type: 'whatsapp_connected',
            title: `“${this.account.label}” is connected`,
            body: this.phone ? `+${this.phone} is ready to send.` : null,
            link: '/whatsapp',
          });
        }
      } else if (wasDown && this.downNotified) {
        await notify(this.account.workspace_id, [this.account.owner_id], {
          type: 'whatsapp_connected',
          title: `“${this.account.label}” is back online`,
          link: '/whatsapp',
        });
      }
      this.everOpened = true;
      this.downNotified = false;
      void this.refreshLimits();
      return;
    }

    if (connection === 'close') {
      this.sock = null;
      if (this.stopRequested) return;
      const err = lastDisconnect?.error as Boom | undefined;
      const code = err?.output?.statusCode;
      const reason = err?.message ?? 'connection closed';
      log.warn({ acc: this.accountId, code, reason }, 'WhatsApp connection closed');
      if (this.phase === 'open') {
        this.downSince = Date.now();
        this.account.disconnect_count++;
        await this.patchAccount({ last_disconnect_at: new Date().toISOString(), disconnect_count: this.account.disconnect_count });
      }

      if (code === DisconnectReason.loggedOut || code === DisconnectReason.multideviceMismatch) {
        await clearSession(this.accountId);
        await this.halt({
          status: 'logged_out',
          desired_state: 'logged_out',
          last_error: 'This device was logged out from the phone (or WhatsApp unlinked it). Scan a new QR code to reconnect.',
        });
        await notify(this.account.workspace_id, [this.account.owner_id, ...(await adminsOf(this.account.workspace_id))], {
          type: 'whatsapp_disconnected',
          title: `“${this.account.label}” was logged out`,
          body: 'Open WhatsApp numbers and scan the QR code again to reconnect.',
          link: '/whatsapp',
        });
        return;
      }
      if (code === DisconnectReason.forbidden) {
        await this.halt({ status: 'error', desired_state: 'disconnected', last_error: 'WhatsApp refused this number (403). It may be banned or restricted.' });
        await notify(this.account.workspace_id, [this.account.owner_id, ...(await adminsOf(this.account.workspace_id))], {
          type: 'whatsapp_disconnected',
          title: `WhatsApp blocked “${this.account.label}”`,
          body: 'WhatsApp returned 403 (forbidden). The number may be banned. Sending has stopped.',
          link: '/whatsapp',
        });
        return;
      }
      if (code === DisconnectReason.restartRequired) {
        await this.connect(); // normal right after pairing
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        this.conflicts++;
        if (this.conflicts >= 3) {
          await this.halt({
            status: 'error',
            desired_state: 'disconnected',
            last_error: 'Another session keeps taking over this device. Make sure only one BatWos engine is running, then reconnect.',
          });
          return;
        }
        this.scheduleReconnect('replaced by another session', 30_000);
        return;
      }
      this.scheduleReconnect(reason);
    }
  }

  private scheduleReconnect(reason: string, minDelay = 0) {
    if (this.stopRequested) return;
    const base = BACKOFF[Math.min(this.attempts, BACKOFF.length - 1)]!;
    const delay = Math.max(minDelay, base) + Math.floor(Math.random() * 1000);
    this.attempts++;
    this.setPhase('backoff');
    this.downSince ??= Date.now();
    void this.patchAccount({ status: 'connecting', last_error: this.attempts > 3 ? `Reconnecting… (${reason})` : null });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((e) => log.error({ acc: this.accountId, err: errMsg(e) }, 'reconnect failed'));
    }, delay);
    log.info({ acc: this.accountId, attempt: this.attempts, delay }, 'reconnect scheduled');
  }

  /** Called periodically by the manager. */
  async watchdog() {
    if (this.stopRequested) return;
    const now = Date.now();
    if (this.phase === 'connecting' && now - this.phaseSince > STUCK_CONNECTING_MS) {
      log.warn({ acc: this.accountId }, 'connection stuck; recreating socket');
      this.endSocket();
      this.scheduleReconnect('stuck while connecting');
    }
    if (this.phase === 'open') {
      void this.patchAccount({ last_seen_at: new Date().toISOString() });
    }
    if (this.downSince && !this.downNotified && this.everOpened && now - this.downSince > NOTIFY_AFTER_DOWN_MS) {
      this.downNotified = true;
      await notify(this.account.workspace_id, [this.account.owner_id], {
        type: 'whatsapp_disconnected',
        title: `“${this.account.label}” lost its connection`,
        body: 'BatWos keeps retrying automatically. If it doesn’t recover, check that the phone has internet.',
        link: '/whatsapp',
      });
    }
  }

  private endSocket() {
    const s = this.sock;
    this.sock = null;
    this.generation++; // ignore late events from the old socket
    if (s) {
      try {
        void s.end(undefined);
      } catch {
        /* already closed */
      }
    }
  }

  /** Stop without touching credentials (used on shutdown and "disconnect"). */
  async stop(patch?: Partial<WhatsappAccount>) {
    this.stopRequested = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.endSocket();
    this.setPhase('stopped');
    if (patch) await this.patchAccount(patch);
  }

  private async halt(patch: Partial<WhatsappAccount>) {
    await this.stop(patch);
    await this.setLinkCode(null);
  }

  /** Unlink this device from the phone and wipe the session. */
  async logout() {
    this.stopRequested = true;
    const s = this.sock;
    if (s && this.phase === 'open') {
      try {
        await s.logout('Logged out from BatWos');
      } catch (e) {
        log.warn({ acc: this.accountId, err: errMsg(e) }, 'logout call failed');
      }
    }
    this.endSocket();
    this.setPhase('stopped');
    await clearSession(this.accountId);
    await this.setLinkCode(null);
    await this.patchAccount({ status: 'logged_out', phone: null, connected_at: null });
  }

  /** Ask WhatsApp about restrictions and the new-chat quota. */
  async refreshLimits() {
    const s = this.sock;
    if (!s || !this.isOpen) return;
    try {
      const [lock, cap] = await Promise.all([s.fetchAccountReachoutTimelock().catch(() => null), s.fetchNewChatMessageCap().catch(() => null)]);
      const limits: WhatsappAccount['limits'] = { checked_at: new Date().toISOString() };
      if (cap) {
        limits.new_chat_quota = cap.total_quota ?? undefined;
        limits.new_chat_used = cap.used_quota ?? undefined;
        limits.cycle_end = cap.cycle_end_timestamp ? new Date(Number(cap.cycle_end_timestamp) * 1000).toISOString() : undefined;
      }
      if (lock?.isActive && lock.timeEnforcementEnds) {
        await this.onRestricted(lock.timeEnforcementEnds, lock.enforcementType ?? 'DEFAULT');
      } else {
        limits.timelock_until = null;
      }
      await this.mergeLimits(limits);
    } catch (e) {
      log.debug({ acc: this.accountId, err: errMsg(e) }, 'limits refresh failed');
    }
  }

  private requireSocket(): WASocket {
    if (!this.sock || this.phase !== 'open') throw new NotConnectedError(this.account.label);
    return this.sock;
  }

  /** Is this number registered on WhatsApp? */
  async checkNumber(digits: string): Promise<boolean> {
    const s = this.requireSocket();
    if (!(await this.takeCheck())) throw new CheckLimitError(this.account.label);
    const res = await s.onWhatsApp(digits);
    return Boolean(res?.[0]?.exists);
  }

  async resolveLid(lid: string): Promise<string | null> {
    const s = this.sock;
    if (!s) return null;
    return s.signalRepository.lidMapping.getPNForLID(lid);
  }

  /** React to a message in the chat with `digits` ('' removes our reaction). */
  async react(digits: string, target: { id: string; fromMe: boolean }, emoji: string) {
    const s = this.requireSocket();
    const jid = toWhatsAppJid(digits);
    await s.sendMessage(jid, { react: { text: emoji, key: { remoteJid: jid, id: target.id, fromMe: target.fromMe } } });
  }

  private onlineTimer: NodeJS.Timeout | null = null;
  private online = false;

  /**
   * Look like a person with WhatsApp Web open: "online" while messages go out, "offline" again after a quiet
   * minute or two (until then the phone itself gets no notifications, as with WhatsApp Web).
   */
  private goOnline() {
    const s = this.sock;
    if (!s) return;
    if (!this.online) {
      this.online = true;
      s.sendPresenceUpdate('available').catch(() => undefined);
    }
    if (this.onlineTimer) clearTimeout(this.onlineTimer);
    this.onlineTimer = setTimeout(() => {
      this.onlineTimer = null;
      this.online = false;
      this.sock?.sendPresenceUpdate('unavailable').catch(() => undefined);
    }, 60_000 + Math.random() * 90_000);
    this.onlineTimer.unref?.();
  }

  /** Blue ticks a few seconds to a minute after a lead's message arrives, as when someone glances at the chat. */
  markReadSoon(key: WAMessageKey) {
    const timer = setTimeout(() => {
      const s = this.sock;
      if (!s || this.phase !== 'open') return;
      this.goOnline();
      s.readMessages([key]).catch((e) => log.debug({ acc: this.accountId, err: errMsg(e) }, 'read receipt failed'));
    }, 5_000 + Math.random() * 85_000);
    timer.unref?.();
  }

  /** Send a message, optionally showing "typing…" first. Returns the WhatsApp message id. */
  /** Ids of messages this engine sent recently, so WhatsApp's echo of them isn't saved a second time. */
  private readonly ownSends = new Map<string, number>();

  /** Whether WhatsApp's echo `id` is a message this engine sent (the send records it itself). */
  isOwnSend(id: string): boolean {
    const cutoff = Date.now() - 15 * 60_000;
    for (const [k, at] of this.ownSends) if (at < cutoff) this.ownSends.delete(k);
    return this.ownSends.has(id);
  }

  async send(digits: string, content: { text: string; mediaUrl?: string | null; mediaType?: string | null; mediaName?: string | null; mimetype?: string | null }, opts: { typing?: boolean } = {}) {
    const s = this.requireSocket();
    const jid = toWhatsAppJid(digits);
    if (opts.typing) {
      try {
        await s.sendPresenceUpdate('composing', jid);
        await sleep(typingDurationMs(content.text || 'x'));
        await s.sendPresenceUpdate('paused', jid);
      } catch {
        /* presence is best-effort */
      }
    }
    this.goOnline();
    let payload: AnyMessageContent;
    if (content.mediaUrl && content.mediaType === 'image') {
      payload = { image: { url: content.mediaUrl }, caption: content.text || undefined };
    } else if (content.mediaUrl && content.mediaType === 'video') {
      payload = { video: { url: content.mediaUrl }, caption: content.text || undefined };
    } else if (content.mediaUrl && content.mediaType === 'document') {
      payload = {
        document: { url: content.mediaUrl },
        mimetype: content.mimetype ?? 'application/octet-stream',
        fileName: content.mediaName ?? 'document',
        caption: content.text || undefined,
      };
    } else {
      payload = { text: content.text };
    }
    // Pick the id up front: WhatsApp echoes the message back (fromMe) before the caller has saved
    // it, and the echo must be recognised as this send rather than stored as a second message.
    const messageId = generateMessageIDV2(s.user?.id);
    this.ownSends.set(messageId, Date.now());
    const sent = await s.sendMessage(jid, payload, { messageId });
    const id = sent?.key?.id ?? messageId;
    if (id !== messageId) this.ownSends.set(id, Date.now());
    return id;
  }
}
