'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@batsols/shared';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@/lib/env';

let client: ReturnType<typeof createBrowserClient<Database>> | null = null;

/** Singleton browser client (RLS applies with the signed-in user's session). */
export function getSupabase() {
  if (!client) client = createBrowserClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY);
  return client;
}

export type Supabase = ReturnType<typeof getSupabase>;
