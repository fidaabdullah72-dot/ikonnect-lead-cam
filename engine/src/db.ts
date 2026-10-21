import { createClient } from '@supabase/supabase-js';
import type { Database } from '@batsols/shared';
import { config } from './config';

const options = { auth: { persistSession: false, autoRefreshToken: false } } as const;

/** Service-role client (bypasses RLS). Every query must scope by workspace itself. */
export const db = createClient<Database>(config.supabaseUrl, config.serviceRoleKey, options);

/**
 * Same, but tagged so DB triggers know the write came from an automation and
 * must not enqueue further automation events (prevents loops).
 */
export const dbAutomation = createClient<Database>(config.supabaseUrl, config.serviceRoleKey, {
  ...options,
  global: { headers: { 'x-batsols-automation': '1' } },
});

export type Db = typeof db;

/** Throw on PostgREST errors so callers can rely on try/catch. */
export function must<T>(res: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) {
    const err = new Error(`${what}: ${res.error.message}`) as Error & { code?: string };
    err.code = res.error.code;
    throw err;
  }
  return res.data;
}
