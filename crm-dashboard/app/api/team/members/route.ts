import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createSupabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServer } from '@/lib/supabase/server';

const Body = z.object({
  workspace_id: z.string().uuid(),
  email: z.string().trim().toLowerCase().email(),
  full_name: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(72).optional(),
  role: z.enum(['admin', 'member', 'viewer']),
  title: z.string().trim().max(80).optional(),
  team_ids: z.array(z.string().uuid()).max(20).default([]),
  permissions: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Admins add a teammate directly (no email round-trip): creates the account if
 * needed, adds them to the workspace with a role, teams and permissions.
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });
  const input = parsed.data;

  // Authorise with the caller's own session (RLS): only admins of this workspace.
  const supabase = await createSupabaseServer();
  const { data: claims } = await supabase.auth.getClaims();
  const callerId = claims?.claims?.sub as string | undefined;
  if (!callerId) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { data: me } = await supabase.from('workspace_members').select('role, active').eq('workspace_id', input.workspace_id).eq('user_id', callerId).maybeSingle();
  if (!me?.active || (me.role !== 'owner' && me.role !== 'admin')) return NextResponse.json({ error: 'Only admins can add members' }, { status: 403 });

  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the web app' }, { status: 501 });

  const password = input.password ?? `${randomBytes(6).toString('base64url')}-${randomBytes(3).toString('hex')}`;
  let userId: string | null = null;
  let created = false;
  const { data: createdUser, error: createErr } = await admin.auth.admin.createUser({
    email: input.email,
    password,
    email_confirm: true,
    user_metadata: { full_name: input.full_name },
  });
  if (createdUser?.user) {
    userId = createdUser.user.id;
    created = true;
  } else if (createErr && /already|registered|exists/i.test(createErr.message)) {
    const { data: profile } = await admin.from('profiles').select('id').eq('email', input.email).maybeSingle();
    userId = profile?.id ?? null;
  }
  if (!userId) return NextResponse.json({ error: createErr?.message ?? 'Could not create the account' }, { status: 400 });

  const { error: memErr } = await admin
    .from('workspace_members')
    .upsert(
      { workspace_id: input.workspace_id, user_id: userId, role: input.role, active: true, title: input.title ?? null, permissions: input.permissions },
      { onConflict: 'workspace_id,user_id' },
    );
  if (memErr) return NextResponse.json({ error: memErr.message }, { status: 400 });

  if (input.team_ids.length) {
    const { data: teams } = await admin.from('teams').select('id').eq('workspace_id', input.workspace_id).in('id', input.team_ids);
    if (teams?.length) {
      await admin.from('team_members').upsert(
        teams.map((t) => ({ team_id: t.id, workspace_id: input.workspace_id, user_id: userId! })),
        { onConflict: 'team_id,user_id', ignoreDuplicates: true },
      );
    }
  }

  return NextResponse.json({ user_id: userId, created, password: created ? password : null });
}
