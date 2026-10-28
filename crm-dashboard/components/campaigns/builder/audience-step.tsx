'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Layers, ListChecks, MousePointerClick, ShieldCheck, Users } from 'lucide-react';
import type { Lead, LeadFilters } from '@batsols/shared';
import { FilterBar } from '@/components/leads/filter-bar';
import { LeadPicker } from '@/components/campaigns/lead-picker';
import { ListPicker } from '@/components/lists/list-picker';
import { Card } from '@/components/ui/card';
import { SwitchRow } from '@/components/ui/controls';
import { Callout } from '@/components/ui/feedback';
import { NativeSelect } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Table, Td, Th, Tr } from '@/components/ui/layout';
import { PhoneText } from '@/components/leads/bits';
import { getSupabase } from '@/lib/supabase/client';
import { cleanFilters } from '@/lib/leads';
import { useWorkspace } from '@/lib/workspace';
import { cn, formatNumber } from '@/lib/utils';
import { LeadLimitField } from '@/components/campaigns/lead-limit';
import { audienceFilters, audienceLimit, effectiveFilters, type BuilderState } from './state';

export function useAudienceCount(audience: BuilderState['audience'], skipLandlines: boolean, excludeCampaignId?: string) {
  const { workspace } = useWorkspace();
  const filters = cleanFilters({ ...effectiveFilters(audience, skipLandlines), ...(excludeCampaignId ? { exclude_campaign_id: excludeCampaignId } : {}) });
  const raw = cleanFilters(audienceFilters(audience));
  const limit = audienceLimit(audience);
  return useQuery({
    queryKey: ['audience-count', workspace.id, filters, raw, limit],
    queryFn: async () => {
      const sb = getSupabase();
      const [eligible, matching, unknownWa] = await Promise.all([
        sb.rpc('filtered_leads', { p_workspace: workspace.id, p_filters: filters }, { count: 'exact', head: true }),
        sb.rpc('filtered_leads', { p_workspace: workspace.id, p_filters: raw }, { count: 'exact', head: true }),
        sb.rpc('filtered_leads', { p_workspace: workspace.id, p_filters: { ...filters, wa_status: ['unknown'] } }, { count: 'exact', head: true }),
      ]);
      if (eligible.error) throw eligible.error;
      const available = eligible.count ?? 0;
      // `eligible`: who will actually get it (capped by "how many leads"); `available`: everyone who could.
      return {
        eligible: limit ? Math.min(limit, available) : available,
        available,
        matching: matching.count ?? 0,
        unknownWa: limit ? Math.min(limit, unknownWa.count ?? 0) : (unknownWa.count ?? 0),
      };
    },
  });
}

export function AudienceStep({ state, set, campaignId }: { state: BuilderState; set: (fn: (s: BuilderState) => BuilderState) => void; campaignId?: string }) {
  const a = state.audience;
  const count = useAudienceCount(a, state.settings.skip_landlines, campaignId);
  const setA = (patch: Partial<BuilderState['audience']>) => set((s) => ({ ...s, audience: { ...s.audience, ...patch } }));
  const setF = (f: LeadFilters) => setA({ filters: f });

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          {
            mode: 'lists' as const,
            icon: ListChecks,
            title: a.list_ids.length ? `${formatNumber(a.list_ids.length)} lead list${a.list_ids.length === 1 ? '' : 's'}` : 'Lead lists',
            text: 'Message one or more of your lists, e.g. an imported CSV',
          },
          { mode: 'filters' as const, icon: Layers, title: 'Leads matching filters', text: 'Pick by country, city, category, website, campaign history, saved filters…' },
          {
            mode: 'selection' as const,
            icon: MousePointerClick,
            title: a.ids?.length ? `${formatNumber(a.ids.length)} hand-picked leads` : 'Hand-picked leads',
            text: 'Search and tick the exact leads to message',
          },
        ].map((o) => (
          <button
            key={o.mode}
            type="button"
            onClick={() => setA({ mode: o.mode, ...(o.mode === 'selection' && !a.ids ? { ids: [] } : {}) })}
            className={cn(
              'flex items-start gap-3 rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              a.mode === o.mode ? 'border-primary bg-primary-soft ring-1 ring-primary/30' : 'border-border bg-surface hover:border-border-strong',
            )}
          >
            <o.icon className={cn('mt-0.5 size-5', a.mode === o.mode ? 'text-primary' : 'text-subtle')} />
            <div>
              <div className="text-[14px] font-semibold">{o.title}</div>
              <div className="mt-0.5 text-[12.5px] text-muted">{o.text}</div>
            </div>
          </button>
        ))}
      </div>

      {a.mode === 'lists' && (
        <div className="space-y-3">
          <ListPicker selected={a.list_ids} onChange={(list_ids) => setA({ list_ids })} />
          <Card className="space-y-2 p-4">
            <div className="text-[13px] font-medium">
              Narrow down <span className="font-normal text-subtle">(optional) · only leads in the lists that also match these filters</span>
            </div>
            <FilterBar filters={a.filters} onChange={setF} hide={['list_ids']} />
          </Card>
        </div>
      )}
      {a.mode === 'filters' && (
        <Card className="space-y-3 p-4">
          <FilterBar filters={a.filters} onChange={setF} />
        </Card>
      )}
      {a.mode === 'selection' && <LeadPicker selected={a.ids ?? []} onChange={(ids) => setA({ ids })} base={{ sendable: true }} />}

      <Card className="divide-y divide-border px-4">
        {a.mode !== 'selection' && (
          <div className="flex flex-col gap-3 py-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="text-[13.5px] font-medium">How many leads</div>
              <div className="mt-0.5 text-[12.5px] text-muted">Message only this many of the matching leads — the best-scored first. “All” sends to everyone who matches.</div>
            </div>
            <LeadLimitField value={a.limit} onChange={(limit) => setA({ limit })} available={count.data?.available} />
          </div>
        )}
        <SwitchRow
          label="Skip leads already in another active campaign"
          description="Guarantees no business gets messages from two campaigns — or two teammates — at once."
          checked={a.skipActive}
          onCheckedChange={(v) => setA({ skipActive: v })}
        />
        <div className="flex items-start justify-between gap-6 py-3">
          <div>
            <div className="text-[13.5px] font-medium">Skip recently contacted leads</div>
            <div className="mt-0.5 text-[12.5px] text-muted">Avoid messaging someone again too soon.</div>
          </div>
          <NativeSelect inputSize="sm" className="w-56 shrink-0" value={a.skipContactedDays ?? 0} onChange={(e) => setA({ skipContactedDays: Number(e.target.value) || null })}>
            <option value={0}>Don’t skip</option>
            <option value={7}>Contacted in last 7 days</option>
            <option value={30}>Contacted in last 30 days</option>
            <option value={90}>Contacted in last 90 days</option>
            <option value={3650}>Ever contacted</option>
          </NativeSelect>
        </div>
        <SwitchRow
          label="Only numbers verified on WhatsApp"
          description="Use “Verify WhatsApp numbers” on the Leads page first. Otherwise numbers are checked right before sending."
          checked={a.onlyVerified}
          onCheckedChange={(v) => setA({ onlyVerified: v })}
        />
      </Card>

      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-primary-soft-border bg-primary-soft px-5 py-4">
        <Users className="size-6 text-primary" />
        <div className="flex-1">
          {count.isLoading ? (
            <span className="flex items-center gap-2 text-[14px]">
              <Spinner className="size-4" /> Counting…
            </span>
          ) : (
            <>
              <div className="text-[15px] font-semibold">
                <span className="tabular text-primary">{formatNumber(count.data?.eligible ?? 0)}</span> leads will receive this campaign
                {audienceLimit(a) && (count.data?.available ?? 0) > (count.data?.eligible ?? 0) && (
                  <span className="font-normal text-muted"> · first {formatNumber(count.data!.eligible)} of {formatNumber(count.data!.available)} by score</span>
                )}
              </div>
              <div className="text-[12.5px] text-muted">
                {formatNumber(count.data?.matching ?? 0)} match · {formatNumber((count.data?.matching ?? 0) - (count.data?.available ?? 0))} excluded (no phone, opted out, not on WhatsApp, landline or already in a campaign)
              </div>
            </>
          )}
        </div>
        {(count.data?.unknownWa ?? 0) > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <ShieldCheck className="size-3.5 text-success" /> {formatNumber(count.data!.unknownWa)} will be checked on WhatsApp before sending
          </div>
        )}
      </div>
      {count.data && count.data.eligible === 0 && (
        <Callout tone="warning">{a.mode === 'selection'
            ? 'Tick at least one lead above.'
            : a.mode === 'lists'
              ? a.list_ids.length
                ? 'Nobody in these lists can be messaged right now (no phone, opted out, already in a campaign or contacted recently). Check the options above.'
                : 'Pick at least one list above.'
              : 'No leads match yet. Loosen the filters, or add leads first.'}</Callout>
      )}
      {(count.data?.eligible ?? 0) > 0 && <AudiencePreview audience={a} skipLandlines={state.settings.skip_landlines} excludeCampaignId={campaignId} total={count.data!.eligible} />}
    </div>
  );
}

/** The first leads that will receive the campaign, so you can check the filters before launching. */
function AudiencePreview({ audience, skipLandlines, excludeCampaignId, total }: { audience: BuilderState['audience']; skipLandlines: boolean; excludeCampaignId?: string; total: number }) {
  const { workspace } = useWorkspace();
  const filters = cleanFilters({ ...effectiveFilters(audience, skipLandlines), ...(excludeCampaignId ? { exclude_campaign_id: excludeCampaignId } : {}) });
  const preview = useQuery({
    queryKey: ['audience-preview', workspace.id, filters],
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .rpc('filtered_leads', { p_workspace: workspace.id, p_filters: filters })
        .select('id, business_name, phone, city, country, category, website_domain, score, created_at')
        .order('score', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id')
        .limit(15);
      if (error) throw error;
      return data as Array<Pick<Lead, 'id' | 'business_name' | 'phone' | 'city' | 'country' | 'category' | 'website_domain'>>;
    },
  });
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-4 py-2.5 text-[13px] font-semibold">
        Preview <span className="font-normal text-muted">· first {Math.min(15, total)} of {formatNumber(total)}</span>
      </div>
      {preview.isLoading ? (
        <div className="flex justify-center p-6">
          <Spinner />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Business</Th>
                <Th>Phone</Th>
                <Th>Location</Th>
                <Th>Website</Th>
              </tr>
            </thead>
            <tbody>
              {(preview.data ?? []).map((l) => (
                <Tr key={l.id}>
                  <Td className="max-w-[240px]">
                    <div className="truncate font-medium">{l.business_name}</div>
                    {l.category && <div className="truncate text-xs text-subtle">{l.category}</div>}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <PhoneText phone={l.phone} />
                  </Td>
                  <Td className="whitespace-nowrap text-muted">{[l.city, l.country].filter(Boolean).join(' · ') || '—'}</Td>
                  <Td className="max-w-[180px] truncate text-muted">{l.website_domain ?? <span className="text-warning/90">none</span>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </Card>
  );
}
