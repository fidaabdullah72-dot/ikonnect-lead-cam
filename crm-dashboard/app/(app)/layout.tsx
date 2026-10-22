import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { MemberPermissions, Profile, Role, Workspace } from '@batsols/shared';
import { AppShell } from '@/components/shell/app-shell';
import { WorkspaceProvider, type SessionData } from '@/lib/workspace';
import { createSupabaseServer } from '@/lib/supabase/server';
import { USER_HEADER, WORKSPACE_COOKIE } from '@/lib/env';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createSupabaseServer();
  // The proxy already verified the session for this request; ask Supabase only if it didn't say who.
  const verified = (await headers()).get(USER_HEADER);
  const user: { id: string; email?: string; created_at?: string; user_metadata?: Record<string, unknown> } | null = verified
    ? (JSON.parse(decodeURIComponent(verified)) as { id: string; email: string })
    : (await supabase.auth.getUser()).data.user;
  if (!user) redirect('/login');

  const [{ data: memberships }, { data: profile }] = await Promise.all([
    supabase.from('workspace_members').select('role, permissions, workspace:workspaces(*)').eq('user_id', user.id),
    supabase.from('profiles').select('*').eq('id', user.id).maybeSingle(),
  ]);

  const list = ((memberships ?? []) as unknown as Array<{ role: Role; permissions: MemberPermissions | null; workspace: Workspace | null }>).filter(
    (m): m is { role: Role; permissions: MemberPermissions | null; workspace: Workspace } => !!m.workspace,
  );
  if (!list.length) redirect('/onboarding');

  const preferred = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const current = list.find((m) => m.workspace.id === preferred) ?? list[0]!;

  const session: SessionData = {
    userId: user.id,
    email: user.email ?? '',
    profile: (profile as Profile | null) ?? {
      id: user.id,
      email: user.email ?? '',
      full_name: (user.user_metadata?.full_name as string) ?? '',
      avatar_url: null,
      created_at: user.created_at ?? new Date().toISOString(),
      updated_at: user.created_at ?? new Date().toISOString(),
    },
    workspace: current.workspace,
    role: current.role,
    permissions: current.permissions ?? {},
    workspaces: list.map((m) => ({ id: m.workspace.id, name: m.workspace.name, role: m.role })).sort((a, b) => a.name.localeCompare(b.name)),
  };

  return (
    <WorkspaceProvider initial={session} key={current.workspace.id}>
      <AppShell>{children}</AppShell>
    </WorkspaceProvider>
  );
}
