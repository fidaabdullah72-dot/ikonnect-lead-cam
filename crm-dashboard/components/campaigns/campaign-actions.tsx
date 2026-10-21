'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, MoreHorizontal, Pause, Pencil, Play, Share2, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { Campaign } from '@batsols/shared';
import { ShareDialog } from '@/components/access/share-dialog';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/feedback';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/menu';
import { getSupabase } from '@/lib/supabase/client';
import { qk } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { errorMessage } from '@/lib/utils';

export function useCampaignActions(c: Campaign) {
  const router = useRouter();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { workspace, userId, can } = useWorkspace();
  const canEdit = can.admin || (can.write && c.created_by === userId);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.campaigns(workspace.id) });
    qc.invalidateQueries({ queryKey: qk.campaign(c.id) });
  };
  const setStatus = async (status: Campaign['status'], msg: string) => {
    const { error } = await getSupabase()
      .from('campaigns')
      .update({ status, ...(status === 'running' ? { paused_reason: null } : {}) })
      .eq('id', c.id);
    if (error) return toast.error(errorMessage(error));
    toast.success(msg);
    refresh();
  };

  return {
    canEdit,
    pause: () => setStatus('paused', 'Campaign paused'),
    resume: () => setStatus('running', 'Campaign resumed'),
    cancel: async () => {
      if (!(await confirm({ title: `Stop “${c.name}” for good?`, description: 'Leads that haven’t been messaged yet won’t receive anything. Results so far are kept.', confirmLabel: 'Stop campaign', danger: true }))) return;
      await setStatus('cancelled', 'Campaign stopped');
    },
    remove: async () => {
      if (!(await confirm({ title: `Delete “${c.name}”?`, description: 'The campaign, its schedule and its statistics are deleted. Messages already sent stay in the inbox.', confirmLabel: 'Delete', danger: true }))) return;
      const { error } = await getSupabase().from('campaigns').delete().eq('id', c.id);
      if (error) return toast.error(errorMessage(error));
      toast.success('Campaign deleted');
      refresh();
      router.push('/campaigns');
    },
    duplicate: async () => {
      const sb = getSupabase();
      const { data: steps } = await sb.from('campaign_steps').select('*').eq('campaign_id', c.id).order('position');
      const { data, error } = await sb
        .from('campaigns')
        .insert({ workspace_id: workspace.id, name: `${c.name} (copy)`, description: c.description, audience: c.audience, account_ids: c.account_ids, settings: c.settings, created_by: userId, status: 'draft' })
        .select('id')
        .single();
      if (error) return toast.error(errorMessage(error));
      if (steps?.length) {
        await sb.from('campaign_steps').insert(steps.map((s) => ({ workspace_id: workspace.id, campaign_id: data.id, position: s.position, delay_hours: s.delay_hours, variants: s.variants })));
      }
      toast.success('Draft copy created');
      refresh();
      router.push(`/campaigns/${data.id}/edit`);
    },
  };
}

export function CampaignMenu({ campaign: c, onShare }: { campaign: Campaign; onShare?: () => void }) {
  const router = useRouter();
  const a = useCampaignActions(c);
  const { can } = useWorkspace();
  const [share, setShare] = React.useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Campaign actions" onClick={(e) => e.stopPropagation()}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-52" onClick={(e) => e.stopPropagation()}>
          {a.canEdit && c.status === 'running' && (
            <DropdownMenuItem onSelect={a.pause}>
              <Pause /> Pause
            </DropdownMenuItem>
          )}
          {a.canEdit && (c.status === 'paused' || c.status === 'draft') && (
            <DropdownMenuItem onSelect={a.resume}>
              <Play /> {c.status === 'draft' ? 'Start' : 'Resume'}
            </DropdownMenuItem>
          )}
          {a.canEdit && !['completed', 'cancelled'].includes(c.status) && (
            <DropdownMenuItem onSelect={() => router.push(`/campaigns/${c.id}/edit`)}>
              <Pencil /> Edit
            </DropdownMenuItem>
          )}
          {can.write && (
            <DropdownMenuItem onSelect={a.duplicate}>
              <Copy /> Duplicate
            </DropdownMenuItem>
          )}
          {a.canEdit && (
            <DropdownMenuItem onSelect={() => (onShare ? onShare() : setShare(true))}>
              <Share2 /> Share / assign
            </DropdownMenuItem>
          )}
          {a.canEdit && (
            <>
              <DropdownMenuSeparator />
              {['running', 'paused', 'scheduled'].includes(c.status) && (
                <DropdownMenuItem danger onSelect={a.cancel}>
                  <XCircle /> Stop campaign
                </DropdownMenuItem>
              )}
              <DropdownMenuItem danger onSelect={a.remove}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ShareDialog open={share} onOpenChange={setShare} type="campaign" resourceId={c.id} resourceName={c.name} />
    </>
  );
}
