'use client';

import * as React from 'react';
import Link from 'next/link';
import { ListChecks, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { Skeleton } from '@/components/ui/feedback';
import { useLeadLists, useListStats } from '@/lib/lists';
import { cn, formatNumber } from '@/lib/utils';

/** Tick one or more lead lists (campaign audience, add leads to a campaign). */
export function ListPicker({ selected, onChange }: { selected: string[]; onChange: (ids: string[]) => void }) {
  const { data: lists = [], isLoading } = useLeadLists();
  const stats = useListStats();
  const picked = new Set(selected);
  const toggle = (id: string, on: boolean) => onChange(on ? [...new Set([...selected, id])] : selected.filter((x) => x !== id));

  if (isLoading) return <Skeleton className="h-32 rounded-xl" />;
  if (!lists.length) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-strong px-6 py-8 text-center">
        <ListChecks className="size-6 text-subtle" />
        <div className="text-[13.5px] text-muted">No lead lists yet. Create one and import a CSV into it, or add leads from the Leads page.</div>
        <Button size="sm" variant="secondary" asChild>
          <Link href="/lists">
            <Plus /> Go to lead lists
          </Link>
        </Button>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="flex items-center justify-between border-b border-border bg-surface-2/40 px-3 py-2 text-[12.5px] text-muted">
        <span>{selected.length ? `${formatNumber(selected.length)} of ${formatNumber(lists.length)} lists picked` : 'Pick the lists to message'}</span>
        {selected.length > 0 && (
          <button type="button" className="hover:text-foreground" onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </div>
      <div className="max-h-[320px] overflow-y-auto">
        {lists.map((l) => {
          const s = stats.data?.get(l.id);
          return (
            <label key={l.id} className={cn('flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2.5 last:border-0 hover:bg-surface-2/50', picked.has(l.id) && 'bg-primary-soft/60')}>
              <Checkbox checked={picked.has(l.id)} onCheckedChange={(v) => toggle(l.id, v === true)} />
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: l.color }} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium">{l.name}</div>
                {s ? (
                  <div className="truncate text-xs text-subtle">
                    {formatNumber(s.sendable)} can be messaged · {formatNumber(s.contacted)} contacted · {formatNumber(s.replied)} replied
                  </div>
                ) : (
                  l.description && <div className="truncate text-xs text-subtle">{l.description}</div>
                )}
              </div>
              <span className="shrink-0 text-[13px] tabular text-muted">{formatNumber(l.count)} leads</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
