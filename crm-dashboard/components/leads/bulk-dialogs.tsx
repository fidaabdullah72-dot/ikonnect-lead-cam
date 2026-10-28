'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { SAFE_CHECKS_PER_DAY, type LeadFilters } from '@batsols/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Callout } from '@/components/ui/feedback';
import { Field, NativeSelect } from '@/components/ui/input';
import { TagInput } from '@/components/ui/multi-select';
import { getSupabase } from '@/lib/supabase/client';
import { cleanFilters } from '@/lib/leads';
import { useLeadFacets, useUsableAccounts } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { errorMessage, formatNumber } from '@/lib/utils';

export type Selection = { ids: string[] | null; filters: LeadFilters; count: number };

/** Stash a selection so the campaign builder can pick it up. */
export function useStartCampaignWith() {
  const router = useRouter();
  return (sel: Selection) => {
    try {
      sessionStorage.setItem('bs:campaign-audience', JSON.stringify({ ids: sel.ids, filters: cleanFilters(sel.filters), count: sel.count }));
    } catch {
      // Storage unavailable: the builder simply starts empty.
    }
    router.push('/campaigns/new?from=leads');
  };
}

export function TagsDialog({
  open,
  onOpenChange,
  mode,
  count,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mode: 'add' | 'remove';
  count: number;
  onApply: (tags: string[]) => Promise<void>;
}) {
  const facets = useLeadFacets();
  const [tags, setTags] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) setTags([]);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" title={mode === 'add' ? 'Add tags' : 'Remove tags'} description={`${formatNumber(count)} leads selected`}>
        <DialogBody>
          <TagInput value={tags} onChange={setTags} suggestions={facets.data?.tags.map((t) => t.value)} placeholder="Type a tag and press Enter" />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!tags.length}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await onApply(tags);
              setBusy(false);
              onOpenChange(false);
            }}
          >
            {mode === 'add' ? 'Add tags' : 'Remove tags'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Safe mode: one number checks at most this many a day (the engine enforces it too). */
const MAX_VERIFY = SAFE_CHECKS_PER_DAY;

/** Queue an engine job that checks which numbers are registered on WhatsApp. */
export function VerifyDialog({ open, onOpenChange, selection }: { open: boolean; onOpenChange: (o: boolean) => void; selection: Selection }) {
  const { workspace, userId } = useWorkspace();
  const { connected } = useUsableAccounts();
  const [accountId, setAccountId] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open && connected[0]) setAccountId((a) => a || connected[0]!.id);
  }, [open, connected]);

  async function start() {
    setBusy(true);
    try {
      let ids = selection.ids;
      if (!ids) {
        const { data, error } = await getSupabase()
          .rpc('filtered_leads', { p_workspace: workspace.id, p_filters: { ...cleanFilters(selection.filters), has_phone: true, wa_status: ['unknown'] } })
          .select('id')
          .limit(MAX_VERIFY);
        if (error) throw error;
        ids = (data ?? []).map((r) => (r as { id: string }).id);
      }
      const { error } = await getSupabase()
        .from('engine_jobs')
        .insert({ workspace_id: workspace.id, type: 'verify_whatsapp', payload: { lead_ids: ids.slice(0, MAX_VERIFY), account_id: accountId }, created_by: userId });
      if (error) throw error;
      toast.success(`Checking ${formatNumber(Math.min(ids.length, MAX_VERIFY))} numbers on WhatsApp`, { description: 'Results appear in the WhatsApp column as they come in.' });
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" title="Verify WhatsApp numbers" description="Find out which leads actually use WhatsApp before you message them.">
        <DialogBody className="space-y-4">
          {connected.length === 0 ? (
            <Callout tone="warning" title="No connected number">
              Connect a WhatsApp number first. The check runs through one of your numbers.
            </Callout>
          ) : (
            <>
              <Field label="Check using" hint="The check is a lookup only; no message is sent.">
                <NativeSelect value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  {connected.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Callout tone="info">
                Up to {formatNumber(Math.min(selection.count, MAX_VERIFY))} unchecked leads are looked up, one every 20–40 seconds. To protect your
                number from a ban, each WhatsApp number checks at most {formatNumber(SAFE_CHECKS_PER_DAY)} a day — run it again tomorrow for
                more, or use a different number. Most campaigns don’t need this check at all.
              </Callout>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={start} loading={busy} disabled={!accountId}>
            <ShieldCheck /> Start check
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
