'use client';

import Papa from 'papaparse';
import { formatPhone, type Lead, type LeadFilters, type PipelineStage } from '@batsols/shared';
import { getSupabase } from '@/lib/supabase/client';
import { cleanFilters, LEAD_CSV_COLUMNS } from '@/lib/leads';
import type { Member } from '@/lib/queries';
import { downloadFile } from '@/lib/utils';

const MAX_EXPORT = 50_000;

/** Export leads (selected ids or everything matching filters) as CSV. */
export async function exportLeadsCsv(opts: {
  workspaceId: string;
  filters: LeadFilters;
  ids?: string[];
  stages: Map<string, PipelineStage>;
  members: Map<string, Member>;
  onProgress?: (n: number) => void;
}) {
  const sb = getSupabase();
  const rows: Lead[] = [];
  const pageSize = 1000;
  for (let from = 0; from < MAX_EXPORT; from += pageSize) {
    let q = sb
      .rpc('filtered_leads', { p_workspace: opts.workspaceId, p_filters: cleanFilters(opts.filters) })
      .select('*')
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, from + pageSize - 1);
    if (opts.ids?.length) q = q.in('id', opts.ids);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...((data ?? []) as Lead[]));
    opts.onProgress?.(rows.length);
    if (!data || data.length < pageSize) break;
  }

  const csv = Papa.unparse(
    rows.map((l) => {
      const out: Record<string, string | number> = {};
      for (const c of LEAD_CSV_COLUMNS) {
        let v: unknown;
        if (c.key === 'stage') v = l.stage_id ? opts.stages.get(l.stage_id)?.name : '';
        else if (c.key === 'owner') {
          const m = l.owner_id ? opts.members.get(l.owner_id) : undefined;
          v = m ? m.profile.full_name || m.profile.email : '';
        } else if (c.key === 'phone') v = l.phone ? formatPhone(l.phone) : '';
        else if (c.key === 'tags') v = l.tags.join(', ');
        else v = l[c.key as keyof Lead];
        out[c.label] = v === null || v === undefined ? '' : (v as string | number);
      }
      return out;
    }),
  );
  downloadFile(`leads-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  return rows.length;
}
