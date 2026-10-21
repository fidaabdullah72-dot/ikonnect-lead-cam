'use client';

import * as React from 'react';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { EngineStatus, LeadFacets, PipelineStage, Profile, Role, WhatsappAccount } from '@batsols/shared';
import { getSupabase } from '@/lib/supabase/client';
import { useWorkspace } from '@/lib/workspace';

export const qk = {
  members: (ws: string) => ['members', ws] as const,
  stages: (ws: string) => ['stages', ws] as const,
  accounts: (ws: string) => ['accounts', ws] as const,
  facets: (ws: string) => ['facets', ws] as const,
  leads: (ws: string, params?: unknown) => (params === undefined ? (['leads', ws] as const) : (['leads', ws, params] as const)),
  lead: (id: string) => ['lead', id] as const,
  leadTimeline: (id: string) => ['lead-timeline', id] as const,
  engine: ['engine-status'] as const,
  notifications: (ws: string, user: string) => ['notifications', ws, user] as const,
  campaigns: (ws: string) => ['campaigns', ws] as const,
  campaign: (id: string) => ['campaign', id] as const,
  templates: (ws: string) => ['templates', ws] as const,
  scrapeJobs: (ws: string) => ['scrape-jobs', ws] as const,
  scrapeJob: (id: string) => ['scrape-job', id] as const,
  conversations: (ws: string) => ['conversations', ws] as const,
  messages: (conversationId: string) => ['messages', conversationId] as const,
  tasks: (ws: string) => ['tasks', ws] as const,
  dashboard: (ws: string, days: number) => ['dashboard', ws, days] as const,
  team: (ws: string, days: number) => ['team', ws, days] as const,
};

/** Wall-clock time that re-renders every `intervalMs` (keeps render pure). */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ------------------------------------------------------------------ realtime

/**
 * Subscribe to Postgres changes for a table (RLS applies) and invalidate the
 * given query keys whenever something changes.
 */
export function useRealtime(
  table: string,
  filter: string | null,
  keys: QueryKey[],
  onChange?: (payload: { eventType: string; new: Record<string, unknown>; old: Record<string, unknown> }) => void,
) {
  const qc = useQueryClient();
  const keysRef = React.useRef(keys);
  const cbRef = React.useRef(onChange);
  keysRef.current = keys;
  cbRef.current = onChange;

  React.useEffect(() => {
    if (filter === null) return;
    const supabase = getSupabase();
    const channel = supabase
      .channel(`rt:${table}:${filter}:${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) },
        (payload) => {
          for (const k of keysRef.current) qc.invalidateQueries({ queryKey: k });
          cbRef.current?.(payload as never);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [table, filter, qc]);
}

// ------------------------------------------------------------------ members

export interface Member {
  user_id: string;
  role: Role;
  created_at: string;
  profile: Profile;
}

export function useMembers() {
  const { workspace } = useWorkspace();
  const q = useQuery({
    queryKey: qk.members(workspace.id),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('workspace_members')
        .select('user_id, role, created_at, profile:profiles(*)')
        .eq('workspace_id', workspace.id)
        .order('created_at');
      if (error) throw error;
      return (data ?? []) as unknown as Member[];
    },
    staleTime: 5 * 60_000,
  });
  const byId = React.useMemo(() => new Map((q.data ?? []).map((m) => [m.user_id, m])), [q.data]);
  return { ...q, members: q.data ?? [], byId };
}

// ------------------------------------------------------------------ stages

export function useStages() {
  const { workspace } = useWorkspace();
  const q = useQuery({
    queryKey: qk.stages(workspace.id),
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('pipeline_stages')
        .select('*')
        .eq('workspace_id', workspace.id)
        .order('position');
      if (error) throw error;
      return data as PipelineStage[];
    },
    staleTime: 5 * 60_000,
  });
  const byId = React.useMemo(() => new Map((q.data ?? []).map((s) => [s.id, s])), [q.data]);
  return { ...q, stages: q.data ?? [], byId };
}

// ------------------------------------------------------------------ whatsapp accounts

export function useAccounts() {
  const { workspace } = useWorkspace();
  const key = qk.accounts(workspace.id);
  useRealtime('whatsapp_accounts', `workspace_id=eq.${workspace.id}`, [key]);
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from('whatsapp_accounts')
        .select('*')
        .eq('workspace_id', workspace.id)
        .order('created_at');
      if (error) throw error;
      return data as WhatsappAccount[];
    },
  });
  const byId = React.useMemo(() => new Map((q.data ?? []).map((a) => [a.id, a])), [q.data]);
  return { ...q, accounts: q.data ?? [], byId };
}

/** Numbers the current user may send from. */
export function useUsableAccounts() {
  const { userId, can } = useWorkspace();
  const { accounts, ...rest } = useAccounts();
  const usable = React.useMemo(
    () => accounts.filter((a) => can.write && (a.owner_id === userId || a.shared || can.admin)),
    [accounts, userId, can.write, can.admin],
  );
  return { ...rest, accounts: usable, connected: usable.filter((a) => a.status === 'connected') };
}

// ------------------------------------------------------------------ facets

export function useLeadFacets() {
  const { workspace } = useWorkspace();
  return useQuery({
    queryKey: qk.facets(workspace.id),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('lead_facets', { p_workspace: workspace.id });
      if (error) throw error;
      return data as LeadFacets;
    },
    staleTime: 60_000,
  });
}

// ------------------------------------------------------------------ engine

export function useEngineStatus() {
  const q = useQuery({
    queryKey: qk.engine,
    queryFn: async () => {
      const { data } = await getSupabase().from('engine_status').select('*').eq('id', 'main').maybeSingle();
      return (data as EngineStatus | null) ?? null;
    },
    refetchInterval: 30_000,
  });
  const now = useNow(15_000);
  const heartbeat = q.data?.heartbeat_at ? new Date(q.data.heartbeat_at).getTime() : 0;
  const online = heartbeat > 0 && now - heartbeat < 90_000;
  return { ...q, online, status: q.data };
}
