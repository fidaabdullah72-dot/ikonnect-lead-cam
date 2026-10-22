import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { MemberPermissions, WorkspaceMember } from '@batsols/shared';
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

type Role = 'owner' | 'admin' | 'member' | 'viewer';

/** The signed-in caller and their role in the workspace (checked with their own session). */
async function caller(workspaceId: string): Promise<{ id: string; role: Role } | NextResponse> {
  const supabase = await createSupabaseServer();
  const { data: claims } = await supabase.auth.getClaims();
  const id = claims?.claims?.sub as string | undefined;
  if (!id) return NextResponse.json({ error: 'Your session has expired. Please sign in again.' }, { status: 401 });
  const { data: me } = await supabase.from('workspace_members').select('role, active').eq('workspace_id', workspaceId).eq('user_id', id).maybeSingle();
  if (!me?.active) return NextResponse.json({ error: 'You are not an active member of this workspace' }, { status: 403 });
  return { id, role: me.role as Role };
}

const Edit = z.object({
  workspace_id: z.string().uuid(),
  user_id: z.string().uuid(),
  full_name: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().max(80).nullable().optional(),
  role: z.enum(['owner', 'admin', 'member', 'viewer']).optional(),
  active: z.boolean().optional(),
  permissions: z.record(z.string(), z.unknown()).optional(),
  team_ids: z.array(z.string().uuid()).max(50).optional(),
  password: z.string().min(8).max(72).optional(),
});

/** Admins edit a teammate: name, job title, role, access, teams, permissions or password. */
export async function PATCH(request: Request) {
  const parsed = Edit.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });
  const input = parsed.data;
  const me = await caller(input.workspace_id);
  if (me instanceof NextResponse) return me;
  if (me.role !== 'owner' && me.role !== 'admin') return NextResponse.json({ error: 'Only admins can edit members' }, { status: 403 });

  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the web app' }, { status: 501 });
  const { data: target } = await admin.from('workspace_members').select('role, active').eq('workspace_id', input.workspace_id).eq('user_id', input.user_id).maybeSingle();
  if (!target) return NextResponse.json({ error: 'That person is not in this workspace' }, { status: 404 });
  const isOwnerChange = target.role === 'owner' || input.role === 'owner';
  if (isOwnerChange && me.role !== 'owner' && (input.role !== undefined || input.active !== undefined || input.password || input.full_name)) {
    return NextResponse.json({ error: 'Only owners can change an owner or make someone owner' }, { status: 403 });
  }
  if (input.active === false && (input.user_id === me.id || target.role === 'owner')) {
    return NextResponse.json({ error: input.user_id === me.id ? 'You can’t suspend yourself' : 'Owners can’t be suspended. Change their role first.' }, { status: 400 });
  }

  const patch: Partial<WorkspaceMember> = {};
  if (input.title !== undefined) patch.title = input.title || null;
  if (input.role !== undefined && input.user_id !== me.id) patch.role = input.role;
  if (input.active !== undefined) patch.active = input.active;
  if (input.permissions !== undefined) patch.permissions = input.permissions as MemberPermissions;
  if (Object.keys(patch).length) {
    const { error } = await admin.from('workspace_members').update(patch).eq('workspace_id', input.workspace_id).eq('user_id', input.user_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }

  if (input.team_ids !== undefined) {
    const { data: teams } = await admin.from('teams').select('id').eq('workspace_id', input.workspace_id);
    const valid = new Set((teams ?? []).map((t) => t.id));
    const wanted = input.team_ids.filter((id) => valid.has(id));
    await admin.from('team_members').delete().eq('workspace_id', input.workspace_id).eq('user_id', input.user_id);
    if (wanted.length) {
      const { error } = await admin.from('team_members').insert(wanted.map((team_id) => ({ team_id, workspace_id: input.workspace_id, user_id: input.user_id })));
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    }
  }

  if (input.full_name || input.password) {
    const { error } = await admin.auth.admin.updateUserById(input.user_id, {
      ...(input.password ? { password: input.password } : {}),
      ...(input.full_name ? { user_metadata: { full_name: input.full_name } } : {}),
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (input.full_name) await admin.from('profiles').update({ full_name: input.full_name }).eq('id', input.user_id);
  }

  return NextResponse.json({ ok: true });
}

const Remove = z.object({ workspace_id: z.string().uuid(), user_id: z.string().uuid() });

/** Admins remove a teammate; anyone can leave. Their leads and history stay. */
export async function DELETE(request: Request) {
  const parsed = Remove.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  const input = parsed.data;
  const me = await caller(input.workspace_id);
  if (me instanceof NextResponse) return me;
  const self = input.user_id === me.id;
  if (!self && me.role !== 'owner' && me.role !== 'admin') return NextResponse.json({ error: 'Only admins can remove members' }, { status: 403 });

  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the web app' }, { status: 501 });
  const { data: target } = await admin.from('workspace_members').select('role').eq('workspace_id', input.workspace_id).eq('user_id', input.user_id).maybeSingle();
  if (!target) return NextResponse.json({ ok: true });
  if (target.role === 'owner' && !self && me.role !== 'owner') return NextResponse.json({ error: 'Only owners can remove an owner' }, { status: 403 });
  if (target.role === 'owner') {
    const { count } = await admin.from('workspace_members').select('user_id', { count: 'exact', head: true }).eq('workspace_id', input.workspace_id).eq('role', 'owner');
    if ((count ?? 0) <= 1) return NextResponse.json({ error: 'A workspace needs at least one owner. Make someone else owner first.' }, { status: 400 });
  }
  const { error } = await admin.from('workspace_members').delete().eq('workspace_id', input.workspace_id).eq('user_id', input.user_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

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
