'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ResourceAccess, ResourceType, Team, TeamMember } from '@batsols/shared';
import { getSupabase } from '@/lib/supabase/client';
import { useWorkspace } from '@/lib/workspace';

export function useTeams() {
  const { workspace } = useWorkspace();
  const q = useQuery({
    queryKey: ['teams', workspace.id],
    queryFn: async () => {
      const sb = getSupabase();
      const [t, m] = await Promise.all([
        sb.from('teams').select('*').eq('workspace_id', workspace.id).order('name'),
        sb.from('team_members').select('*').eq('workspace_id', workspace.id),
      ]);
      if (t.error) throw t.error;
      if (m.error) throw m.error;
      return { teams: t.data as Team[], members: m.data as TeamMember[] };
    },
    staleTime: 60_000,
  });
  const teams = q.data?.teams ?? [];
  const memberships = q.data?.members ?? [];
  const teamsOf = React.useCallback((userId: string) => teams.filter((t) => memberships.some((m) => m.team_id === t.id && m.user_id === userId)), [teams, memberships]);
  const membersOf = React.useCallback((teamId: string) => memberships.filter((m) => m.team_id === teamId).map((m) => m.user_id), [memberships]);
  return { ...q, teams, memberships, teamsOf, membersOf };
}

export function useGrants(type: ResourceType, resourceId: string | null) {
  const { workspace } = useWorkspace();
  return useQuery({
    queryKey: ['grants', workspace.id, type, resourceId],
    enabled: !!resourceId,
    queryFn: async () => {
      const { data, error } = await getSupabase().from('resource_access').select('*').eq('resource_type', type).eq('resource_id', resourceId!);
      if (error) throw error;
      return data as ResourceAccess[];
    },
  });
}

/** All grants in the workspace that I can see (admins: all; members: mine). */
export function useAllGrants() {
  const { workspace } = useWorkspace();
  return useQuery({
    queryKey: ['grants', workspace.id, 'all'],
    queryFn: async () => {
      const { data, error } = await getSupabase().from('resource_access').select('*').eq('workspace_id', workspace.id);
      if (error) throw error;
      return data as ResourceAccess[];
    },
    staleTime: 30_000,
  });
}

/** Grants per resource of one type, e.g. who each campaign is assigned to (admins: everyone; members: their own). */
export function useAssignments(type: ResourceType) {
  const all = useAllGrants();
  const { userId } = useWorkspace();
  const { teams, memberships } = useTeams();
  const byResource = React.useMemo(() => {
    const map = new Map<string, ResourceAccess[]>();
    for (const g of all.data ?? []) if (g.resource_type === type) map.set(g.resource_id, [...(map.get(g.resource_id) ?? []), g]);
    return map;
  }, [all.data, type]);
  const myTeams = React.useMemo(() => new Set(memberships.filter((m) => m.user_id === userId).map((m) => m.team_id)), [memberships, userId]);
  /** Assigned to me directly or through one of my teams. */
  const isMine = React.useCallback((id: string) => (byResource.get(id) ?? []).some((g) => g.user_id === userId || (!!g.team_id && myTeams.has(g.team_id))), [byResource, userId, myTeams]);
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? 'Team';
  return { byResource, isMine, teamName };
}

export function useInvalidateGrants() {
  const qc = useQueryClient();
  const { workspace } = useWorkspace();
  return () => qc.invalidateQueries({ queryKey: ['grants', workspace.id] });
}

export const RESOURCE_LABELS: Record<ResourceType, string> = {
  lead_list: 'lead list',
  campaign: 'campaign',
  automation: 'automation',
  template: 'template',
  whatsapp_account: 'WhatsApp number',
};
