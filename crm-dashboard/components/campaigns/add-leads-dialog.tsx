'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Lead, LeadFilters } from '@batsols/shared';
import { FilterBar } from '@/components/leads/filter-bar';
import { PhoneText } from '@/components/leads/bits';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { getSupabase } from '@/lib/supabase/client';
import { cleanFilters } from '@/lib/leads';
import { qk } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { errorMessage, formatNumber } from '@/lib/utils';
import { ListPicker } from '@/components/lists/list-picker';
import { pickTopLeadIds } from '@/lib/campaigns';
import { LeadLimitField } from './lead-limit';
import { LeadPicker } from './lead-picker';
import { NO_LEAD } from './builder/state';

type PreviewRow = Pick<Lead, 'id' | 'business_name' | 'phone' | 'city' | 'category'>;

type Mode = 'lists' | 'filters' | 'pick';

/** Add more leads to a campaign — from lead lists, by filters (with a preview) or hand-picked. Dedupe and no-double-outreach are automatic. */
export function AddLeadsDialog({ open, onOpenChange, campaignId }: { open: boolean; onOpenChange: (o: boolean) => void; campaignId: string }) {
  const { workspace } = useWorkspace();
  const qc = useQueryClient();
  const [mode, setMode] = React.useState<Mode>('lists');
  const [filters, setFilters] = React.useState<LeadFilters>({});
  const [lists, setLists] = React.useState<string[]>([]);
  const [picked, setPicked] = React.useState<string[]>([]);
  const [limit, setLimit] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);
  const base: LeadFilters = { sendable: true, not_in_active_campaign: true, exclude_campaign_id: campaignId };
  const effective = cleanFilters(
    mode === 'filters' ? { ...filters, ...base } : mode === 'lists' ? { ...base, list_ids: lists.length ? lists : [NO_LEAD] } : { ...base, ids: picked },
  );

  const preview = useQuery({
    queryKey: ['add-leads-preview', campaignId, effective],
    enabled: open && (mode === 'filters' || (mode === 'lists' ? lists.length > 0 : picked.length > 0)),
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error, count } = await getSupabase()
        .rpc('filtered_leads', { p_workspace: workspace.id, p_filters: effective }, { count: 'exact' })
        .select('id, business_name, phone, city, category, score, created_at')
        .order('score', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id')
        .limit(8);
      if (error) throw error;
      return { rows: (data ?? []) as PreviewRow[], total: count ?? 0 };
    },
  });
  const available = (mode === 'pick' && !picked.length) || (mode === 'lists' && !lists.length) ? 0 : (preview.data?.total ?? 0);
  const cap = mode !== 'pick' ? limit : null;
  const total = cap ? Math.min(cap, available) : available;

  async function add() {
    setBusy(true);
    let filters = effective;
    try {
      // "How many leads": only the best-scored N of the matching leads.
      if (cap) {
        const ids = await pickTopLeadIds(workspace.id, effective, cap);
        filters = { ...effective, ids: ids.length ? ids : [NO_LEAD] };
      }
    } catch (e) {
      setBusy(false);
      return toast.error(errorMessage(e));
    }
    const { data, error } = await getSupabase().rpc('campaign_add_recipients', { p_campaign: campaignId, p_filters: filters });
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    toast.success(`${formatNumber(data as number)} leads added`);
    qc.invalidateQueries({ queryKey: qk.campaign(campaignId) });
    qc.invalidateQueries({ queryKey: ['campaign-recipients', campaignId] });
    if (mode === 'lists') await rememberLists(campaignId, lists);
    qc.invalidateQueries({ queryKey: ['lead-list-stats', workspace.id] });
    setPicked([]);
    setLists([]);
    setLimit(null);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" title="Add leads to this campaign" description="Leads already in this or another active campaign, opted out or without WhatsApp are skipped automatically.">
        <DialogBody className="space-y-4">
          <Segmented<Mode>
            value={mode}
            onChange={setMode}
            options={[
              { value: 'lists', label: 'From lead lists' },
              { value: 'filters', label: 'Leads matching filters' },
              { value: 'pick', label: 'Pick leads' },
            ]}
          />
          {mode === 'lists' ? (
            <ListPicker selected={lists} onChange={setLists} />
          ) : mode === 'filters' ? (
            <FilterBar filters={filters} onChange={setFilters} />
          ) : (
            <LeadPicker selected={picked} onChange={setPicked} base={base} />
          )}
          {mode !== 'pick' && (
            <div className="flex flex-col gap-2 rounded-xl border border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-[13.5px] font-medium">How many leads</div>
                <div className="text-[12.5px] text-muted">Add only this many — the best-scored first.</div>
              </div>
              <LeadLimitField value={limit} onChange={setLimit} available={available} />
            </div>
          )}
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="flex items-center justify-between gap-3 bg-primary-soft px-4 py-2.5 text-[13.5px]">
              <span>
                <b className="tabular text-primary">{formatNumber(total)}</b> new leads will be added
                {cap && available > total && <span className="text-muted"> · first {formatNumber(total)} of {formatNumber(available)} by score</span>}
              </span>
              {preview.isFetching && <Spinner className="size-4" />}
            </div>
            {mode !== 'pick' && (preview.data?.rows.length ?? 0) > 0 && (
              <ul className="divide-y divide-border">
                {preview.data!.rows.slice(0, total).map((l) => (
                  <li key={l.id} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{l.business_name}</span>
                      <span className="text-subtle"> {[l.category, l.city].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="hidden shrink-0 text-xs sm:inline">
                      <PhoneText phone={l.phone} />
                    </span>
                  </li>
                ))}
                {total > preview.data!.rows.length && <li className="px-4 py-2 text-xs text-subtle">…and {formatNumber(total - preview.data!.rows.length)} more</li>}
              </ul>
            )}
            {preview.isError && <div className="px-4 py-2 text-[13px] text-danger">{errorMessage(preview.error)}</div>}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={add} loading={busy} disabled={!total}>
            Add {formatNumber(total)} leads
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Record on the campaign which lists its leads came from, so each list shows the campaigns that used it. */
export async function rememberLists(campaignId: string, listIds: string[]) {
  const sb = getSupabase();
  const { data } = await sb.from('campaigns').select('audience').eq('id', campaignId).maybeSingle();
  if (!data) return;
  const current = data.audience?.list_ids ?? [];
  const next = [...new Set([...current, ...listIds])];
  if (next.length === current.length) return;
  await sb.from('campaigns').update({ audience: { ...data.audience, list_ids: next } }).eq('id', campaignId);
}
