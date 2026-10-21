import 'server-only';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@batsols/shared';
import { SUPABASE_URL } from '@/lib/env';

/** Service-role client. Bypasses RLS — only for narrowly scoped server routes. */
export function createSupabaseAdmin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createClient<Database>(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
