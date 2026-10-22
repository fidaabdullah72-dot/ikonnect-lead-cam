'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import type { Lead, LeadFilters } from '@batsols/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { PhoneText } from '@/components/leads/bits';
import { getSupabase } from '@/lib/supabase/client';
import { cleanFilters } from '@/lib/leads';
import { useWorkspace } from '@/lib/workspace';
import { cn, formatNumber } from '@/lib/utils';

type Row = Pick<Lead, 'id' | 'business_name' | 'phone' | 'city' | 'country' | 'category'>;
const PAGE = 50;

/**
 * Search the lead bank and tick leads one by one (hand-picked campaign audience).
 * `base` limits what can be picked, e.g. only leads that can receive a WhatsApp message.
 */
export function LeadPicker({ selected, onChange, base }: { selected: string[]; onChange: (ids: string[]) => void; base?: LeadFilters }) {
  const { workspace } = useWorkspace();
  const [q, setQ] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [limit, setLimit] = React.useState(PAGE);
  const [onlyPicked, setOnlyPicked] = React.useState(false);
  React.useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q.trim());
      setLimit(PAGE);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const filters = cleanFilters({ ...base, ...(query ? { q: query } : {}), ...(onlyPicked ? { ids: selected } : {}) });
  const list = useQuery({
    queryKey: ['lead-picker', workspace.id, filters, limit],
    enabled: !onlyPicked || selected.length > 0,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error, count } = await getSupabase()
        .rpc('filtered_leads', { p_workspace: workspace.id, p_filters: filters }, { count: 'exact' })
        .select('id, business_name, phone, city, country, category, created_at')
        .order('created_at', { ascending: false })
        .range(0, limit - 1);
      if (error) throw error;
      return { rows: (data ?? []) as Row[], total: count ?? 0 };
    },
  });

  const picked = React.useMemo(() => new Set(selected), [selected]);
  const rows = onlyPicked && !selected.length ? [] : (list.data?.rows ?? []);
  const shownPicked = rows.filter((r) => picked.has(r.id)).length;
  const toggle = (id: string, on: boolean) => onChange(on ? [...selected, id] : selected.filter((x) => x !== id));
  const toggleShown = (on: boolean) => {
    const ids = rows.map((r) => r.id);
    onChange(on ? [...new Set([...selected, ...ids])] : selected.filter((x) => !ids.includes(x)));
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2/40 p-2.5">
        <Input inputSize="sm" leading={<Search />} placeholder="Search by name, phone, city, category…" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 flex-1 basis-56" />
        <div className="flex items-center gap-2">
          <Button size="sm" variant={onlyPicked ? 'primary' : 'secondary'} onClick={() => setOnlyPicked((v) => !v)} disabled={!selected.length && !onlyPicked}>
            {formatNumber(selected.length)} picked
          </Button>
          {selected.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => onChange([])}>
              <X /> Clear
            </Button>
          )}
        </div>
      </div>
      <label className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 text-[12.5px] text-muted">
        <Checkbox checked={rows.length > 0 && shownPicked === rows.length ? true : shownPicked > 0 ? 'indeterminate' : false} onCheckedChange={(v) => toggleShown(v === true)} disabled={!rows.length} />
        {rows.length ? `Select all ${formatNumber(rows.length)} shown` : 'Nothing to select'}
        <span className="ml-auto tabular">{list.data ? `${formatNumber(onlyPicked ? selected.length : list.data.total)} leads` : ''}</span>
      </label>
      <div className="max-h-[360px] overflow-y-auto">
        {list.isLoading && (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        )}
        {list.isError && <div className="p-4 text-[13px] text-danger">Couldn’t load leads. {(list.error as Error).message}</div>}
        {!list.isLoading && !rows.length && !list.isError && (
          <div className="p-6 text-center text-[13px] text-muted">{onlyPicked ? 'No leads picked yet.' : query ? 'No leads match that search.' : 'No leads that can be messaged yet.'}</div>
        )}
        {rows.map((r) => (
          <label key={r.id} className={cn('flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 last:border-0 hover:bg-surface-2/50', picked.has(r.id) && 'bg-primary-soft/60')}>
            <Checkbox checked={picked.has(r.id)} onCheckedChange={(v) => toggle(r.id, v === true)} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{r.business_name}</div>
              <div className="truncate text-xs text-subtle">{[r.category, r.city, r.country].filter(Boolean).join(' · ') || '—'}</div>
            </div>
            <span className="hidden shrink-0 text-xs sm:inline">
              <PhoneText phone={r.phone} />
            </span>
          </label>
        ))}
        {!onlyPicked && list.data && list.data.total > rows.length && (
          <div className="p-2 text-center">
            <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + PAGE)} loading={list.isFetching}>
              Show more ({formatNumber(list.data.total - rows.length)} left)
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
