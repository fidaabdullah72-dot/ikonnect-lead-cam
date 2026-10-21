'use client';

import { getSupabase } from '@/lib/supabase/client';

/**
 * Create an account and sign in. Uses the server route (confirmed account, no
 * email round-trip) and falls back to Supabase's own sign-up when the server
 * has no service-role key.
 * Returns 'signed_in' or 'confirm_email'.
 */
export async function createAccount(input: {
  email: string;
  password: string;
  full_name: string;
  invite_token?: string;
}): Promise<'signed_in' | 'confirm_email'> {
  const res = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const supabase = getSupabase();

  if (res.status === 501) {
    const { data, error } = await supabase.auth.signUp({
      email: input.email,
      password: input.password,
      options: { data: { full_name: input.full_name } },
    });
    if (error) throw error;
    return data.session ? 'signed_in' : 'confirm_email';
  }

  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? 'Could not create your account');

  const { error } = await supabase.auth.signInWithPassword({ email: input.email, password: input.password });
  if (error) throw error;
  return 'signed_in';
}

export function guessTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
