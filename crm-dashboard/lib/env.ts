export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');

export const isSupabaseConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const WORKSPACE_COOKIE = 'bs_ws';

/** Set by the proxy on signed-in requests: the verified user ({ id, email }), URI-encoded JSON. */
export const USER_HEADER = 'x-bs-user';
