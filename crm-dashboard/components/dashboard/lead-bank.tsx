'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Database, Globe, MapPin, Megaphone, Sparkles, Users } from 'lucide-react';
import { countryName, type LeadInventory } from '@batsols/shared';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/feedback';
import { StatCard } from '@/components/ui/layout';
import { getSupabase } from '@/lib/supabase/client';
import { useMembers } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { formatCompact, formatNumber, timeAgo } from '@/lib/utils';

/** The team's shared lead inventory: what's in it, who added it, and the latest searches. */
export function LeadBank() {
  const { workspace, can } = useWorkspace();
  const { byId } = useMembers();
  const { data } = useQuery({
    queryKey: ['lead-inventory', workspace.id],
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('lead_inventory', { p_workspace: workspace.id });
      if (error) throw error;
      return data as LeadInventory;
    },
    refetchInterval: 60_000,
  });
  const name = (id: string | null) => (id ? byId.get(id)?.profile.full_name || byId.get(id)?.profile.email || 'Former member' : 'Someone');

  if (!data) return <Skeleton className="mb-5 h-56 rounded-xl" />;
  const t = data.totals;
  return (
    <Card className="mb-5">
      <CardHeader title="Team lead bank" description="One shared inventory — every lead anyone on the team finds lands here once." />
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatCard label="Total leads" value={formatCompact(t.total)} hint={`${formatNumber(t.scraped)} from Google Maps`} icon={<Database />} />
          <StatCard label="New" value={formatNumber(t.new_7d)} hint={`${formatNumber(t.new_24h)} in the last 24 h`} icon={<Sparkles />} accent="success" />
          <StatCard label="Available for campaigns" value={formatCompact(t.available)} hint="Have a phone, never in a campaign" icon={<Users />} accent="info" />
          <StatCard label="In campaigns" value={formatCompact(t.in_campaigns)} hint={`${formatNumber(t.contacted)} contacted · ${formatNumber(t.replied)} replied`} icon={<Megaphone />} accent="whatsapp" />
          <StatCard label="No real website" value={formatCompact(t.without_site)} hint={`${formatNumber(t.with_site)} have one`} icon={<Globe />} accent="warning" />
          <StatCard
            label="Countries"
            value={formatNumber(t.countries)}
            hint={data.by_country.slice(0, 3).map((c) => `${countryName(c.code)} ${formatCompact(c.count)}`).join(' · ') || '—'}
            icon={<MapPin />}
          />
        </div>
        <div className={can.scrape ? 'grid gap-5 lg:grid-cols-2' : undefined}>
          <div>
            <div className="mb-2 text-[13px] font-semibold">Who added leads</div>
            {data.by_member.length ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {data.by_member.slice(0, 8).map((m) => (
                  <li key={m.user_id} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                    <span className="truncate">{name(m.user_id)}</span>
                    <span className="shrink-0 text-muted">
                      <span className="tabular font-medium text-foreground">{formatNumber(m.count)}</span> leads
                      {m.new_7d > 0 && <span className="text-success"> · +{formatNumber(m.new_7d)} this week</span>}
                      <span className="text-subtle"> · {timeAgo(m.last_added)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-subtle">No leads yet.</p>
            )}
          </div>
          {can.scrape && (
          <div>
            <div className="mb-2 flex items-center justify-between text-[13px] font-semibold">
              Recent lead searches
              <Link href="/scraper" className="text-xs font-medium text-primary hover:underline">
                All searches
              </Link>
            </div>
            {data.recent_jobs.length ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {data.recent_jobs.slice(0, 6).map((j) => (
                  <li key={j.id}>
                    <Link href={`/scraper/${j.id}`} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px] hover:bg-surface-2">
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{j.name}</span>
                        <span className="block truncate text-xs text-subtle">
                          {name(j.created_by)}
                          {j.country ? ` · ${countryName(j.country)}` : ''} · {timeAgo(j.created_at)}
                        </span>
                      </span>
                      <span className="shrink-0 text-right text-xs text-muted">
                        {j.status === 'running' || j.status === 'queued' ? (
                          <span className="text-info">{j.status === 'running' ? 'Running…' : 'Queued'}</span>
                        ) : (
                          <>
                            <span className="font-medium text-success">+{formatNumber(j.inserted)} new</span>
                            {j.duplicates > 0 && <span className="block">{formatNumber(j.duplicates)} already in the bank</span>}
                          </>
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-subtle">No lead searches yet.</p>
            )}
          </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
