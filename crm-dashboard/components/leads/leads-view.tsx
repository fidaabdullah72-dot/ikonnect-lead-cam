'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowDown,
  ArrowUp,
  Ban,
  ChevronLeft,
  ChevronRight,
  Download,
  Globe,
  ListChecks,
  MapPin,
  MoreHorizontal,
  Plus,
  Send,
  ShieldCheck,
  Tag as TagIcon,
  Target,
  Trash2,
  Upload,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Lead, LeadFilters } from '@batsols/shared';
import { Page } from '@/components/shell/app-shell';
import { Button } from '@/components/ui/button';
import { Tag } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { Checkbox, Segmented } from '@/components/ui/controls';
import { EmptyState, Skeleton, useConfirm } from '@/components/ui/feedback';
import { PageHeader, Table, Td, Th, Tr } from '@/components/ui/layout';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Tooltip,
} from '@/components/ui/menu';
import { FilterBar } from './filter-bar';
import { AddToListDialog } from '@/components/lists/lists-view';
import { LeadDrawer } from './lead-drawer';
import { LeadFormDialog } from './lead-form';
import { ImportDialog } from './import-dialog';
import { TagsDialog, VerifyDialog, useStartCampaignWith, type Selection } from './bulk-dialogs';
import { LandlineBadge, OwnerSelect, PhoneText, Rating, ScoreBadge, StageDot, StageSelect, WaStatus } from './bits';
import { useBulkAction, useLeadsList, useUpdateLead, type SortKey } from '@/lib/leads';
import { exportLeadsCsv } from '@/lib/export';
import { useMembers, useStages } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, errorMessage, formatNumber, hostname, timeAgo } from '@/lib/utils';

type View = 'all' | 'website' | 'no_website' | 'mine' | 'unassigned' | 'replied' | 'opted_out';

const VIEW_FILTERS: Record<View, (me: string) => LeadFilters> = {
  all: () => ({}),
  website: () => ({ has_website: true }),
  no_website: () => ({ has_website: false }),
  mine: (me) => ({ owner_ids: [me] }),
  unassigned: () => ({ unassigned: true }),
  replied: () => ({ contacted: 'replied' }),
  opted_out: () => ({ opted_out: true }),
};

const PAGE_SIZE = 50;

export function LeadsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { userId, workspace, can } = useWorkspace();
  const { byId: stageById } = useStages();
  const { byId: memberById } = useMembers();
  const confirm = useConfirm();
  const bulk = useBulkAction();
  const update = useUpdateLead();
  const startCampaign = useStartCampaignWith();

  const [view, setView] = React.useState<View>(() => (params.get('view') as View) || 'all');
  const [filters, setFilters] = React.useState<LeadFilters>(() => {
    const f: LeadFilters = {};
    const job = params.get('scrape_job');
    if (job) f.scrape_job_id = job;
    const tag = params.get('tag');
    if (tag) f.tags = [tag];
    const list = params.get('list');
    if (list) f.list_ids = [list];
    return f;
  });
  const [sort, setSort] = React.useState<{ key: SortKey; asc: boolean }>({ key: 'created_at', asc: false });
  const [page, setPage] = React.useState(0);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = React.useState(false);
  const [dialog, setDialog] = React.useState<null | 'add-tags' | 'remove-tags' | 'verify' | 'import' | 'add-list'>(null);
  const [exporting, setExporting] = React.useState(false);

  const leadId = params.get('lead');
  const showNew = params.get('new') === '1';
  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  };
  const setParam = (key: string, value: string | null) => setParams({ [key]: value });

  const effective: LeadFilters = React.useMemo(() => ({ ...filters, ...VIEW_FILTERS[view](userId) }), [filters, view, userId]);
  const { data, isLoading, isFetching } = useLeadsList({ filters: effective, sort, page, pageSize: PAGE_SIZE });
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  // Reset paging/selection whenever the result set changes shape.
  React.useEffect(() => {
    setPage(0);
    setSelected(new Set());
    setAllMatching(false);
  }, [effective, sort]);

  const pageIds = rows.map((r) => r.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const somePageSelected = pageIds.some((id) => selected.has(id));
  const selectionCount = allMatching ? total : selected.size;
  const selection: Selection = { ids: allMatching ? null : [...selected], filters: effective, count: selectionCount };

  const toggleAll = () => {
    setAllMatching(false);
    setSelected((s) => {
      const next = new Set(s);
      if (allPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  };
  const toggle = (id: string) => {
    setAllMatching(false);
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => {
    setSelected(new Set());
    setAllMatching(false);
  };

  async function runBulk(action: string, value?: unknown, label?: string) {
    const n = await bulk.mutateAsync({ action, ids: selection.ids, filters: selection.filters, value });
    toast.success(`${label ?? 'Updated'} ${formatNumber(n)} lead${n === 1 ? '' : 's'}`);
    clearSelection();
  }

  async function bulkDelete() {
    const ok = await confirm({
      title: `Delete ${formatNumber(selectionCount)} leads?`,
      description: 'Their notes, tasks, messages and campaign history are deleted too. This can’t be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) await runBulk('delete', null, 'Deleted');
  }

  async function doExport(sel?: Selection) {
    setExporting(true);
    const id = toast.loading('Preparing export…');
    try {
      const n = await exportLeadsCsv({
        workspaceId: workspace.id,
        filters: sel?.filters ?? effective,
        ids: sel?.ids ?? undefined,
        stages: stageById,
        members: memberById,
      });
      toast.success(`Exported ${formatNumber(n)} leads`, { id });
    } catch (e) {
      toast.error(errorMessage(e), { id });
    } finally {
      setExporting(false);
    }
  }

  const sortHeader = (key: SortKey, label: string, className?: string) => (
    <Th className={className}>
      <button
        className="inline-flex items-center gap-1 uppercase hover:text-foreground"
        onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : key === 'business_name' }))}
      >
        {label}
        {sort.key === key && (sort.asc ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </Th>
  );

  const from = page * PAGE_SIZE;
  const hasFilters = Object.keys(effective).length > 0;

  return (
    <Page wide>
      <PageHeader
        icon={<Users />}
        title="Leads"
        description={isLoading ? 'Loading…' : `${formatNumber(total)} ${hasFilters ? 'matching' : 'total'} lead${total === 1 ? '' : 's'}`}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => doExport()} loading={exporting}>
              <Download /> Export
            </Button>
            {can.write && (
              <>
                <Button variant="secondary" size="sm" onClick={() => setDialog('import')}>
                  <Upload /> Import
                </Button>
                <Button variant="primary" size="sm" onClick={() => setParam('new', '1')}>
                  <Plus /> Add lead
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="no-scrollbar mb-4 overflow-x-auto">
        <Segmented<View>
          value={view}
          onChange={(v) => {
            setView(v);
            setParam('view', v === 'all' ? null : v);
          }}
          options={[
            { value: 'all', label: 'All' },
            { value: 'website', label: 'Has website', icon: <Globe /> },
            { value: 'no_website', label: 'No website' },
            { value: 'mine', label: 'My leads', icon: <UserRound /> },
            { value: 'unassigned', label: 'Unassigned' },
            { value: 'replied', label: 'Replied' },
            { value: 'opted_out', label: 'Opted out', icon: <Ban /> },
          ]}
        />
      </div>

      <FilterBar filters={filters} onChange={setFilters} />
      {filters.list_ids?.length ? (
        <div className="ml-2 mt-3 inline-flex items-center gap-2 rounded-lg bg-primary-soft px-3 py-1.5 text-xs font-medium text-primary">
          <ListChecks className="size-3.5" /> Showing one lead list
          <button onClick={() => setFilters(({ list_ids: _drop, ...rest }) => rest)} aria-label="Clear">
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
      {filters.scrape_job_id && (
        <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-primary-soft px-3 py-1.5 text-xs font-medium text-primary">
          <MapPin className="size-3.5" /> Showing leads from one lead search
          <button onClick={() => setFilters(({ scrape_job_id: _drop, ...rest }) => rest)} aria-label="Clear">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
        {somePageSelected && allPageSelected && !allMatching && total > rows.length && (
          <div className="flex items-center justify-center gap-2 border-b border-border bg-primary-soft px-4 py-2 text-[13px]">
            All {rows.length} leads on this page are selected.
            <button className="font-semibold text-primary hover:underline" onClick={() => setAllMatching(true)}>
              Select all {formatNumber(total)} matching leads
            </button>
          </div>
        )}
        {allMatching && (
          <div className="flex items-center justify-center gap-2 border-b border-border bg-primary-soft px-4 py-2 text-[13px]">
            All {formatNumber(total)} matching leads are selected.
            <button className="font-semibold text-primary hover:underline" onClick={clearSelection}>
              Clear selection
            </button>
          </div>
        )}
        <div className={cn('overflow-x-auto transition-opacity', isFetching && !isLoading && 'opacity-70')}>
          <Table className="min-w-[1080px]">
            <thead>
              <tr>
                <Th className="w-10">
                  <Checkbox checked={allPageSelected ? true : somePageSelected ? 'indeterminate' : false} onCheckedChange={toggleAll} aria-label="Select page" />
                </Th>
                {sortHeader('score', 'Business · score')}
                <Th>Phone</Th>
                <Th>Location</Th>
                <Th>Stage</Th>
                <Th>Owner</Th>
                {sortHeader('rating', 'Rating')}
                <Th>Tags</Th>
                {sortHeader('last_contacted_at', 'Contacted')}
                {sortHeader('created_at', 'Added')}
              </tr>
            </thead>
            <tbody>
              {isLoading &&
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    <Td colSpan={10}>
                      <Skeleton className="h-5 w-full" />
                    </Td>
                  </tr>
                ))}
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={10}>
                    {hasFilters ? (
                      <EmptyState icon={<Target />} title="No leads match" description="Try removing a filter or searching for something else." action={<Button onClick={() => { setFilters({}); setView('all'); }}>Clear filters</Button>} />
                    ) : (
                      <EmptyState
                        icon={<Users />}
                        title="No leads yet"
                        description={can.scrape ? 'Find businesses on Google Maps, import a CSV, or add one by hand.' : 'Import a CSV, or add one by hand.'}
                        action={
                          can.write && (
                            <>
                              {can.scrape && (
                                <Button variant="primary" onClick={() => router.push('/scraper?new=1')}>
                                  <MapPin /> Find leads
                                </Button>
                              )}
                              <Button onClick={() => setDialog('import')}>
                                <Upload /> Import CSV
                              </Button>
                            </>
                          )
                        }
                      />
                    )}
                  </td>
                </tr>
              )}
              {rows.map((l) => (
                <LeadRow
                  key={l.id}
                  lead={l}
                  selected={allMatching || selected.has(l.id)}
                  onToggle={() => toggle(l.id)}
                  onOpen={() => setParam('lead', l.id)}
                  onPatch={(patch) => update.mutate({ id: l.id, patch })}
                  canWrite={can.write}
                />
              ))}
            </tbody>
          </Table>
        </div>
        {total > 0 && (
          <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-[13px] text-muted">
            <span className="tabular">
              {formatNumber(from + 1)}–{formatNumber(Math.min(from + PAGE_SIZE, total))} of {formatNumber(total)}
            </span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                <ChevronLeft />
              </Button>
              <span className="tabular px-2 text-xs">
                Page {page + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
              </span>
              <Button variant="ghost" size="icon-sm" disabled={from + PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
                <ChevronRight />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Floating bulk bar */}
      {selectionCount > 0 && (
        <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 animate-slide-up items-center gap-1 rounded-2xl border border-border bg-surface p-1.5 pl-4 shadow-lg lg:ml-[124px]">
          <span className="mr-2 text-[13px] font-medium tabular">{formatNumber(selectionCount)} selected</span>
          {can.write && (
            <>
              <Button size="sm" variant="primary" onClick={() => startCampaign(selection)}>
                <Send /> Add to campaign
              </Button>
              <BulkStageMenu onPick={(id, name) => runBulk('set_stage', id, `Moved to ${name}:`)} />
              <BulkOwnerMenu onPick={(id) => runBulk('set_owner', id, id ? 'Assigned' : 'Unassigned')} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost">
                    <MoreHorizontal /> More
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" className="w-56">
                  <DropdownMenuItem onSelect={() => setDialog('add-tags')}>
                    <TagIcon /> Add tags
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDialog('remove-tags')}>
                    <TagIcon /> Remove tags
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDialog('add-list')}>
                    <ListChecks /> Add to list
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDialog('verify')}>
                    <ShieldCheck /> Verify WhatsApp numbers
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => doExport(selection)}>
                    <Download /> Export selected
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => runBulk('opt_out', null, 'Opted out')}>
                    <Ban /> Mark as opted out
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => runBulk('opt_in', null, 'Opted in')}>
                    <ShieldCheck /> Opt back in
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem danger onSelect={bulkDelete}>
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
          <Tooltip content="Clear selection">
            <Button size="icon-sm" variant="ghost" onClick={clearSelection} aria-label="Clear selection">
              <X />
            </Button>
          </Tooltip>
        </div>
      )}

      <LeadDrawer leadId={leadId} onClose={() => setParam('lead', null)} />
      <LeadFormDialog open={showNew} onOpenChange={(o) => !o && setParam('new', null)} onSaved={(l) => setParams({ new: null, lead: l.id })} />
      <ImportDialog open={dialog === 'import'} onOpenChange={(o) => setDialog(o ? 'import' : null)} />
      <TagsDialog
        open={dialog === 'add-tags' || dialog === 'remove-tags'}
        onOpenChange={(o) => !o && setDialog(null)}
        mode={dialog === 'remove-tags' ? 'remove' : 'add'}
        count={selectionCount}
        onApply={(tags) => runBulk(dialog === 'remove-tags' ? 'remove_tags' : 'add_tags', tags, dialog === 'remove-tags' ? 'Removed tags from' : 'Tagged')}
      />
      <AddToListDialog open={dialog === 'add-list'} onOpenChange={(o) => !o && setDialog(null)} ids={selection.ids} filters={selection.filters} count={selectionCount} />
      <VerifyDialog open={dialog === 'verify'} onOpenChange={(o) => !o && setDialog(null)} selection={selection} />
    </Page>
  );
}

function BulkStageMenu({ onPick }: { onPick: (id: string, name: string) => void }) {
  const { stages } = useStages();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost">
          <Target /> Stage
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" className="w-52">
        <DropdownMenuLabel>Move to</DropdownMenuLabel>
        {stages.map((s) => (
          <DropdownMenuItem key={s.id} onSelect={() => onPick(s.id, s.name)}>
            <StageDot color={s.color} /> {s.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BulkOwnerMenu({ onPick }: { onPick: (id: string | null) => void }) {
  const { members } = useMembers();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost">
          <UserRound /> Assign
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" className="w-56">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <UserRound /> Assign to…
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            {members.map((m) => (
              <DropdownMenuItem key={m.user_id} onSelect={() => onPick(m.user_id)}>
                <Avatar name={m.profile.full_name || m.profile.email} size="xs" />
                {m.profile.full_name || m.profile.email}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={() => onPick(null)}>
          <X /> Unassign
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const LeadRow = React.memo(function LeadRow({
  lead,
  selected,
  onToggle,
  onOpen,
  onPatch,
  canWrite,
}: {
  lead: Lead;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onPatch: (p: Partial<Lead>) => void;
  canWrite: boolean;
}) {
  return (
    <Tr selected={selected} className="cursor-pointer" onClick={onOpen}>
      <Td onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${lead.business_name}`} />
      </Td>
      <Td className="max-w-[280px]">
        <div className="flex items-center gap-2.5">
          <Avatar name={lead.business_name} size="md" square />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <ScoreBadge score={lead.score} tier={lead.score_tier} />
              <span className="truncate font-medium text-foreground">{lead.business_name}</span>
              {lead.opted_out && (
                <Tooltip content="Opted out">
                  <Ban className="size-3 shrink-0 text-warning" />
                </Tooltip>
              )}
            </div>
            <div className="flex items-center gap-1.5 truncate text-xs text-subtle">
              {lead.category && <span className="truncate">{lead.category}</span>}
              {lead.website ? (
                <span className="inline-flex items-center gap-1 truncate text-info">
                  <Globe className="size-3" />
                  {hostname(lead.website)}
                </span>
              ) : (
                <span className="text-warning/90">no website</span>
              )}
            </div>
          </div>
        </div>
      </Td>
      <Td className="whitespace-nowrap">
        <div className="flex items-center gap-1.5">
          <WaStatus lead={lead} />
          <PhoneText phone={lead.phone} copy />
          {lead.phone_type === 'landline' && <LandlineBadge />}
        </div>
      </Td>
      <Td className="max-w-[160px]">
        <span className="truncate text-muted">
          {lead.city ?? '—'}
          {lead.country && <span className="text-subtle"> · {lead.country}</span>}
        </span>
      </Td>
      <Td onClick={(e) => e.stopPropagation()}>
        <StageSelect value={lead.stage_id} onChange={(id) => onPatch({ stage_id: id })} disabled={!canWrite} />
      </Td>
      <Td onClick={(e) => e.stopPropagation()}>
        <OwnerSelect value={lead.owner_id} onChange={(id) => onPatch({ owner_id: id })} disabled={!canWrite} />
      </Td>
      <Td>
        <Rating rating={lead.rating} reviews={lead.reviews_count} />
      </Td>
      <Td className="max-w-[200px]">
        <div className="flex items-center gap-1">
          {lead.tags.slice(0, 2).map((t) => (
            <Tag key={t} className="max-w-[120px]">
              {t}
            </Tag>
          ))}
          {lead.tags.length > 2 && <span className="shrink-0 text-[11px] text-subtle">+{lead.tags.length - 2}</span>}
        </div>
      </Td>
      <Td className="whitespace-nowrap text-xs text-muted">
        {lead.last_replied_at ? <span className="font-medium text-success">Replied {timeAgo(lead.last_replied_at)}</span> : lead.last_contacted_at ? timeAgo(lead.last_contacted_at) : <span className="text-subtle">Never</span>}
      </Td>
      <Td className="whitespace-nowrap text-xs text-subtle">
        <AddedBy userId={lead.created_by} />
        {timeAgo(lead.created_at)}
      </Td>
    </Tr>
  );
});

/** Who added (scraped / imported / created) the lead. */
function AddedBy({ userId }: { userId: string | null }) {
  const { byId } = useMembers();
  const m = userId ? byId.get(userId) : null;
  if (!m) return null;
  return <div className="max-w-[120px] truncate text-muted">{m.profile.full_name || m.profile.email}</div>;
}
