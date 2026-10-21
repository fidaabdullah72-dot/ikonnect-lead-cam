'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { Globe, KanbanSquare, Search, Settings2, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import type { Lead, LeadFilters, PipelineStage } from '@batsols/shared';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/controls';
import { Skeleton } from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { MultiSelect } from '@/components/ui/multi-select';
import { LeadDrawer } from '@/components/leads/lead-drawer';
import { WaStatus } from '@/components/leads/bits';
import { getSupabase } from '@/lib/supabase/client';
import { cleanFilters, useInvalidateLeads } from '@/lib/leads';
import { useLeadFacets, useMembers, useStages } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, errorMessage, formatCompact, formatMoney, formatNumber, timeAgo } from '@/lib/utils';

const PER_COLUMN = 40;

type Column = { stage: PipelineStage; leads: Lead[]; count: number; value: number };

function usePipeline(filters: LeadFilters, limits: Record<string, number>) {
  const { workspace } = useWorkspace();
  const { stages } = useStages();
  const f = cleanFilters(filters);
  return useQuery({
    queryKey: ['pipeline', workspace.id, f, limits, stages.map((s) => s.id)],
    enabled: stages.length > 0,
    queryFn: async () => {
      const sb = getSupabase();
      const cols = await Promise.all(
        stages.map(async (stage): Promise<Column> => {
          const filters = { ...f, stage_ids: [stage.id] };
          const [list, values] = await Promise.all([
            sb
              .rpc('filtered_leads', { p_workspace: workspace.id, p_filters: filters }, { count: 'exact' })
              .select('*')
              .order('updated_at', { ascending: false })
              .limit(limits[stage.id] ?? PER_COLUMN),
            sb.rpc('filtered_leads', { p_workspace: workspace.id, p_filters: filters }).select('deal_value').gt('deal_value', 0).limit(5000),
          ]);
          if (list.error) throw list.error;
          const value = ((values.data ?? []) as Array<{ deal_value: number }>).reduce((s, r) => s + Number(r.deal_value || 0), 0);
          return { stage, leads: (list.data ?? []) as Lead[], count: list.count ?? 0, value };
        }),
      );
      return cols;
    },
  });
}

export function PipelineView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { userId, workspace, can } = useWorkspace();
  const facets = useLeadFacets();
  const invalidate = useInvalidateLeads();
  const qc = useQueryClient();
  const [scope, setScope] = React.useState<'all' | 'mine'>('all');
  const [q, setQ] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [tags, setTags] = React.useState<string[]>([]);
  const [limits, setLimits] = React.useState<Record<string, number>>({});
  const [active, setActive] = React.useState<Lead | null>(null);
  const currency = workspace.settings.currency ?? 'USD';

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const filters: LeadFilters = { q: debounced, tags, ...(scope === 'mine' ? { owner_ids: [userId] } : {}) };
  const { data: columns, isLoading } = usePipeline(filters, limits);
  const [optimistic, setOptimistic] = React.useState<Column[] | null>(null);
  React.useEffect(() => setOptimistic(null), [columns]);
  const cols = optimistic ?? columns ?? [];

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const leadId = params.get('lead');
  const openLead = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set('lead', id);
    else next.delete('lead');
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  };

  function onDragStart(e: DragStartEvent) {
    setActive((e.active.data.current?.lead as Lead) ?? null);
  }

  async function onDragEnd(e: DragEndEvent) {
    setActive(null);
    const lead = e.active.data.current?.lead as Lead | undefined;
    const toStage = e.over?.id as string | undefined;
    if (!lead || !toStage || lead.stage_id === toStage) return;

    // Optimistic move
    const moved = { ...lead, stage_id: toStage };
    setOptimistic(
      cols.map((c) => {
        if (c.stage.id === lead.stage_id) return { ...c, leads: c.leads.filter((l) => l.id !== lead.id), count: c.count - 1, value: c.value - lead.deal_value };
        if (c.stage.id === toStage) return { ...c, leads: [moved, ...c.leads], count: c.count + 1, value: c.value + lead.deal_value };
        return c;
      }),
    );
    const { error } = await getSupabase().from('leads').update({ stage_id: toStage }).eq('id', lead.id);
    if (error) {
      toast.error(errorMessage(error));
      setOptimistic(null);
      return;
    }
    const stage = cols.find((c) => c.stage.id === toStage)?.stage;
    toast.success(`${lead.business_name} → ${stage?.name}`);
    invalidate(lead.id);
    qc.invalidateQueries({ queryKey: ['pipeline', workspace.id] });
  }

  const totalOpen = cols.filter((c) => c.stage.kind !== 'won' && c.stage.kind !== 'lost').reduce((s, c) => s + c.value, 0);
  const totalWon = cols.filter((c) => c.stage.kind === 'won').reduce((s, c) => s + c.value, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-4 pb-4 pt-6 sm:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 hidden size-10 items-center justify-center rounded-xl border border-border bg-surface text-primary shadow-sm sm:flex">
              <KanbanSquare className="size-5" />
            </div>
            <div>
              <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">Pipeline</h1>
              <p className="mt-1 text-[13.5px] text-muted">
                Open pipeline <span className="font-semibold text-foreground">{formatMoney(totalOpen, currency)}</span> · Won{' '}
                <span className="font-semibold text-success">{formatMoney(totalWon, currency)}</span>
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={scope}
              onChange={setScope}
              options={[
                { value: 'all', label: 'Everyone' },
                { value: 'mine', label: 'Mine', icon: <UserRound /> },
              ]}
            />
            <Input inputSize="sm" className="w-56" leading={<Search />} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
            <MultiSelect label="Tags" options={(facets.data?.tags ?? []).map((t) => ({ value: t.value, label: `#${t.value}`, count: t.count }))} value={tags} onChange={setTags} />
            {can.admin && (
              <Button size="sm" variant="ghost" asChild>
                <Link href="/settings/pipeline">
                  <Settings2 /> Stages
                </Link>
              </Button>
            )}
          </div>
        </div>
      </div>

      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActive(null)}>
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 py-4 sm:px-8">
          {isLoading
            ? Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="w-[288px] shrink-0 space-y-2">
                  <Skeleton className="h-8" />
                  <Skeleton className="h-24" />
                  <Skeleton className="h-24" />
                </div>
              ))
            : cols.map((c) => (
                <KanbanColumn
                  key={c.stage.id}
                  column={c}
                  currency={currency}
                  canDrag={can.write}
                  onOpen={openLead}
                  onMore={() => setLimits((l) => ({ ...l, [c.stage.id]: (l[c.stage.id] ?? PER_COLUMN) + PER_COLUMN }))}
                />
              ))}
        </div>
        <DragOverlay dropAnimation={{ duration: 180 }}>{active ? <LeadCard lead={active} currency={currency} overlay /> : null}</DragOverlay>
      </DndContext>

      <LeadDrawer leadId={leadId} onClose={() => openLead(null)} />
    </div>
  );
}

function KanbanColumn({ column, currency, canDrag, onOpen, onMore }: { column: Column; currency: string; canDrag: boolean; onOpen: (id: string) => void; onMore: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.stage.id });
  const { stage, leads, count, value } = column;
  return (
    <div className="flex w-[288px] shrink-0 flex-col">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="size-2.5 rounded-full" style={{ background: stage.color }} />
        <span className="text-[13px] font-semibold">{stage.name}</span>
        <span className="tabular rounded-full bg-surface-2 px-1.5 text-[11px] font-medium text-muted">{formatNumber(count)}</span>
        {value > 0 && <span className="tabular ml-auto text-xs text-subtle">{formatMoney(value, currency)}</span>}
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-[120px] flex-1 flex-col gap-2 overflow-y-auto rounded-xl border border-transparent bg-surface-2/50 p-2 transition-colors',
          isOver && 'border-primary/50 bg-primary-soft',
        )}
        style={{ boxShadow: `inset 0 2px 0 ${stage.color}` }}
      >
        {leads.map((l) => (
          <DraggableCard key={l.id} lead={l} currency={currency} disabled={!canDrag} onOpen={() => onOpen(l.id)} />
        ))}
        {leads.length === 0 && <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border-strong/60 py-8 text-xs text-subtle">Drop leads here</div>}
        {leads.length < count && (
          <Button variant="ghost" size="sm" className="w-full" onClick={onMore}>
            Show more ({formatCompact(count - leads.length)} left)
          </Button>
        )}
      </div>
    </div>
  );
}

function DraggableCard({ lead, currency, disabled, onOpen }: { lead: Lead; currency: string; disabled: boolean; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: lead.id, data: { lead }, disabled });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} onClick={onOpen} className={cn('outline-none', isDragging && 'opacity-30')}>
      <LeadCard lead={lead} currency={currency} />
    </div>
  );
}

function LeadCard({ lead, currency, overlay }: { lead: Lead; currency: string; overlay?: boolean }) {
  const { byId } = useMembers();
  const owner = lead.owner_id ? byId.get(lead.owner_id) : undefined;
  return (
    <div
      className={cn(
        'cursor-grab rounded-lg border border-border bg-surface p-3 shadow-sm transition-[box-shadow,border-color] hover:border-border-strong hover:shadow-md active:cursor-grabbing',
        overlay && 'rotate-[1.5deg] shadow-lg ring-1 ring-primary/30',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">{lead.business_name}</div>
          <div className="truncate text-xs text-subtle">{[lead.category, lead.city].filter(Boolean).join(' · ') || '—'}</div>
        </div>
        {owner && <Avatar name={owner.profile.full_name || owner.profile.email} src={owner.profile.avatar_url} size="xs" />}
      </div>
      <div className="mt-2.5 flex items-center gap-2 text-xs">
        <WaStatus lead={lead} />
        {lead.website ? <Globe className="size-3.5 text-info" /> : <span className="text-[11px] text-warning/90">no site</span>}
        {lead.last_replied_at && <span className="rounded bg-success-soft px-1.5 text-[10.5px] font-medium text-success">replied</span>}
        <span className="ml-auto text-[11px] text-subtle">{timeAgo(lead.updated_at)}</span>
      </div>
      {lead.deal_value > 0 && <div className="tabular mt-2 text-[13px] font-semibold">{formatMoney(lead.deal_value, currency)}</div>}
    </div>
  );
}
