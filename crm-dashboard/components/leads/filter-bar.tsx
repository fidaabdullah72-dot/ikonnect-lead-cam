'use client';

import * as React from 'react';
import { Bookmark, Building2, Filter, Flame, Flag, Globe, ListChecks, MapPin, Megaphone, Phone, Search, SlidersHorizontal, Tag as TagIcon, Target, Trash2, UserPlus, UserRound, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LEAD_SOURCES, SOURCE_LABELS, countryName, phoneCallingCodes, type LeadFilters, type SavedView } from '@batsols/shared';
import { WhatsAppIcon } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu';
import { MultiSelect } from '@/components/ui/multi-select';
import { useLeadFacets, useMembers, useStages } from '@/lib/queries';
import { useLeadLists } from '@/lib/lists';
import { useCampaigns } from '@/lib/campaigns';
import { getSupabase } from '@/lib/supabase/client';
import { useWorkspace } from '@/lib/workspace';
import { cn, errorMessage } from '@/lib/utils';

const WEBSITE_OPTIONS: Array<{ value: NonNullable<LeadFilters['website']>; label: string }> = [
  { value: 'site', label: 'Has a real website' },
  { value: 'no_site', label: 'No real website' },
  { value: 'none', label: 'No website at all' },
  { value: 'social', label: 'Only a social media page' },
  { value: 'invalid', label: 'Broken / invalid website' },
];

export function countActiveFilters(f: LeadFilters) {
  return Object.entries(f).filter(([k, v]) => k !== 'q' && v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length) && !(k === 'unassigned' && !v)).length;
}

export function FilterBar({
  filters,
  onChange,
  hide = [],
}: {
  filters: LeadFilters;
  onChange: (f: LeadFilters) => void;
  hide?: Array<keyof LeadFilters>;
}) {
  const { stages } = useStages();
  const { members } = useMembers();
  const facets = useLeadFacets();
  const [q, setQ] = React.useState(filters.q ?? '');
  const set = (patch: Partial<LeadFilters>) => onChange({ ...filters, ...patch });

  // Debounce search typing.
  React.useEffect(() => {
    const t = setTimeout(() => {
      if ((filters.q ?? '') !== q) onChange({ ...filters, q });
    }, 250);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => setQ(filters.q ?? ''), [filters.q]);

  const active = countActiveFilters(filters);
  // Phones: the filter chips fold away behind a "Filters" button (desktop shows them all).
  const [open, setOpen] = React.useState(false);
  const ownerValue = [...(filters.owner_ids ?? []), ...(filters.unassigned ? ['__none'] : [])];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex w-full items-center gap-2 sm:contents">
        <Input
          className="min-w-0 flex-1 sm:w-72 sm:flex-none"
        inputSize="sm"
        leading={<Search />}
        trailing={
          q ? (
            <button onClick={() => setQ('')} aria-label="Clear search" className="hover:text-foreground">
              <X />
            </button>
          ) : undefined
        }
        placeholder="Search name, phone, website, city…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
        <Button size="sm" variant={active ? 'primary' : 'secondary'} className="shrink-0 sm:hidden" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <SlidersHorizontal /> Filters{active ? ` (${active})` : ''}
        </Button>
      </div>
      <div className={cn(open ? 'flex w-full flex-wrap items-center gap-2' : 'hidden', 'sm:contents')}>
      {!hide.includes('stage_ids') && (
        <MultiSelect
          label="Stage"
          icon={<Target />}
          options={stages.map((s) => ({ value: s.id, label: s.name, color: s.color }))}
          value={filters.stage_ids ?? []}
          onChange={(v) => set({ stage_ids: v })}
        />
      )}
      <MultiSelect
        label="City"
        icon={<MapPin />}
        options={(facets.data?.cities ?? []).map((c) => ({ value: c.value, label: c.value, count: c.count }))}
        value={filters.cities ?? []}
        onChange={(v) => set({ cities: v })}
        emptyText="No cities yet"
      />
      <MultiSelect
        label="Country"
        icon={<Flag />}
        options={(facets.data?.countries ?? []).map((c) => ({ value: c.value, label: countryName(c.value), count: c.count }))}
        value={filters.countries ?? []}
        onChange={(v) => set({ countries: v })}
        emptyText="No countries yet"
      />
      <MultiSelect
        label="Phone code"
        icon={<Phone />}
        options={phoneCallingCodes().map((c) => ({ value: c.code, label: c.label }))}
        value={filters.phone_codes ?? []}
        onChange={(v) => set({ phone_codes: v })}
        placeholder="Search +92, Pakistan…"
      />
      <MultiSelect
        label="Website"
        icon={<Globe />}
        single
        options={WEBSITE_OPTIONS}
        value={filters.website ? [filters.website] : []}
        onChange={(v) => set({ website: (v[0] as LeadFilters['website']) || undefined })}
      />
      <MultiSelect
        label="Category"
        icon={<Building2 />}
        options={(facets.data?.categories ?? []).map((c) => ({ value: c.value, label: c.value, count: c.count }))}
        value={filters.categories ?? []}
        onChange={(v) => set({ categories: v })}
        emptyText="No categories yet"
      />
      <MultiSelect
        label="Tags"
        icon={<TagIcon />}
        options={(facets.data?.tags ?? []).map((c) => ({ value: c.value, label: `#${c.value}`, count: c.count }))}
        value={filters.tags ?? []}
        onChange={(v) => set({ tags: v })}
        emptyText="No tags yet"
      />
      {!hide.includes('owner_ids') && (
        <MultiSelect
          label="Owner"
          icon={<UserRound />}
          options={[{ value: '__none', label: 'Unassigned' }, ...members.map((m) => ({ value: m.user_id, label: m.profile.full_name || m.profile.email }))]}
          value={ownerValue}
          onChange={(v) => set({ owner_ids: v.filter((x) => x !== '__none'), unassigned: v.includes('__none') })}
        />
      )}
      <MultiSelect
        label="Added by"
        icon={<UserPlus />}
        options={members.map((m) => ({ value: m.user_id, label: m.profile.full_name || m.profile.email }))}
        value={filters.created_by_ids ?? []}
        onChange={(v) => set({ created_by_ids: v })}
      />
      <MultiSelect
        label="Campaigns"
        icon={<Megaphone />}
        single
        options={[
          { value: 'never', label: 'Never in a campaign' },
          { value: 'any', label: 'Already in a campaign' },
        ]}
        value={filters.campaign ? [filters.campaign] : []}
        onChange={(v) => set({ campaign: (v[0] as LeadFilters['campaign']) || undefined })}
      />
      <MultiSelect
        label="Quality"
        icon={<Flame />}
        options={[
          { value: 'hot', label: 'Hot (70+)' },
          { value: 'warm', label: 'Warm (40–69)' },
          { value: 'cold', label: 'Cold (under 40)' },
        ]}
        value={filters.tiers ?? []}
        onChange={(v) => set({ tiers: v as Array<'hot' | 'warm' | 'cold'> })}
      />
      {!hide.includes('list_ids') && <ListsFilter value={filters.list_ids ?? []} onChange={(v) => set({ list_ids: v })} />}
      <MultiSelect
        label="WhatsApp"
        icon={<WhatsAppIcon />}
        options={[
          { value: 'valid', label: 'On WhatsApp' },
          { value: 'unknown', label: 'Not checked' },
          { value: 'invalid', label: 'Not on WhatsApp' },
        ]}
        value={filters.wa_status ?? []}
        onChange={(v) => set({ wa_status: v as LeadFilters['wa_status'] })}
      />
      <MoreFilters filters={filters} onChange={onChange} />
      <SavedFilters filters={filters} onChange={onChange} />
      {active > 0 && (
        <Button variant="ghost" size="sm" onClick={() => onChange({ q: filters.q })}>
          <X /> Clear {active}
        </Button>
      )}
      </div>
    </div>
  );
}

function MoreFilters({ filters, onChange }: { filters: LeadFilters; onChange: (f: LeadFilters) => void }) {
  const set = (patch: Partial<LeadFilters>) => onChange({ ...filters, ...patch });
  const count = [
    filters.min_rating,
    filters.min_reviews,
    filters.contacted,
    filters.has_email,
    filters.sources?.length,
    filters.phone_types?.length,
    filters.has_phone,
    filters.name,
    filters.domain,
    filters.campaign_ids?.length,
    filters.exclude_campaign_ids?.length,
  ].filter(
    (v) => v !== undefined && v !== null && v !== 0,
  ).length;
  const bool = (v: boolean | undefined) => (v === undefined ? '' : v ? 'yes' : 'no');
  const parseBool = (v: string) => (v === '' ? undefined : v === 'yes');
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={count ? 'soft' : 'ghost'} size="sm">
          <SlidersHorizontal /> More{count ? ` · ${count}` : ''}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3" align="end">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <Filter className="size-3.5" /> More filters
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Business name">
            <Input inputSize="sm" value={filters.name ?? ''} onChange={(e) => set({ name: e.target.value || undefined })} placeholder="Contains…" />
          </Field>
          <Field label="Website / domain">
            <Input inputSize="sm" value={filters.domain ?? ''} onChange={(e) => set({ domain: e.target.value || undefined })} placeholder="example.com" />
          </Field>
          <CampaignPickers filters={filters} set={set} />
          <Field label="Min rating">
            <NativeSelect inputSize="sm" value={filters.min_rating ?? ''} onChange={(e) => set({ min_rating: e.target.value ? Number(e.target.value) : undefined })}>
              <option value="">Any</option>
              {[3, 3.5, 4, 4.5].map((r) => (
                <option key={r} value={r}>
                  {r}+ ★
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Min reviews">
            <Input inputSize="sm" type="number" min={0} value={filters.min_reviews ?? ''} onChange={(e) => set({ min_reviews: e.target.value ? Number(e.target.value) : undefined })} placeholder="Any" />
          </Field>
          <Field label="Outreach" className="col-span-2">
            <NativeSelect inputSize="sm" value={filters.contacted ?? ''} onChange={(e) => set({ contacted: (e.target.value || undefined) as LeadFilters['contacted'] })}>
              <option value="">Any</option>
              <option value="never">Never contacted</option>
              <option value="contacted">Contacted</option>
              <option value="not_replied">Contacted, no reply</option>
              <option value="replied">Replied</option>
            </NativeSelect>
          </Field>
          <Field label="Has phone">
            <NativeSelect inputSize="sm" value={bool(filters.has_phone)} onChange={(e) => set({ has_phone: parseBool(e.target.value) })}>
              <option value="">Any</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </NativeSelect>
          </Field>
          <Field label="Has email">
            <NativeSelect inputSize="sm" value={bool(filters.has_email)} onChange={(e) => set({ has_email: parseBool(e.target.value) })}>
              <option value="">Any</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </NativeSelect>
          </Field>
          <Field label="Phone type">
            <NativeSelect
              inputSize="sm"
              value={filters.phone_types?.[0] ?? ''}
              onChange={(e) => set({ phone_types: e.target.value ? [e.target.value as 'mobile' | 'landline' | 'unknown'] : [] })}
            >
              <option value="">Any</option>
              <option value="mobile">Mobile</option>
              <option value="landline">Landline</option>
              <option value="unknown">Unknown</option>
            </NativeSelect>
          </Field>
          <Field label="Source">
            <NativeSelect inputSize="sm" value={filters.sources?.[0] ?? ''} onChange={(e) => set({ sources: e.target.value ? [e.target.value as (typeof LEAD_SOURCES)[number]] : [] })}>
              <option value="">Any</option>
              {LEAD_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABELS[s]}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CampaignPickers({ filters, set }: { filters: LeadFilters; set: (patch: Partial<LeadFilters>) => void }) {
  const { data = [] } = useCampaigns();
  const options = data.map((c) => ({ value: c.id, label: c.name }));
  return (
    <>
      <Field label="In campaign" className="col-span-2">
        <MultiSelect label="Any campaign" icon={<Megaphone />} className="w-full" options={options} value={filters.campaign_ids ?? []} onChange={(v) => set({ campaign_ids: v })} emptyText="No campaigns yet" />
      </Field>
      <Field label="Not in campaign" className="col-span-2">
        <MultiSelect
          label="None excluded"
          icon={<Megaphone />}
          className="w-full"
          options={options}
          value={filters.exclude_campaign_ids ?? []}
          onChange={(v) => set({ exclude_campaign_ids: v })}
          emptyText="No campaigns yet"
        />
      </Field>
    </>
  );
}

/** Team-shared filter combinations (public.saved_views). */
function SavedFilters({ filters, onChange }: { filters: LeadFilters; onChange: (f: LeadFilters) => void }) {
  const { workspace, userId, can } = useWorkspace();
  const qc = useQueryClient();
  const key = ['saved-views', workspace.id];
  const [name, setName] = React.useState('');
  const views = useQuery({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await getSupabase().from('saved_views').select('*').eq('workspace_id', workspace.id).order('name');
      if (error) throw error;
      return data as SavedView[];
    },
  });
  const save = useMutation({
    mutationFn: async () => {
      const { q: _q, ...rest } = filters;
      const { error } = await getSupabase().from('saved_views').insert({ workspace_id: workspace.id, name: name.trim(), filters: rest, shared: true, created_by: userId });
      if (error) throw error;
    },
    onSuccess: () => {
      setName('');
      toast.success('Filters saved for the team');
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await getSupabase().from('saved_views').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const list = views.data ?? [];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm">
          <Bookmark /> Saved{list.length ? ` · ${list.length}` : ''}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3" align="end">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <Bookmark className="size-3.5" /> Saved filters
        </div>
        {list.length ? (
          <ul className="max-h-60 space-y-1 overflow-y-auto">
            {list.map((v) => (
              <li key={v.id} className="group flex items-center gap-1">
                <button type="button" onClick={() => onChange({ q: filters.q, ...v.filters })} className="flex-1 truncate rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2">
                  {v.name}
                </button>
                {(v.created_by === userId || can.admin) && (
                  <button type="button" onClick={() => remove.mutate(v.id)} aria-label={`Delete ${v.name}`} className="rounded p-1 text-subtle opacity-0 hover:text-danger group-hover:opacity-100">
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-subtle">Save a filter combination you use often — the whole team can reuse it.</p>
        )}
        <form
          className="flex gap-2 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <Input inputSize="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name these filters…" maxLength={60} aria-label="Saved filter name" />
          <Button size="sm" type="submit" disabled={!name.trim() || countActiveFilters(filters) === 0} loading={save.isPending}>
            Save
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function ListsFilter({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { data = [] } = useLeadLists();
  if (!data.length) return null;
  return <MultiSelect label="List" icon={<ListChecks />} options={data.map((l) => ({ value: l.id, label: l.name, color: l.color, count: l.count }))} value={value} onChange={onChange} />;
}
