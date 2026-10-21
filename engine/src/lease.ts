/**
 * Exactly one engine may drive WhatsApp at a time: two engines on the same
 * session make WhatsApp kick the device ("connection replaced") and can log
 * it out. During a Render redeploy the new instance waits here until the old
 * one releases the lease (graceful shutdown) or lets it expire (crash).
 */
import { db } from './db';
import { config } from './config';
import { log } from './log';
import { sleep } from './util';

export async function acquireLease(): Promise<void> {
  let waited = 0;
  for (;;) {
    const { data, error } = await db.rpc('engine_acquire_lease', { p_instance: config.instanceId, p_ttl_seconds: config.leaseTtlSeconds });
    if (error) {
      log.error({ err: error.message }, 'lease query failed; retrying');
    } else if (data) {
      log.info({ instance: config.instanceId }, 'engine lease acquired');
      return;
    } else if (waited % 15 === 0) {
      log.info({ waited }, 'another engine holds the lease; waiting for it to hand over');
    }
    await sleep(3000);
    waited += 3;
  }
}

/** Renew; returns false if another instance took over (we must stop immediately). */
export async function renewLease(info: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await db.rpc('engine_acquire_lease', { p_instance: config.instanceId, p_ttl_seconds: config.leaseTtlSeconds });
  if (error) {
    log.warn({ err: error.message }, 'lease renew failed (will retry)');
    return true; // transient DB error: keep running, the TTL gives us slack
  }
  if (!data) return false;
  await db
    .from('engine_status')
    .update({ heartbeat_at: new Date().toISOString(), version: config.version, info })
    .eq('id', 'main');
  return true;
}

export async function releaseLease() {
  await db.rpc('engine_release_lease', { p_instance: config.instanceId });
}
