'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { LeadFilters } from '@batsols/shared';
import { FilterBar } from '@/components/leads/filter-bar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { getSupabase } from '@/lib/supabase/client';
import { cleanFilters } from '@/lib/leads';
import { qk } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { errorMessage, formatNumber } from '@/lib/utils';

/** Add more leads to a running/paused campaign (dedupe and no-double-outreach are automatic). */
export function AddLeadsDialog({ open, onOpenChange, campaignId }: { open: boolean; onOpenChange: (o: boolean) => void; campaignId: string }) {
  const { workspace } = useWorkspace();
  const qc = useQueryClient();
  const [filters, setFilters] = React.useState<LeadFilters>({});
  const [busy, setBusy] = React.useState(false);
  const effective = cleanFilters({ ...filters, sendable: true, not_in_active_campaign: true, exclude_campaign_id: campaignId });
  const count = useQuery({
    queryKey: ['add-leads-count', campaignId, effective],
    enabled: open,
    queryFn: async () => {
      const { count } = await getSupabase().rpc('filtered_leads', { p_workspace: workspace.id, p_filters: effective }, { count: 'exact', head: true });
      return count ?? 0;
    },
  });

  async function add() {
    setBusy(true);
    const { data, error } = await getSupabase().rpc('campaign_add_recipients', { p_campaign: campaignId, p_filters: effective });
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    toast.success(`${formatNumber(data as number)} leads added`);
    qc.invalidateQueries({ queryKey: qk.campaign(campaignId) });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" title="Add leads to this campaign" description="Leads already in this or another active campaign, opted out or without WhatsApp are skipped automatically.">
        <DialogBody className="space-y-4">
          <FilterBar filters={filters} onChange={setFilters} />
          <div className="rounded-lg bg-primary-soft px-4 py-3 text-[13.5px]">
            <b className="tabular text-primary">{formatNumber(count.data ?? 0)}</b> new leads will be added
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={add} loading={busy} disabled={!count.data}>
            Add {formatNumber(count.data ?? 0)} leads
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
