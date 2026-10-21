import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSupabaseAdmin } from '@/lib/supabase/admin';

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, 'Password must be at least 8 characters').max(72),
  full_name: z.string().trim().min(1).max(80),
  invite_token: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

/**
 * Creates an already-confirmed account so teams don't depend on Supabase's
 * email sending. Public sign-up can be switched off with DISABLE_SIGNUP=true;
 * invite links keep working.
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });
  }
  const { email, password, full_name, invite_token } = parsed.data;

  const admin = createSupabaseAdmin();
  if (!admin) {
    // No service key configured: the browser falls back to supabase.auth.signUp().
    return NextResponse.json({ fallback: true }, { status: 501 });
  }

  if (invite_token) {
    const { data: invite } = await admin
      .from('workspace_invites')
      .select('email, expires_at, accepted_at')
      .eq('token', invite_token)
      .maybeSingle();
    if (!invite || invite.accepted_at || new Date(invite.expires_at) < new Date()) {
      return NextResponse.json({ error: 'This invite link is no longer valid.' }, { status: 400 });
    }
    if (invite.email && invite.email.toLowerCase() !== email) {
      return NextResponse.json({ error: `This invite is for ${invite.email}.` }, { status: 400 });
    }
  } else if (process.env.DISABLE_SIGNUP === 'true') {
    return NextResponse.json({ error: 'Sign-up is disabled. Ask your admin for an invite link.' }, { status: 403 });
  }

  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name },
  });
  if (error) {
    const exists = /already|registered|exists/i.test(error.message);
    return NextResponse.json(
      { error: exists ? 'An account with this email already exists. Sign in instead.' : error.message },
      { status: exists ? 409 : 400 },
    );
  }
  return NextResponse.json({ ok: true });
}
