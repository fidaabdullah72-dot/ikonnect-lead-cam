'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { normalizePhone, type Activity, type Lead, type LeadFilters, type LeadNote, type Message, type Task } from '@batsols/shared';
import { getSupabase } from '@/lib/supabase/client';
import { qk } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { errorMessage } from '@/lib/utils';

export type SortKey = 'created_at' | 'business_name' | 'rating' | 'reviews_count' | 'last_contacted_at' | 'deal_value' | 'score';

export interface LeadsQueryParams {
  filters: LeadFilters;
  sort: { key: SortKey; asc: boolean };
  page: number;
  pageSize: number;
}

/** Drop empty values so query keys stay stable and the SQL sees only real filters. */
export function cleanFilters(f: LeadFilters): LeadFilters {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (k === 'unassigned' && v === false) continue;
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out as LeadFilters;
}

export function useLeadsList(params: LeadsQueryParams) {
  const { workspace } = useWorkspace();
  const filters = cleanFilters(params.filters);
  return useQuery({
    queryKey: qk.leads(workspace.id, { ...params, filters }),
    queryFn: async () => {
      const from = params.page * params.pageSize;
      const { data, error, count } = await getSupabase()
        .rpc('filtered_leads', { p_workspace: workspace.id, p_filters: filters }, { count: 'exact' })
        .select('*')
        .order(params.sort.key, { ascending: params.sort.asc, nullsFirst: false })
        .order('id')
        .range(from, from + params.pageSize - 1);
      if (error) throw error;
      return { rows: (data ?? []) as Lead[], total: count ?? 0 };
    },
    placeholderData: keepPreviousData,
  });
}

export function useLead(id: string | null) {
  return useQuery({
    queryKey: qk.lead(id ?? 'none'),
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await getSupabase().from('leads').select('*').eq('id', id!).maybeSingle();
      if (error) throw error;
      return data as Lead | null;
    },
  });
}

export type TimelineItem =
  | { kind: 'activity'; at: string; item: Activity }
  | { kind: 'note'; at: string; item: LeadNote }
  | { kind: 'message'; at: string; item: Message };

export function useLeadTimeline(leadId: string | null) {
  return useQuery({
    queryKey: qk.leadTimeline(leadId ?? 'none'),
    enabled: !!leadId,
    queryFn: async () => {
      const sb = getSupabase();
      const [a, n, m, t] = await Promise.all([
        sb.from('activities').select('*').eq('lead_id', leadId!).order('created_at', { ascending: false }).limit(100),
        sb.from('lead_notes').select('*').eq('lead_id', leadId!).order('created_at', { ascending: false }).limit(100),
        sb.from('messages').select('*').eq('lead_id', leadId!).order('created_at', { ascending: true }).limit(500),
        sb.from('tasks').select('*').eq('lead_id', leadId!).order('created_at', { ascending: false }),
      ]);
      const err = a.error ?? n.error ?? m.error ?? t.error;
      if (err) throw err;
      const timeline: TimelineItem[] = [
        ...(a.data ?? []).map((item) => ({ kind: 'activity' as const, at: item.created_at, item: item as Activity })),
        ...(n.data ?? []).map((item) => ({ kind: 'note' as const, at: item.created_at, item: item as LeadNote })),
        ...(m.data ?? []).map((item) => ({ kind: 'message' as const, at: item.created_at, item: item as Message })),
      ].sort((x, y) => y.at.localeCompare(x.at));
      return { timeline, messages: (m.data ?? []) as Message[], notes: (n.data ?? []) as LeadNote[], tasks: (t.data ?? []) as Task[] };
    },
  });
}

/** Invalidate everything that shows lead data. */
export function useInvalidateLeads() {
  const qc = useQueryClient();
  const { workspace } = useWorkspace();
  return (leadId?: string) => {
    qc.invalidateQueries({ queryKey: qk.leads(workspace.id) });
    qc.invalidateQueries({ queryKey: qk.facets(workspace.id) });
    qc.invalidateQueries({ queryKey: ['pipeline', workspace.id] });
    if (leadId) {
      qc.invalidateQueries({ queryKey: qk.lead(leadId) });
      qc.invalidateQueries({ queryKey: qk.leadTimeline(leadId) });
    }
  };
}

export function useUpdateLead() {
  const invalidate = useInvalidateLeads();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Lead> }) => {
      const { data, error } = await getSupabase().from('leads').update(patch).eq('id', id).select('*').single();
      if (error) throw error;
      return data as Lead;
    },
    onSuccess: (lead) => invalidate(lead.id),
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useBulkAction() {
  const invalidate = useInvalidateLeads();
  const { workspace } = useWorkspace();
  return useMutation({
    mutationFn: async (args: { action: string; ids?: string[] | null; filters?: LeadFilters | null; value?: unknown }) => {
      const { data, error } = await getSupabase().rpc('leads_bulk_action', {
        p_workspace: workspace.id,
        p_action: args.action,
        p_ids: args.ids ?? null,
        p_filters: args.ids ? null : cleanFilters(args.filters ?? {}),
        p_value: args.value ?? null,
      });
      if (error) throw error;
      return data as number;
    },
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export interface LeadInput {
  business_name: string;
  contact_name?: string;
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  city?: string;
  country?: string;
  category?: string;
  tags?: string[];
  stage_id?: string | null;
  owner_id?: string | null;
  deal_value?: number;
}

const blank = (v: string | undefined | null) => (v && v.trim() ? v.trim() : null);

export function normalizeWebsite(url: string | null | undefined) {
  const v = blank(url);
  if (!v) return null;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

/** Turn form input into a DB row (phone normalisation, blanks -> null). */
export function leadInputToRow(input: LeadInput, defaultCountry: string): Partial<Lead> {
  const phone = normalizePhone(input.phone, defaultCountry);
  if (input.phone?.trim() && !phone) throw new Error('That phone number looks incomplete.');
  return {
    business_name: input.business_name.trim(),
    contact_name: blank(input.contact_name),
    phone: phone?.digits ?? null,
    phone_raw: blank(input.phone),
    phone_type: phone?.type ?? 'unknown',
    email: blank(input.email)?.toLowerCase() ?? null,
    website: normalizeWebsite(input.website),
    address: blank(input.address),
    city: blank(input.city),
    country: blank(input.country) ?? phone?.country ?? null,
    category: blank(input.category),
    tags: input.tags ?? [],
    ...(input.stage_id !== undefined ? { stage_id: input.stage_id } : {}),
    ...(input.owner_id !== undefined ? { owner_id: input.owner_id } : {}),
    deal_value: Number.isFinite(input.deal_value) ? Math.max(0, input.deal_value ?? 0) : 0,
  };
}

export const LEAD_CSV_COLUMNS: Array<{ key: keyof Lead | 'stage' | 'owner'; label: string }> = [
  { key: 'business_name', label: 'Business name' },
  { key: 'contact_name', label: 'Contact name' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'website', label: 'Website' },
  { key: 'address', label: 'Address' },
  { key: 'city', label: 'City' },
  { key: 'country', label: 'Country' },
  { key: 'category', label: 'Category' },
  { key: 'rating', label: 'Rating' },
  { key: 'reviews_count', label: 'Reviews' },
  { key: 'stage', label: 'Stage' },
  { key: 'owner', label: 'Owner' },
  { key: 'tags', label: 'Tags' },
  { key: 'deal_value', label: 'Deal value' },
  { key: 'wa_status', label: 'WhatsApp' },
  { key: 'source', label: 'Source' },
  { key: 'google_maps_url', label: 'Google Maps' },
  { key: 'last_contacted_at', label: 'Last contacted' },
  { key: 'created_at', label: 'Created' },
];
