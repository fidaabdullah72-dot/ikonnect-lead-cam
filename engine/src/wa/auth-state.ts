/**
 * Baileys auth state persisted in Postgres (public.wa_auth_keys), so WhatsApp
 * sessions survive restarts and redeploys — Render's disk is wiped on deploy.
 *
 * Writes are serialised per account to keep set/delete ordering intact, and
 * reads are cached in memory by Baileys' cacheable key store wrapper.
 */
import { BufferJSON, initAuthCreds, makeCacheableSignalKeyStore, proto } from 'baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from 'baileys';
import { db } from '../db';
import { baileysLogger } from '../log';
import { chunk, KeyedQueue } from '../util';

const writes = new KeyedQueue();
const CREDS = 'creds';

const encode = (v: unknown) => JSON.stringify(v, BufferJSON.replacer);
const decode = <T>(v: string): T => JSON.parse(v, BufferJSON.reviver) as T;

async function readKeys(accountId: string, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunk(keys, 200)) {
    const { data, error } = await db.from('wa_auth_keys').select('key, value').eq('account_id', accountId).in('key', part);
    if (error) throw new Error(`auth read failed: ${error.message}`);
    for (const row of data ?? []) out.set(row.key, row.value);
  }
  return out;
}

async function writeKeys(accountId: string, upserts: Array<{ key: string; value: string }>, deletes: string[]) {
  for (const part of chunk(upserts, 300)) {
    const rows = part.map((r) => ({ account_id: accountId, key: r.key, value: r.value, updated_at: new Date().toISOString() }));
    const { error } = await db.from('wa_auth_keys').upsert(rows, { onConflict: 'account_id,key' });
    if (error) throw new Error(`auth write failed: ${error.message}`);
  }
  for (const part of chunk(deletes, 200)) {
    const { error } = await db.from('wa_auth_keys').delete().eq('account_id', accountId).in('key', part);
    if (error) throw new Error(`auth delete failed: ${error.message}`);
  }
}

export async function hasStoredSession(accountId: string): Promise<boolean> {
  const { data } = await db.from('wa_auth_keys').select('value').eq('account_id', accountId).eq('key', CREDS).maybeSingle();
  if (!data) return false;
  try {
    return Boolean(decode<AuthenticationCreds>(data.value).registered || decode<AuthenticationCreds>(data.value).me);
  } catch {
    return false;
  }
}

export async function clearSession(accountId: string): Promise<void> {
  await writes.run(accountId, async () => {
    const { error } = await db.from('wa_auth_keys').delete().eq('account_id', accountId);
    if (error) throw new Error(`auth clear failed: ${error.message}`);
  });
}

export async function useDbAuthState(accountId: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const stored = await readKeys(accountId, [CREDS]);
  const creds: AuthenticationCreds = stored.has(CREDS) ? decode<AuthenticationCreds>(stored.get(CREDS)!) : initAuthCreds();

  const keys = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const rows = await readKeys(
        accountId,
        ids.map((id) => `${type}-${id}`),
      );
      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const id of ids) {
        const raw = rows.get(`${type}-${id}`);
        if (!raw) continue;
        let value = decode<unknown>(raw);
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
        }
        result[id] = value as SignalDataTypeMap[T];
      }
      return result;
    },
    set: async (data: SignalDataSet) => {
      const upserts: Array<{ key: string; value: string }> = [];
      const deletes: string[] = [];
      for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
        const entries = data[category] ?? {};
        for (const id of Object.keys(entries)) {
          const value = entries[id];
          const key = `${category}-${id}`;
          if (value) upserts.push({ key, value: encode(value) });
          else deletes.push(key);
        }
      }
      await writes.run(accountId, () => writeKeys(accountId, upserts, deletes));
    },
    clear: async () => clearSession(accountId),
  };

  return {
    state: {
      creds,
      keys: makeCacheableSignalKeyStore(keys, baileysLogger),
    },
    saveCreds: () => writes.run(accountId, () => writeKeys(accountId, [{ key: CREDS, value: encode(creds) }], [])),
  };
}
