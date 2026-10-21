'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { LeadList } from '@batsols/shared';
import { getSupabase } from '@/lib/supabase/client';
import { useWorkspace } from '@/lib/workspace';

export type ListWithCount = LeadList & { count: number };

export function useLeadLists() {
  const { workspace } = useWorkspace();
  return useQuery({
    queryKey: ['lead-lists', workspace.id],
    queryFn: async () => {
      const sb = getSupabase();
      const { data, error } = await sb.from('lead_lists').select('*, lead_list_items(count)').eq('workspace_id', workspace.id).order('name');
      if (error) throw error;
      return (data as unknown as Array<LeadList & { lead_list_items: Array<{ count: number }> }>).map((l) => ({
        ...l,
        count: l.lead_list_items?.[0]?.count ?? 0,
      })) as ListWithCount[];
    },
  });
}

export function useInvalidateLists() {
  const qc = useQueryClient();
  const { workspace } = useWorkspace();
  return () => qc.invalidateQueries({ queryKey: ['lead-lists', workspace.id] });
}
