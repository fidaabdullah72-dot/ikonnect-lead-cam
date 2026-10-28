'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { Campaign, CampaignEvent, CampaignRecipient, CampaignSenderRow, CampaignStats, CampaignStep, Lead, LeadFilters } from '@batsols/shared';
import { getSupabase } from '@/lib/supabase/client';
import { qk, useRealtime } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';

export type CampaignWithStats = Campaign & { stats: CampaignStats | null };

export function useCampaigns() {
  const { workspace } = useWorkspace();
  const key = qk.campaigns(workspace.id);
  useRealtime('campaigns', `workspace_id=eq.${workspace.id}`, [key]);
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const sb = getSupabase();
      const [c, s] = await Promise.all([
        sb.from('campaigns').select('*').eq('workspace_id', workspace.id).order('created_at', { ascending: false }),
        sb.from('campaign_stats').select('*').eq('workspace_id', workspace.id),
      ]);
      if (c.error) throw c.error;
      if (s.error) throw s.error;
      const stats = new Map((s.data as CampaignStats[]).map((x) => [x.campaign_id, x]));
      return (c.data as Campaign[]).map((x) => ({ ...x, stats: stats.get(x.id) ?? null })) as CampaignWithStats[];
    },
    refetchInterval: 15_000,
  });
}

export function useCampaign(id: string) {
  const key = qk.campaign(id);
  useRealtime('campaigns', `id=eq.${id}`, [key]);
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const sb = getSupabase();
      const [c, steps, stats] = await Promise.all([
        sb.from('campaigns').select('*').eq('id', id).maybeSingle(),
        sb.from('campaign_steps').select('*').eq('campaign_id', id).order('position'),
        sb.from('campaign_stats').select('*').eq('campaign_id', id).maybeSingle(),
      ]);
      if (c.error) throw c.error;
      if (!c.data) return null;
      return { campaign: c.data as Campaign, steps: (steps.data ?? []) as CampaignStep[], stats: (stats.data as CampaignStats | null) ?? null };
    },
    refetchInterval: 10_000,
  });
}

export function useCampaignEvents(id: string) {
  const key = ['campaign-events', id];
  useRealtime('campaign_events', `campaign_id=eq.${id}`, [key]);
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await getSupabase().from('campaign_events').select('*').eq('campaign_id', id).order('id', { ascending: false }).limit(200);
      if (error) throw error;
      return data as CampaignEvent[];
    },
  });
}

export type RecipientRow = CampaignRecipient & { lead: Pick<Lead, 'id' | 'business_name' | 'phone' | 'city' | 'category'> | null };

export function useRecipients(id: string, status: string, q: string, page: number, pageSize = 50) {
  return useQuery({
    queryKey: ['campaign-recipients', id, status, q, page],
    queryFn: async () => {
      let query = getSupabase()
        .from('campaign_recipients')
        .select('*, lead:leads!inner(id, business_name, phone, city, category)', { count: 'exact' })
        .eq('campaign_id', id)
        .order('updated_at', { ascending: false })
        .range(page * pageSize, page * pageSize + pageSize - 1);
      if (status !== 'all') {
        if (status === 'sent') query = query.gt('steps_sent', 0);
        else query = query.eq('status', status as CampaignRecipient['status']);
      }
      if (q.trim()) query = query.ilike('lead.business_name', `%${q.trim()}%`);
      const { data, error, count } = await query;
      if (error) throw error;
      return { rows: (data ?? []) as unknown as RecipientRow[], total: count ?? 0 };
    },
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
}

export function useVariantStats(id: string) {
  return useQuery({
    queryKey: ['variant-stats', id],
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('campaign_variant_stats', { p_campaign: id });
      if (error) throw error;
      return data as Array<{ step: number; variant_index: number; sent: number; delivered: number; read: number; replied: number }>;
    },
    refetchInterval: 30_000,
  });
}

export function useCampaignSenders(id: string) {
  const { workspace } = useWorkspace();
  return useQuery({
    queryKey: ['campaign-senders', id],
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('report_campaign_senders', {
        p_workspace: workspace.id,
        p_from: '2000-01-01T00:00:00Z',
        p_to: '2100-01-01T00:00:00Z',
        p_campaign: id,
      });
      if (error) throw error;
      return data as CampaignSenderRow[];
    },
    refetchInterval: 30_000,
  });
}

export const CAMPAIGN_STATUS: Record<Campaign['status'], { label: string; tone: 'success' | 'warning' | 'neutral' | 'info' | 'primary' | 'danger' }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  running: { label: 'Running', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  completed: { label: 'Completed', tone: 'primary' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

/** Quick picks for "how many leads" boxes. */
export const LEAD_LIMIT_PRESETS = [100, 200, 300, 500, 1000];

/**
 * Ids of the first `limit` leads matching `filters`, best-scored first (newest first on a tie) — the leads a
 * "send to N leads" campaign gets. Read in pages because the API returns at most 1,000 rows per request.
 */
export async function pickTopLeadIds(workspaceId: string, filters: LeadFilters, limit: number): Promise<string[]> {
  const page = 1000;
  const ids: string[] = [];
  while (ids.length < limit) {
    const from = ids.length;
    const to = Math.min(limit, from + page) - 1;
    const { data, error } = await getSupabase()
      .rpc('filtered_leads', { p_workspace: workspaceId, p_filters: filters })
      // The API can only sort by columns it returns.
      .select('id, score, created_at')
      .order('score', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, to);
    if (error) throw error;
    ids.push(...(data ?? []).map((r) => r.id));
    if ((data?.length ?? 0) < to - from + 1) break;
  }
  return ids;
}
