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
