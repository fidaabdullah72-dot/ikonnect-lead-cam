'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, GitMerge, ListChecks, Megaphone, MoreHorizontal, Pencil, Plus, Send, Share2, Trash2, Upload, Users, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { STAGE_COLORS, type DuplicateGroup, type LeadFilters, type LeadListStats } from '@batsols/shared';
import { Page } from '@/components/shell/app-shell';
import { ShareDialog } from '@/components/access/share-dialog';
import { rememberLists } from '@/components/campaigns/add-leads-dialog';
import { ImportDialog } from '@/components/leads/import-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState, Skeleton, useConfirm } from '@/components/ui/feedback';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/layout';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/menu';
import { getSupabase } from '@/lib/supabase/client';
import { useAllGrants } from '@/lib/access';
import { cleanFilters, useInvalidateLeads } from '@/lib/leads';
import { useCampaigns } from '@/lib/campaigns';
import { useInvalidateLists, useLeadLists, useListStats, type ListWithCount } from '@/lib/lists';
import { qk, useMembers } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, errorMessage, formatNumber, formatPercent, timeAgo } from '@/lib/utils';

export function ListsView() {
  const router = useRouter();
  const { userId, can } = useWorkspace();
  const { data: lists = [], isLoading } = useLeadLists();
  const stats = useListStats();
  const { byId } = useMembers();
  const grants = useAllGrants();
  const invalidate = useInvalidateLists();
  const confirm = useConfirm();
  const [create, setCreate] = React.useState(false);
  const [edit, setEdit] = React.useState<ListWithCount | null>(null);
  const [share, setShare] = React.useState<ListWithCount | null>(null);
  const [importInto, setImportInto] = React.useState<string | null | undefined>(undefined);
  const [toCampaign, setToCampaign] = React.useState<ListWithCount | null>(null);

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
        description="Group leads into lists — import a CSV straight into a list, message a list as a campaign and track how each list is doing."
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link href="/lists/duplicates">
                <GitMerge /> Find duplicates
              </Link>
            </Button>
            {can.write && (
              <>
                <Button variant="secondary" onClick={() => setImportInto(null)}>
                  <Upload /> Import CSV
                </Button>
                <Button variant="primary" onClick={() => setCreate(true)}>
                  <Plus /> New list
                </Button>
              </>
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
          <EmptyState
            icon={<ListChecks />}
            title="No lists yet"
            description="Import a CSV into a new list, or create a list and add leads from the Leads page (select → More → Add to list)."
            action={
              can.write && (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="secondary" onClick={() => setImportInto(null)}>
                    <Upload /> Import CSV
                  </Button>
                  <Button variant="primary" onClick={() => setCreate(true)}>
                    <Plus /> New list
                  </Button>
                </div>
              )
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {lists.map((l) => {
            const shared = (grants.data ?? []).filter((g) => g.resource_type === 'lead_list' && g.resource_id === l.id).length;
            const mine = l.created_by === userId || can.admin;
            const s = stats.data?.get(l.id);
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
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon-sm" variant="ghost" aria-label="List actions">
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem onSelect={() => router.push(`/leads?list=${l.id}`)}>
                        <Users /> View leads
                      </DropdownMenuItem>
                      {can.write && (
                        <>
                          <DropdownMenuItem onSelect={() => router.push(`/campaigns/new?list=${l.id}`)}>
                            <Megaphone /> Start a campaign
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setToCampaign(l)}>
                            <Send /> Add to a running campaign
                          </DropdownMenuItem>
                          {mine && (
                            <DropdownMenuItem onSelect={() => setImportInto(l.id)}>
                              <Upload /> Import CSV into this list
                            </DropdownMenuItem>
                          )}
                        </>
                      )}
                      {mine && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => setEdit(l)}>
                            <Pencil /> Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setShare(l)}>
                            <Share2 /> Share with teammates
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem danger onSelect={() => remove(l)}>
                            <Trash2 /> Delete list
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="mt-4 flex items-end justify-between">
                  <div>
                    <div className="text-[24px] font-semibold tabular">{formatNumber(l.count)}</div>
                    <div className="text-xs text-subtle">leads{s ? ` · ${formatNumber(s.sendable)} can be messaged` : ''}</div>
                  </div>
                  <div className="text-right text-xs text-muted">
                    {shared ? <Badge tone="info"><Users /> Shared with {shared}</Badge> : <Badge tone="outline">Private</Badge>}
                    <div className="mt-1">{l.created_by ? byId.get(l.created_by)?.profile.full_name : ''} · {timeAgo(l.created_at)}</div>
                  </div>
                </div>
                {s && <ListProgress s={s} />}
                {can.write && l.count > 0 && (
                  <div className="mt-3 flex gap-2 border-t border-border pt-3">
                    <Button size="sm" variant="secondary" className="flex-1" asChild>
                      <Link href={`/leads?list=${l.id}`}>
                        <Users /> Leads
                      </Link>
                    </Button>
                    <Button size="sm" variant="soft" className="flex-1" asChild>
                      <Link href={`/campaigns/new?list=${l.id}`}>
                        <Megaphone /> Campaign
                      </Link>
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
      <ListFormDialog open={create} onOpenChange={setCreate} />
      <ListFormDialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} list={edit} />
      {share && <ShareDialog open onOpenChange={(o) => !o && setShare(null)} type="lead_list" resourceId={share.id} resourceName={share.name} />}
      {importInto !== undefined && <ImportDialog open onOpenChange={(o) => !o && setImportInto(undefined)} listId={importInto ?? undefined} />}
      {toCampaign && <ListToCampaignDialog list={toCampaign} onClose={() => setToCampaign(null)} />}
    </Page>
  );
}

/** How far a list has been worked: contacted → replied → won, and the campaigns that used it. */
function ListProgress({ s }: { s: LeadListStats }) {
  const items = [
    { label: 'Contacted', value: s.contacted },
    { label: 'Replied', value: s.replied, hint: s.contacted ? formatPercent(s.replied, s.contacted, 0) : null },
    { label: 'In campaigns', value: s.in_campaigns, hint: s.in_active_campaigns ? `${formatNumber(s.in_active_campaigns)} active` : null },
    { label: 'Won', value: s.won },
  ];
  return (
    <div className="mt-4 space-y-2">
      <Progress value={s.total ? Math.round((s.contacted / s.total) * 100) : 0} />
      <div className="grid grid-cols-4 gap-2">
        {items.map((i) => (
          <div key={i.label} className="min-w-0">
            <div className="text-[14px] font-semibold tabular">{formatNumber(i.value)}</div>
            <div className="truncate text-[11px] text-subtle">{i.label}</div>
            {i.hint && <div className="truncate text-[11px] text-muted">{i.hint}</div>}
          </div>
        ))}
      </div>
      <div className="text-[11.5px] text-subtle">
        {s.campaigns ? `Used in ${formatNumber(s.campaigns)} campaign${s.campaigns === 1 ? '' : 's'}` : 'Not used in a campaign yet'}
        {s.opted_out ? ` · ${formatNumber(s.opted_out)} opted out` : ''}
        {s.last_added_at ? ` · last added ${timeAgo(s.last_added_at)}` : ''}
      </div>
    </div>
  );
}

/** Add a list's leads to an existing campaign that is still going. */
function ListToCampaignDialog({ list, onClose }: { list: ListWithCount; onClose: () => void }) {
  const { workspace } = useWorkspace();
  const qc = useQueryClient();
  const { data: campaigns = [] } = useCampaigns();
  const open = campaigns.filter((c) => ['draft', 'scheduled', 'running', 'paused'].includes(c.status));
  const [picked, setCampaignId] = React.useState('');
  const campaignId = picked || open[0]?.id || '';
  const [busy, setBusy] = React.useState(false);
  async function add() {
    setBusy(true);
    const { data, error } = await getSupabase().rpc('campaign_add_recipients', {
      p_campaign: campaignId,
      p_filters: { list_ids: [list.id], not_in_active_campaign: true, exclude_campaign_id: campaignId },
    });
    if (error) {
      setBusy(false);
      return toast.error(errorMessage(error));
    }
    await rememberLists(campaignId, [list.id]);
    setBusy(false);
    toast.success(`${formatNumber(data as number)} leads from “${list.name}” added to the campaign`);
    qc.invalidateQueries({ queryKey: qk.campaign(campaignId) });
    qc.invalidateQueries({ queryKey: qk.campaigns(workspace.id) });
    qc.invalidateQueries({ queryKey: ['lead-list-stats', workspace.id] });
    onClose();
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm" title={`Add “${list.name}” to a campaign`} description="Leads already in this or another active campaign, opted out or without WhatsApp are skipped.">
        <DialogBody className="space-y-3">
          {open.length ? (
            <NativeSelect value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              {open.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.status}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <p className="text-[13px] text-muted">No campaign is running. Start a new one with this list instead.</p>
          )}
        </DialogBody>
        <DialogFooter>
          {open.length ? (
            <Button variant="primary" onClick={add} loading={busy} disabled={!campaignId}>
              Add leads
            </Button>
          ) : (
            <Button variant="primary" asChild>
              <Link href={`/campaigns/new?list=${list.id}`}>
                <Megaphone /> Start a campaign
              </Link>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Create a list, or rename one (`list`). */
export function ListFormDialog({ open, onOpenChange, onCreated, list }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (id: string) => void; list?: ListWithCount | null }) {
  const { workspace, userId } = useWorkspace();
  const invalidate = useInvalidateLists();
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [color, setColor] = React.useState(STAGE_COLORS[3]!);
  React.useEffect(() => {
    if (open) {
      setName(list?.name ?? '');
      setDescription(list?.description ?? '');
      if (list) setColor(list.color);
    }
  }, [open, list]);
  async function save() {
    const sb = getSupabase();
    const fields = { name: name.trim(), description: description.trim() || null, color };
    if (list) {
      const { error } = await sb.from('lead_lists').update(fields).eq('id', list.id);
      if (error) return toast.error(errorMessage(error));
      invalidate();
      onOpenChange(false);
      return;
    }
    const { data, error } = await sb.from('lead_lists').insert({ workspace_id: workspace.id, ...fields, created_by: userId }).select('id').single();
    if (error) return toast.error(errorMessage(error));
    invalidate();
    onOpenChange(false);
    onCreated?.(data.id);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" title={list ? 'Edit lead list' : 'New lead list'}>
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
            {list ? 'Save' : 'Create list'}
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
