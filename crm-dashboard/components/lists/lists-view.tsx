'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, GitMerge, ListChecks, MoreHorizontal, Plus, Share2, Trash2, Users, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { STAGE_COLORS, type DuplicateGroup, type LeadFilters } from '@batsols/shared';
import { Page } from '@/components/shell/app-shell';
import { ShareDialog } from '@/components/access/share-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState, Skeleton, useConfirm } from '@/components/ui/feedback';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/layout';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/menu';
import { getSupabase } from '@/lib/supabase/client';
import { useAllGrants } from '@/lib/access';
import { cleanFilters, useInvalidateLeads } from '@/lib/leads';
import { useInvalidateLists, useLeadLists, type ListWithCount } from '@/lib/lists';
import { useMembers } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, errorMessage, formatNumber, timeAgo } from '@/lib/utils';

export function ListsView() {
  const { userId, can } = useWorkspace();
  const { data: lists = [], isLoading } = useLeadLists();
  const { byId } = useMembers();
  const grants = useAllGrants();
  const invalidate = useInvalidateLists();
  const confirm = useConfirm();
  const [create, setCreate] = React.useState(false);
  const [share, setShare] = React.useState<ListWithCount | null>(null);

  async function remove(l: ListWithCount) {
    if (!(await confirm({ title: `Delete list “${l.name}”?`, description: 'The leads themselves are kept.', confirmLabel: 'Delete list', danger: true }))) return;
    const { error } = await getSupabase().from('lead_lists').delete().eq('id', l.id);
    if (error) return toast.error(errorMessage(error));
    invalidate();
  }

  return (
    <Page>
      <PageHeader
        icon={<ListChecks />}
        title="Lead lists"
        description="Group leads into lists and share them with teammates or teams — they’ll see those leads in their own space."
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link href="/lists/duplicates">
                <GitMerge /> Find duplicates
              </Link>
            </Button>
            {can.write && (
              <Button variant="primary" onClick={() => setCreate(true)}>
                <Plus /> New list
              </Button>
            )}
          </>
        }
      />
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : !lists.length ? (
        <Card>
          <EmptyState icon={<ListChecks />} title="No lists yet" description="Create a list, then add leads from the Leads page (select → More → Add to list)." action={can.write && <Button variant="primary" onClick={() => setCreate(true)}><Plus /> New list</Button>} />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {lists.map((l) => {
            const shared = (grants.data ?? []).filter((g) => g.resource_type === 'lead_list' && g.resource_id === l.id).length;
            const mine = l.created_by === userId || can.admin;
            return (
              <Card key={l.id} className="flex flex-col p-4">
                <div className="flex items-start gap-3">
                  <span className="mt-1 size-3 shrink-0 rounded-full" style={{ background: l.color }} />
                  <div className="min-w-0 flex-1">
                    <Link href={`/leads?list=${l.id}`} className="block truncate text-[15px] font-semibold hover:text-primary">
                      {l.name}
                    </Link>
                    {l.description && <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{l.description}</p>}
                  </div>
                  {mine && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label="List actions">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem onSelect={() => setShare(l)}>
                          <Share2 /> Share with teammates
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem danger onSelect={() => remove(l)}>
                          <Trash2 /> Delete list
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
                <div className="mt-4 flex items-end justify-between">
                  <div>
                    <div className="text-[24px] font-semibold tabular">{formatNumber(l.count)}</div>
                    <div className="text-xs text-subtle">leads</div>
                  </div>
                  <div className="text-right text-xs text-muted">
                    {shared ? <Badge tone="info"><Users /> Shared with {shared}</Badge> : <Badge tone="outline">Private</Badge>}
                    <div className="mt-1">{l.created_by ? byId.get(l.created_by)?.profile.full_name : ''} · {timeAgo(l.created_at)}</div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <ListFormDialog open={create} onOpenChange={setCreate} />
      {share && <ShareDialog open onOpenChange={(o) => !o && setShare(null)} type="lead_list" resourceId={share.id} resourceName={share.name} />}
    </Page>
  );
}

export function ListFormDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (id: string) => void }) {
  const { workspace, userId } = useWorkspace();
  const invalidate = useInvalidateLists();
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [color, setColor] = React.useState(STAGE_COLORS[3]!);
  React.useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
    }
  }, [open]);
  async function save() {
    const { data, error } = await getSupabase().from('lead_lists').insert({ workspace_id: workspace.id, name: name.trim(), description: description.trim() || null, color, created_by: userId }).select('id').single();
    if (error) return toast.error(errorMessage(error));
    invalidate();
    onOpenChange(false);
    onCreated?.(data.id);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" title="New lead list">
        <DialogBody className="space-y-4">
          <Field label="Name">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Lahore dentists — Q4" />
          </Field>
          <Field label="Description" optional>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Colour">
            <div className="flex flex-wrap gap-2">
              {STAGE_COLORS.map((c) => (
                <button key={c} type="button" onClick={() => setColor(c)} className={cn('size-7 rounded-full ring-offset-2 ring-offset-surface', color === c && 'ring-2 ring-primary')} style={{ background: c }} aria-label={c} />
              ))}
            </div>
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onClick={save} disabled={!name.trim()}>
            Create list
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Bulk "Add to list" from the Leads page. */
export function AddToListDialog({ open, onOpenChange, ids, filters, count }: { open: boolean; onOpenChange: (o: boolean) => void; ids: string[] | null; filters: LeadFilters; count: number }) {
  const { data: lists = [] } = useLeadLists();
  const invalidate = useInvalidateLists();
  const [list, setList] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  React.useEffect(() => {
    if (open && lists[0]) setList((l) => l || lists[0]!.id);
  }, [open, lists]);
  async function add(listId = list) {
    if (!listId) return;
    const { data, error } = await getSupabase().rpc('lead_list_add', { p_list: listId, p_ids: ids, p_filters: ids ? null : cleanFilters(filters) });
    if (error) return toast.error(errorMessage(error));
    toast.success(`${formatNumber(data as number)} leads added to the list`);
    invalidate();
    onOpenChange(false);
  }
  return (
    <>
      <Dialog open={open && !creating} onOpenChange={onOpenChange}>
        <DialogContent size="sm" title="Add to list" description={`${formatNumber(count)} leads selected`}>
          <DialogBody className="space-y-3">
            {lists.length ? (
              <NativeSelect value={list} onChange={(e) => setList(e.target.value)}>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({formatNumber(l.count)})
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <p className="text-[13px] text-muted">You don’t have any lists yet.</p>
            )}
            <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
              <Plus /> Create a new list
            </Button>
          </DialogBody>
          <DialogFooter>
            <Button variant="primary" onClick={() => add()} disabled={!list}>
              Add leads
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ListFormDialog
        open={open && creating}
        onOpenChange={(o) => !o && setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          void add(id);
        }}
      />
    </>
  );
}

export function DuplicatesView() {
  const { workspace, userId, can } = useWorkspace();
  const qc = useQueryClient();
  const invalidateLeads = useInvalidateLeads();
  const key = ['duplicates', workspace.id];
  const { data: groups = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('lead_duplicate_groups', { p_workspace: workspace.id, p_limit: 200 });
      if (error) throw error;
      return data as DuplicateGroup[];
    },
  });

  async function merge(g: DuplicateGroup) {
    const [keep, ...rest] = g.lead_ids;
    const { data, error } = await getSupabase().rpc('merge_leads', { p_keep: keep!, p_merge: rest });
    if (error) return toast.error(errorMessage(error));
    toast.success(`Merged ${data} duplicate${data === 1 ? '' : 's'} into “${g.names[0]}”`);
    qc.invalidateQueries({ queryKey: key });
    invalidateLeads();
  }
  async function dismiss(g: DuplicateGroup) {
    await getSupabase().from('duplicate_dismissals').insert({ workspace_id: workspace.id, match_type: g.match_type, match_key: g.match_key, dismissed_by: userId });
    qc.invalidateQueries({ queryKey: key });
  }

  return (
    <Page>
      <PageHeader icon={<Copy />} title="Possible duplicates" description="Phone numbers and Google place IDs can never repeat. These are softer matches — same name in the same city, or the same website." />
      {isLoading ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : !groups.length ? (
        <Card>
          <EmptyState icon={<GitMerge />} title="No duplicates found" description="Your lead base is clean." />
        </Card>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <Card key={`${g.match_type}-${g.match_key}`} className="flex flex-wrap items-center gap-4 p-4">
              <Badge tone={g.match_type === 'website' ? 'info' : 'primary'}>{g.match_type === 'website' ? `Website ${g.match_key}` : 'Same name & city'}</Badge>
              <div className="min-w-0 flex-1 text-[13.5px]">
                <b>{g.names[0]}</b>
                <span className="text-muted"> + {g.names.slice(1).join(', ')}</span>
              </div>
              {can.write && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => dismiss(g)}>
                    <XCircle /> Not duplicates
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => merge(g)}>
                    <GitMerge /> Merge {g.total}
                  </Button>
                </>
              )}
            </Card>
          ))}
        </div>
      )}
    </Page>
  );
}
