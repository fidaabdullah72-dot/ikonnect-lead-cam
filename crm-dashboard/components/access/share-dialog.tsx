'use client';

import * as React from 'react';
import { Eye, PenLine, Share2, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { ResourceType } from '@batsols/shared';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { NativeSelect } from '@/components/ui/input';
import { Callout } from '@/components/ui/feedback';
import { getSupabase } from '@/lib/supabase/client';
import { RESOURCE_LABELS, useGrants, useInvalidateGrants, useTeams } from '@/lib/access';
import { useMembers } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { errorMessage } from '@/lib/utils';

const ACCESS_HELP: Record<ResourceType, { view: string; manage: string; note?: string }> = {
  lead_list: { view: 'See the leads in this list', manage: 'See, add and remove leads' },
  campaign: { view: 'See progress and results', manage: 'Run, pause and edit; can send from their own numbers' },
  automation: {
    view: 'The automation runs for their leads and numbers',
    manage: 'Runs for them, and they can edit it',
    note: 'An automation shared with nobody runs for the whole team. Once you share it, it runs only for the people and teams below.',
  },
  template: { view: 'Use this template', manage: 'Use and edit this template' },
  whatsapp_account: { view: 'See this number and its chats', manage: 'Also send and run campaigns from it' },
};

export function ShareDialog({
  open,
  onOpenChange,
  type,
  resourceId,
  resourceName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  type: ResourceType;
  resourceId: string;
  resourceName: string;
}) {
  const { workspace, userId } = useWorkspace();
  const { members, byId } = useMembers();
  const { teams } = useTeams();
  const grants = useGrants(type, open ? resourceId : null);
  const invalidate = useInvalidateGrants();
  // Campaigns are assigned: the person runs it (manage) and sees it in their own space.
  const assign = type === 'campaign';
  const [target, setTarget] = React.useState('');
  const [access, setAccess] = React.useState<'view' | 'manage'>(assign ? 'manage' : 'view');
  const [busy, setBusy] = React.useState(false);
  const help = ACCESS_HELP[type];

  const granted = new Set((grants.data ?? []).map((g) => g.user_id ?? g.team_id));
  const options = [
    ...teams.filter((t) => !granted.has(t.id)).map((t) => ({ value: `team:${t.id}`, label: `Team · ${t.name}` })),
    ...members
      // Owners and admins see everything already; a campaign can still be assigned to them.
      .filter((m) => m.user_id !== userId && (assign || (m.role !== 'owner' && m.role !== 'admin')) && !granted.has(m.user_id))
      .map((m) => ({ value: `user:${m.user_id}`, label: m.profile.full_name || m.profile.email })),
  ];

  /** Saves the chosen teammate/team; false if it failed. */
  async function add(): Promise<boolean> {
    if (!target) return true;
    const label = options.find((o) => o.value === target)?.label ?? 'them';
    setBusy(true);
    const [kind, id] = target.split(':') as ['team' | 'user', string];
    const { error } = await getSupabase()
      .from('resource_access')
      .insert({
        workspace_id: workspace.id,
        resource_type: type,
        resource_id: resourceId,
        ...(kind === 'team' ? { team_id: id } : { user_id: id }),
        access,
        granted_by: userId,
      });
    setBusy(false);
    if (error) {
      toast.error(errorMessage(error));
      return false;
    }
    toast.success(`${assign ? 'Assigned to' : 'Shared with'} ${label.replace(/^Team · /, 'team ')} — they’ve been notified`);
    setTarget('');
    invalidate();
    void grants.refetch();
    return true;
  }

  async function revoke(id: string) {
    const { error } = await getSupabase().from('resource_access').delete().eq('id', id);
    if (error) return toast.error(errorMessage(error));
    invalidate();
    void grants.refetch();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" title={assign ? 'Assign campaign' : `Share ${RESOURCE_LABELS[type]}`} description={resourceName}>
        <DialogBody className="space-y-4">
          {help.note && <Callout tone="info">{help.note}</Callout>}
          <div className="flex flex-wrap gap-2">
            <NativeSelect className="min-w-0 flex-1" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose a teammate or team…</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect className="w-36" value={access} onChange={(e) => setAccess(e.target.value as 'view' | 'manage')}>
              <option value="view">Can view</option>
              <option value="manage">Can manage</option>
            </NativeSelect>
            <Button variant="primary" onClick={add} disabled={!target} loading={busy}>
              <Share2 /> {assign ? 'Assign' : 'Share'}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs text-muted">
            <div className="flex gap-2 rounded-lg bg-surface-2/60 p-2.5">
              <Eye className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <b className="font-medium text-foreground">View</b> — {help.view}
              </span>
            </div>
            <div className="flex gap-2 rounded-lg bg-surface-2/60 p-2.5">
              <PenLine className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <b className="font-medium text-foreground">Manage</b> — {help.manage}
              </span>
            </div>
          </div>

          <div>
            <div className="mb-2 text-[13px] font-semibold">{assign ? 'Assigned to' : 'People with access'}</div>
            <ul className="divide-y divide-border rounded-xl border border-border">
              <li className="flex items-center gap-3 px-3 py-2.5 text-[13px] text-muted">
                <Users className="size-4" /> Owners and admins always have access
              </li>
              {(grants.data ?? []).map((g) => {
                const team = g.team_id ? teams.find((t) => t.id === g.team_id) : null;
                const m = g.user_id ? byId.get(g.user_id) : null;
                const name = team ? team.name : (m?.profile.full_name || m?.profile.email || 'Removed member');
                return (
                  <li key={g.id} className="flex items-center gap-3 px-3 py-2.5">
                    {team ? (
                      <span className="flex size-6 items-center justify-center rounded-md text-[10px] font-semibold text-white" style={{ background: team.color }}>
                        <Users className="size-3" />
                      </span>
                    ) : (
                      <Avatar name={name} src={m?.profile.avatar_url} size="sm" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{name}</div>
                      <div className="text-xs text-subtle">{team ? 'Team' : 'Member'}</div>
                    </div>
                    <span className="text-xs text-muted">{g.access === 'manage' ? 'Can manage' : 'Can view'}</span>
                    <Button size="icon-sm" variant="ghost" onClick={() => revoke(g.id)} aria-label="Remove access">
                      <Trash2 />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        </DialogBody>
        <DialogFooter>
          {/* A teammate picked but not added yet is saved on Done, not lost. */}
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              if (await add()) onOpenChange(false);
            }}
          >
            {target ? (assign ? 'Assign & close' : 'Share & close') : 'Done'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
