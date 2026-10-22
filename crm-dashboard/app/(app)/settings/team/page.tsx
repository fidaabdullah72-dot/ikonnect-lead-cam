'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Copy, KeyRound, Link2, LogOut, MoreHorizontal, Plus, ShieldCheck, Smartphone, Trash2, UserCheck, UserMinus, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, STAGE_COLORS, type MemberPermissions, type Role, type WorkspaceInvite, type WorkspaceMember } from '@batsols/shared';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Checkbox, SwitchRow } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Callout, useConfirm } from '@/components/ui/feedback';
import { Field, Input, NativeSelect, PasswordInput } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/menu';
import { Table, Td, Th, Tr } from '@/components/ui/layout';
import { getSupabase } from '@/lib/supabase/client';
import { useTeams } from '@/lib/access';
import { qk, useAccounts, useMembers, type Member } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, errorMessage, timeAgo } from '@/lib/utils';
import { APP_URL } from '@/lib/env';

const inviteUrl = (token: string) => `${APP_URL || (typeof window !== 'undefined' ? window.location.origin : '')}/invite/${token}`;

type MemberRow = Member & Pick<WorkspaceMember, 'active' | 'title' | 'permissions'>;

function useMemberRows() {
  const { workspace } = useWorkspace();
  return useQuery({
    queryKey: ['member-rows', workspace.id],
    queryFn: async () => {
      const { data, error } = await getSupabase().from('workspace_members').select('user_id, role, created_at, active, title, permissions, profile:profiles(*)').eq('workspace_id', workspace.id).order('created_at');
      if (error) throw error;
      return data as unknown as MemberRow[];
    },
  });
}

type MemberEdit = Partial<Pick<WorkspaceMember, 'role' | 'active' | 'title' | 'permissions'>> & { full_name?: string; team_ids?: string[]; password?: string };

/** Edits/removals run on the server, which checks admin rights. Returns an error message, or null. */
async function memberApi(method: 'PATCH' | 'DELETE', body: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await fetch('/api/team/members', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return data.error ?? `Something went wrong (${res.status})`;
  } catch {
    return 'Network error — check your connection and try again';
  }
}

const PERMS: Array<{ key: keyof MemberPermissions; label: string; description: string; def: boolean }> = [
  { key: 'connect_whatsapp', label: 'Connect WhatsApp numbers', description: 'Link their own numbers', def: true },
  { key: 'create_campaigns', label: 'Create campaigns', description: 'Start their own campaigns', def: true },
  { key: 'scrape', label: 'Use the lead finder', description: 'See and run Google Maps lead searches (admins only by default)', def: false },
  { key: 'import', label: 'Import leads', description: 'Upload CSV files', def: true },
  { key: 'export', label: 'Export leads', description: 'Download lead CSVs', def: true },
  { key: 'delete_leads', label: 'Delete leads', description: 'Delete leads they own', def: false },
];

export default function TeamSettingsPage() {
  return (
    <React.Suspense>
      <TeamSettings />
    </React.Suspense>
  );
}

function TeamSettings() {
  const { workspace, userId, can, role: myRole } = useWorkspace();
  const rows = useMemberRows();
  const { accounts } = useAccounts();
  const { teams, teamsOf } = useTeams();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [inviteOpen, setInviteOpen] = React.useState(params.get('invite') === '1');
  const [addOpen, setAddOpen] = React.useState(false);
  const [perms, setPerms] = React.useState<MemberRow | null>(null);
  React.useEffect(() => {
    if (params.get('invite') === '1') {
      setAddOpen(true);
      router.replace(pathname, { scroll: false });
    }
  }, [params, pathname, router]);

  const invites = useQuery({
    queryKey: ['invites', workspace.id],
    enabled: can.admin,
    queryFn: async () => {
      const { data, error } = await getSupabase().from('workspace_invites').select('*').eq('workspace_id', workspace.id).is('accepted_at', null).order('created_at', { ascending: false });
      if (error) throw error;
      return data as WorkspaceInvite[];
    },
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['member-rows', workspace.id] });
    qc.invalidateQueries({ queryKey: qk.members(workspace.id) });
    qc.invalidateQueries({ queryKey: ['invites', workspace.id] });
    qc.invalidateQueries({ queryKey: ['teams', workspace.id] });
  };

  const update = async (m: MemberRow, patch: MemberEdit, msg: string) => {
    const error = await memberApi('PATCH', { workspace_id: workspace.id, user_id: m.user_id, ...patch });
    if (error) {
      toast.error(error);
      return false;
    }
    toast.success(msg);
    refresh();
    return true;
  };

  async function remove(m: MemberRow) {
    const self = m.user_id === userId;
    if (!(await confirm({ title: self ? `Leave ${workspace.name}?` : `Remove ${m.profile.full_name || m.profile.email}?`, description: self ? 'You lose access until invited again.' : 'They lose access immediately. Their leads and history stay. Their personal WhatsApp numbers stop sending.', confirmLabel: self ? 'Leave' : 'Remove', danger: true }))) return;
    const error = await memberApi('DELETE', { workspace_id: workspace.id, user_id: m.user_id });
    if (error) return toast.error(error);
    if (self) {
      router.replace('/dashboard');
      router.refresh();
      return;
    }
    refresh();
  }

  const roleOptions: Role[] = myRole === 'owner' ? ['owner', 'admin', 'member', 'viewer'] : ['admin', 'member', 'viewer'];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Members"
          description="Each member gets their own space: their WhatsApp numbers, campaigns and leads — plus whatever you share with them."
          action={
            can.admin && (
              <>
                <Button variant="secondary" size="sm" onClick={() => setInviteOpen(true)}>
                  <Link2 /> Invite link
                </Button>
                <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
                  <UserPlus /> Add member
                </Button>
              </>
            )
          }
        />
        <div className="overflow-x-auto">
          <Table className="md:min-w-[820px]">
            <thead>
              <tr>
                <Th>Member</Th>
                <Th>Role</Th>
                <Th className="hidden md:table-cell">Teams</Th>
                <Th className="hidden sm:table-cell">WhatsApp</Th>
                <Th className="hidden lg:table-cell">Joined</Th>
                <Th className="w-12" />
              </tr>
            </thead>
            <tbody>
              {(rows.data ?? []).map((m) => {
                const nums = accounts.filter((a) => a.owner_id === m.user_id);
                const editable = can.admin && (m.role !== 'owner' || myRole === 'owner');
                return (
                  <Tr key={m.user_id} className={cn(!m.active && 'opacity-60')}>
                    <Td>
                      <div className="flex items-center gap-3">
                        <Avatar name={m.profile.full_name || m.profile.email} src={m.profile.avatar_url} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 truncate font-medium">
                            {m.profile.full_name || '—'} {m.user_id === userId && <span className="text-xs font-normal text-subtle">(you)</span>}
                            {!m.active && <Badge tone="warning">Suspended</Badge>}
                          </div>
                          <div className="truncate text-xs text-muted">
                            {m.title ? `${m.title} · ` : ''}
                            {m.profile.email}
                          </div>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      {editable && m.user_id !== userId ? (
                        <NativeSelect inputSize="sm" className="w-28" value={m.role} onChange={(e) => update(m, { role: e.target.value as Role }, 'Role updated')}>
                          {roleOptions.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </NativeSelect>
                      ) : (
                        <Badge tone={m.role === 'owner' ? 'primary' : 'neutral'}>{ROLE_LABELS[m.role]}</Badge>
                      )}
                    </Td>
                    <Td className="hidden md:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {teamsOf(m.user_id).map((t) => (
                          <span key={t.id} className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-[11.5px]">
                            <span className="size-1.5 rounded-full" style={{ background: t.color }} /> {t.name}
                          </span>
                        ))}
                      </div>
                    </Td>
                    <Td className="hidden text-[13px] text-muted sm:table-cell">
                      <span className="inline-flex items-center gap-1.5">
                        <Smartphone className="size-3.5" />
                        {nums.filter((a) => a.status === 'connected').length}/{nums.length}
                      </span>
                    </Td>
                    <Td className="hidden text-[13px] text-muted lg:table-cell">{timeAgo(m.created_at)}</Td>
                    <Td>
                      {(editable || m.user_id === userId) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon-sm" variant="ghost" aria-label="Member actions">
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent className="w-56">
                            {editable && (
                              <DropdownMenuItem onSelect={() => setPerms(m)}>
                                <ShieldCheck /> Edit member & access
                              </DropdownMenuItem>
                            )}
                            {editable && m.user_id !== userId && m.role !== 'owner' && (
                              <DropdownMenuItem onSelect={() => update(m, { active: !m.active }, m.active ? 'Member suspended' : 'Member reactivated')}>
                                {m.active ? <Ban /> : <UserCheck />} {m.active ? 'Suspend access' : 'Reactivate'}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem danger onSelect={() => remove(m)}>
                              {m.user_id === userId ? <LogOut /> : <UserMinus />} {m.user_id === userId ? 'Leave workspace' : 'Remove from workspace'}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      </Card>

      <TeamsCard members={rows.data ?? []} />

      {can.admin && (
        <Card>
          <CardHeader title="Pending invite links" description="Links expire after 7 days and work once." />
          {invites.data?.length ? (
            <ul className="divide-y divide-border border-t border-border">
              {invites.data.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <Link2 className="size-4 text-subtle" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium">{inv.email ?? 'Anyone with the link'}</div>
                    <div className="text-xs text-muted">
                      {ROLE_LABELS[inv.role]} · expires {timeAgo(inv.expires_at)}
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard.writeText(inviteUrl(inv.token)); toast.success('Invite link copied'); }}>
                    <Copy /> Copy link
                  </Button>
                  <Button size="icon-sm" variant="ghost" onClick={async () => { await getSupabase().from('workspace_invites').delete().eq('id', inv.id); refresh(); }} aria-label="Revoke invite">
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="border-t border-border px-5 py-6 text-[13px] text-muted">No pending invites.</div>
          )}
        </Card>
      )}

      <Card>
        <CardHeader title="Roles" description="What each role can do." />
        <ul className="grid gap-px overflow-hidden border-t border-border bg-border sm:grid-cols-2">
          {(['owner', 'admin', 'member', 'viewer'] as Role[]).map((r) => (
            <li key={r} className="bg-surface px-5 py-3">
              <div className="text-[13px] font-medium">{ROLE_LABELS[r]}</div>
              <div className="text-xs text-muted">{ROLE_DESCRIPTIONS[r]}</div>
            </li>
          ))}
        </ul>
      </Card>

      <AddMemberDialog open={addOpen} onOpenChange={setAddOpen} onDone={refresh} teams={teams} />
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} onCreated={refresh} />
      <EditMemberDialog
        member={perms}
        self={perms?.user_id === userId}
        roleOptions={roleOptions}
        teams={teams}
        teamIds={perms ? teamsOf(perms.user_id).map((t) => t.id) : []}
        onClose={() => setPerms(null)}
        onSave={(patch) => perms && update(perms, patch, 'Member updated').then((ok) => ok && setPerms(null))}
      />
    </div>
  );
}

function AddMemberDialog({ open, onOpenChange, onDone, teams }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void; teams: ReturnType<typeof useTeams>['teams'] }) {
  const { workspace } = useWorkspace();
  const [form, setForm] = React.useState({ full_name: '', email: '', password: '', role: 'member' as Exclude<Role, 'owner'>, title: '', team_ids: [] as string[] });
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ email: string; password: string | null } | null>(null);
  React.useEffect(() => {
    if (open) {
      setForm({ full_name: '', email: '', password: '', role: 'member', title: '', team_ids: [] });
      setResult(null);
    }
  }, [open]);
  async function submit() {
    setBusy(true);
    const res = await fetch('/api/team/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspace.id, ...form, password: form.password || undefined, title: form.title || undefined }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; password?: string | null };
    setBusy(false);
    if (!res.ok) return toast.error(body.error ?? 'Could not add member');
    setResult({ email: form.email, password: body.password ?? null });
    onDone();
  }
  const loginText = result ? `BatSols login\n${typeof window !== 'undefined' ? window.location.origin : ''}/login\nEmail: ${result.email}${result.password ? `\nPassword: ${result.password}` : ''}` : '';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" title="Add a team member" description="They get their own space to connect WhatsApp and run campaigns.">
        {result ? (
          <>
            <DialogBody className="space-y-3">
              <Callout tone="success" title="Member added">
                {result.password ? 'Share these login details with them. They can change the password in their profile.' : 'They already had a BatSols account and can sign in with it.'}
              </Callout>
              <pre className="rounded-lg bg-surface-2 p-3 font-mono text-[12.5px]">{loginText}</pre>
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(loginText); toast.success('Copied'); }}>
                <Copy /> Copy details
              </Button>
              <Button variant="primary" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogBody className="grid gap-4 sm:grid-cols-2">
              <Field label="Full name">
                <Input autoFocus value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Ali Raza" />
              </Field>
              <Field label="Job title" optional>
                <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Sales executive" />
              </Field>
              <Field label="Email" className="sm:col-span-2">
                <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="ali@company.com" />
              </Field>
              <Field label="Password" hint="Leave empty to generate one" optional>
                <Input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} leading={<KeyRound />} />
              </Field>
              <Field label="Role">
                <NativeSelect value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Exclude<Role, 'owner'> })}>
                  {(['member', 'admin', 'viewer'] as const).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]} — {ROLE_DESCRIPTIONS[r]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {teams.length > 0 && (
                <Field label="Teams" className="sm:col-span-2">
                  <div className="flex flex-wrap gap-2">
                    {teams.map((t) => (
                      <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-[13px]">
                        <Checkbox checked={form.team_ids.includes(t.id)} onCheckedChange={(c) => setForm({ ...form, team_ids: c ? [...form.team_ids, t.id] : form.team_ids.filter((x) => x !== t.id) })} />
                        <span className="size-2 rounded-full" style={{ background: t.color }} /> {t.name}
                      </label>
                    ))}
                  </div>
                </Field>
              )}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={submit} loading={busy} disabled={!form.full_name.trim() || !form.email.trim() || (!!form.password && form.password.length < 8)}>
                <UserPlus /> Add member
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditMemberDialog({
  member,
  self,
  roleOptions,
  teams,
  teamIds,
  onClose,
  onSave,
}: {
  member: MemberRow | null;
  self: boolean;
  roleOptions: Role[];
  teams: Array<{ id: string; name: string; color: string }>;
  teamIds: string[];
  onClose: () => void;
  onSave: (patch: MemberEdit) => void;
}) {
  const [p, setP] = React.useState<MemberPermissions>({});
  const [form, setForm] = React.useState({ full_name: '', title: '', role: 'member' as Role, team_ids: [] as string[], password: '' });
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    if (member) {
      setP(member.permissions ?? {});
      setForm({ full_name: member.profile.full_name ?? '', title: member.title ?? '', role: member.role, team_ids: teamIds, password: '' });
    }
    // Only when a different member is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member]);
  const pwBad = !!form.password && form.password.length < 8;

  async function save() {
    if (!member) return;
    setSaving(true);
    await onSave({
      full_name: form.full_name.trim() && form.full_name.trim() !== member.profile.full_name ? form.full_name.trim() : undefined,
      title: form.title.trim() || null,
      ...(self || form.role === member.role ? {} : { role: form.role }),
      team_ids: form.team_ids,
      ...(form.role === 'member' ? { permissions: p } : {}),
      ...(form.password ? { password: form.password } : {}),
    });
    setSaving(false);
  }

  return (
    <Dialog open={!!member} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md" title="Edit member" description={member?.profile.email}>
        <DialogBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name">
              <Input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
            </Field>
            <Field label="Job title" optional>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Sales executive" />
            </Field>
            <Field label="Role" hint={self ? 'You can’t change your own role.' : ROLE_DESCRIPTIONS[form.role]}>
              <NativeSelect value={form.role} disabled={self} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
                {[...new Set([...roleOptions, form.role])].map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="New password" optional hint={pwBad ? 'At least 8 characters' : 'Leave empty to keep their password.'} error={pwBad ? 'Too short' : null}>
              <PasswordInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
            </Field>
          </div>
          {teams.length > 0 && (
            <Field label="Teams">
              <div className="flex flex-wrap gap-2">
                {teams.map((t) => {
                  const on = form.team_ids.includes(t.id);
                  return (
                    <label key={t.id} className={cn('flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[13px]', on ? 'border-primary bg-primary-soft' : 'border-border')}>
                      <Checkbox checked={on} onCheckedChange={(v) => setForm({ ...form, team_ids: v === true ? [...form.team_ids, t.id] : form.team_ids.filter((x) => x !== t.id) })} />
                      <span className="size-2 rounded-full" style={{ background: t.color }} />
                      {t.name}
                    </label>
                  );
                })}
              </div>
            </Field>
          )}
          {form.role === 'member' && (
            <>
              <div className="divide-y divide-border rounded-xl border border-border px-4">
                {PERMS.map((x) => (
                  <SwitchRow key={x.key} label={x.label} description={x.description} checked={(p[x.key] as boolean | undefined) ?? x.def} onCheckedChange={(v) => setP({ ...p, [x.key]: v })} />
                ))}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Max WhatsApp numbers">
                  <Input type="number" min={0} max={20} value={p.max_numbers ?? 3} onChange={(e) => setP({ ...p, max_numbers: Number(e.target.value) })} />
                </Field>
                <Field label="Daily message cap" hint="Across all their numbers. Empty = no cap.">
                  <Input type="number" min={1} value={p.daily_message_cap ?? ''} onChange={(e) => setP({ ...p, daily_message_cap: e.target.value ? Number(e.target.value) : null })} />
                </Field>
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={!form.full_name.trim() || pwBad}>
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TeamsCard({ members }: { members: MemberRow[] }) {
  const { workspace, userId, can } = useWorkspace();
  const { teams, membersOf } = useTeams();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [name, setName] = React.useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['teams', workspace.id] });
  async function create() {
    if (!name.trim()) return;
    const { error } = await getSupabase().from('teams').insert({ workspace_id: workspace.id, name: name.trim(), color: STAGE_COLORS[teams.length % STAGE_COLORS.length], created_by: userId });
    if (error) return toast.error(errorMessage(error).includes('teams_name_uq') ? 'A team with that name exists' : errorMessage(error));
    setName('');
    refresh();
  }
  async function toggle(teamId: string, uid: string, on: boolean) {
    const sb = getSupabase();
    const { error } = on ? await sb.from('team_members').insert({ team_id: teamId, workspace_id: workspace.id, user_id: uid }) : await sb.from('team_members').delete().eq('team_id', teamId).eq('user_id', uid);
    if (error) return toast.error(errorMessage(error));
    refresh();
  }
  return (
    <Card>
      <CardHeader title="Teams" description="Group members (e.g. “Sales Lahore”) to share lists, campaigns and automations with everyone in a team, and to compare teams in Reports." />
      <div className="space-y-3 border-t border-border p-5">
        {teams.map((t) => {
          const ids = membersOf(t.id);
          return (
            <div key={t.id} className="rounded-xl border border-border p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="size-2.5 rounded-full" style={{ background: t.color }} />
                <span className="text-[14px] font-semibold">{t.name}</span>
                <span className="text-xs text-subtle">
                  <Users className="mr-1 inline size-3" />
                  {ids.length}
                </span>
                {can.admin && (
                  <Button size="icon-xs" variant="ghost" className="ml-auto" onClick={async () => { if (await confirm({ title: `Delete team “${t.name}”?`, confirmLabel: 'Delete', danger: true })) { await getSupabase().from('teams').delete().eq('id', t.id); refresh(); } }} aria-label="Delete team">
                    <Trash2 />
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {members.map((m) => {
                  const on = ids.includes(m.user_id);
                  return (
                    <button
                      key={m.user_id}
                      disabled={!can.admin}
                      onClick={() => toggle(t.id, m.user_id, !on)}
                      className={cn('inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs transition-colors', on ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:text-foreground')}
                    >
                      <Avatar name={m.profile.full_name || m.profile.email} size="xs" /> {m.profile.full_name.split(' ')[0] || m.profile.email}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        {can.admin && (
          <div className="flex gap-2">
            <Input inputSize="sm" placeholder="New team name…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} className="max-w-xs" />
            <Button size="sm" variant="secondary" onClick={create} disabled={!name.trim()}>
              <Plus /> Create team
            </Button>
          </div>
        )}
        {!teams.length && !can.admin && <p className="text-[13px] text-muted">No teams yet.</p>}
      </div>
    </Card>
  );
}

function InviteDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const { workspace, userId, can } = useWorkspace();
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<Exclude<Role, 'owner'>>('member');
  const [link, setLink] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setEmail('');
      setRole('member');
      setLink(null);
    }
  }, [open]);
  async function create() {
    const { data, error } = await getSupabase().from('workspace_invites').insert({ workspace_id: workspace.id, email: email.trim().toLowerCase() || null, role, invited_by: userId }).select('token').single();
    if (error) return toast.error(errorMessage(error));
    const url = inviteUrl(data.token);
    setLink(url);
    void navigator.clipboard?.writeText(url).catch(() => undefined);
    onCreated();
  }
  if (!can.admin) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" title="Create an invite link" description="They choose their own password when they open it.">
        {link ? (
          <>
            <DialogBody className="space-y-3">
              <Callout tone="success" title="Link created and copied">Send it on WhatsApp, Slack or email. It works once and expires in 7 days.</Callout>
              <Input readOnly value={link} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
            </DialogBody>
            <DialogFooter>
              <Button variant="primary" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogBody className="space-y-4">
              <Field label="Email" optional hint="Lock the link to one address, or leave empty.">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Role">
                <NativeSelect value={role} onChange={(e) => setRole(e.target.value as Exclude<Role, 'owner'>)}>
                  {(['member', 'admin', 'viewer'] as const).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button variant="primary" onClick={create}>
                <Link2 /> Create link
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
