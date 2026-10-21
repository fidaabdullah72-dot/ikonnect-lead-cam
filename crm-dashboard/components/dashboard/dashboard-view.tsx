'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Circle, FileText, Inbox, MapPin, MessageCircle, Send, Smartphone, Sparkles, Target, Trophy, UserPlus, Users } from 'lucide-react';
import type { DashboardOverview } from '@batsols/shared';
import { Page } from '@/components/shell/app-shell';
import { BarList, DailyColumns, Legend } from '@/components/charts/charts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Segmented } from '@/components/ui/controls';
import { Skeleton } from '@/components/ui/feedback';
import { StatCard } from '@/components/ui/layout';
import { LeadBank } from './lead-bank';
import { getSupabase } from '@/lib/supabase/client';
import { qk, useAccounts } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, formatCompact, formatMoney, formatNumber, formatPercent } from '@/lib/utils';

export function DashboardView() {
  const { workspace, profile, can, userId } = useWorkspace();
  const { accounts } = useAccounts();
  const [days, setDays] = React.useState(14);
  const { data: d, isLoading } = useQuery({
    queryKey: qk.dashboard(workspace.id, days),
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('dashboard_overview', { p_workspace: workspace.id, p_days: days });
      if (error) throw error;
      return data as DashboardOverview;
    },
    refetchInterval: 60_000,
  });
  const extras = useQuery({
    queryKey: ['dashboard-extras', workspace.id, userId],
    queryFn: async () => {
      const sb = getSupabase();
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      const [tasks, unread, templates, campaigns, members] = await Promise.all([
        sb.from('tasks').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('assignee_id', userId).is('completed_at', null).lte('due_at', end.toISOString()),
        sb.from('conversations').select('unread_count').eq('workspace_id', workspace.id).gt('unread_count', 0).limit(1000),
        sb.from('message_templates').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id),
        sb.from('campaigns').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id),
        sb.from('workspace_members').select('user_id', { count: 'exact', head: true }).eq('workspace_id', workspace.id),
      ]);
      return {
        tasksDue: tasks.count ?? 0,
        unread: (unread.data ?? []).reduce((s, c) => s + c.unread_count, 0),
        templates: templates.count ?? 0,
        campaigns: campaigns.count ?? 0,
        members: members.count ?? 0,
      };
    },
  });

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const m = d?.messages;
  const series = (d?.series ?? []).map((s) => ({ day: s.day, read: s.read, delivered: Math.max(0, s.delivered - s.read), sent: Math.max(0, s.sent - s.delivered), replies: s.replies, leads: s.leads }));
  const connected = accounts.filter((a) => a.status === 'connected').length;

  const checklist = [
    { done: accounts.length > 0, label: 'Connect a WhatsApp number', href: '/whatsapp?connect=1', icon: Smartphone },
    { done: (d?.leads.total ?? 0) > 0, label: can.scrape ? 'Find or import leads' : 'Import or add leads', href: can.scrape ? '/scraper?new=1' : '/leads', icon: MapPin },
    { done: (extras.data?.templates ?? 0) > 0, label: 'Write a message template', href: '/templates', icon: FileText },
    { done: (extras.data?.campaigns ?? 0) > 0, label: 'Launch your first campaign', href: '/campaigns/new', icon: Send },
    ...(can.admin ? [{ done: (extras.data?.members ?? 0) > 1, label: 'Add your team', href: '/settings/team?invite=1', icon: UserPlus }] : []),
  ];
  const remaining = checklist.filter((c) => !c.done).length;

  return (
    <Page wide>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.025em]">
            {greeting}, {profile.full_name.split(' ')[0] || 'there'}
          </h1>
          <p className="mt-1 text-[13.5px] text-muted">
            {can.admin ? `Here’s how ${workspace.name} is doing.` : 'Here’s your outreach at a glance.'}
            {extras.data && (extras.data.unread || extras.data.tasksDue) ? (
              <>
                {' '}You have{' '}
                {extras.data.unread ? <Link href="/inbox?f=unread" className="font-medium text-primary hover:underline">{extras.data.unread} unread replies</Link> : null}
                {extras.data.unread && extras.data.tasksDue ? ' and ' : ''}
                {extras.data.tasksDue ? <Link href="/tasks" className="font-medium text-primary hover:underline">{extras.data.tasksDue} tasks due</Link> : null}.
              </>
            ) : null}
          </p>
        </div>
        <Segmented value={String(days)} onChange={(v) => setDays(Number(v))} options={[{ value: '7', label: '7 days' }, { value: '14', label: '14 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
      </div>

      {remaining > 0 && (
        <Card className="mb-5 overflow-hidden">
          <div className="flex flex-col gap-4 p-5 2xl:flex-row 2xl:items-center">
            <div className="flex shrink-0 items-center gap-3 2xl:w-52">
              <span className="flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary">
                <Sparkles className="size-5" />
              </span>
              <div>
                <div className="text-[14px] font-semibold">Get set up</div>
                <div className="text-xs text-muted">{checklist.length - remaining} of {checklist.length} done</div>
              </div>
            </div>
            <div className="grid flex-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
              {checklist.map((c) => (
                <Link key={c.label} href={c.href} className={cn('flex items-center gap-2 rounded-lg border px-3 py-2.5 text-[13px] transition-colors', c.done ? 'border-transparent bg-success-soft/50 text-muted line-through' : 'border-border hover:border-primary hover:bg-primary-soft/40')}>
                  {c.done ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : <Circle className="size-4 shrink-0 text-subtle" />}
                  <span className="leading-snug">{c.label}</span>
                </Link>
              ))}
            </div>
          </div>
        </Card>
      )}

      <LeadBank />

      {isLoading || !d ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Leads" value={formatCompact(d.leads.total)} hint={`+${formatNumber(d.leads.new_7d)} this week`} icon={<Users />} />
            <StatCard label="Sent today" value={formatNumber(m!.sent_today)} hint={`${formatNumber(m!.sent)} in ${days} days`} icon={<Send />} />
            <StatCard label="Reply rate" value={formatPercent(m!.leads_replied, m!.leads_messaged, 1)} hint={`${formatNumber(m!.leads_replied)} of ${formatNumber(m!.leads_messaged)} leads`} icon={<MessageCircle />} accent="success" />
            <StatCard label="Won" value={formatMoney(Number(d.won.value), workspace.settings.currency ?? 'USD')} hint={`${formatNumber(Number(d.won.count))} deals · ${formatMoney(Number(d.open_value), workspace.settings.currency ?? 'USD')} open`} icon={<Trophy />} accent="warning" />
          </div>

          <div className="mb-5 grid gap-5 xl:grid-cols-[1fr_360px]">
            <Card>
              <CardHeader
                title="Outreach"
                description={`${formatPercent(m!.delivered, m!.sent)} delivered · ${formatPercent(m!.read, m!.sent)} read`}
                action={<Legend items={[{ label: 'Read', color: 'var(--ord-4)' }, { label: 'Delivered', color: 'var(--ord-2)' }, { label: 'Sent', color: 'var(--ord-1)' }]} />}
              />
              <CardContent>
                <DailyColumns
                  data={series}
                  series={[
                    { key: 'read', label: 'Read', color: 'var(--ord-4)' },
                    { key: 'delivered', label: 'Delivered, not read', color: 'var(--ord-2)' },
                    { key: 'sent', label: 'Sent, not delivered', color: 'var(--ord-1)' },
                  ]}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader title="Replies" description={`${formatNumber(m!.received)} messages from ${formatNumber(m!.leads_replied)} leads`} action={<Button variant="ghost" size="xs" asChild><Link href="/inbox">Inbox <ArrowRight /></Link></Button>} />
              <CardContent>
                <DailyColumns data={series} series={[{ key: 'replies', label: 'Replies', color: 'var(--cat-3)' }]} stacked={false} height={200} />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <Card>
              <CardHeader title="Pipeline" action={<Button variant="ghost" size="xs" asChild><Link href="/pipeline">Open <ArrowRight /></Link></Button>} />
              <CardContent>
                <BarList items={d.stages.map((s) => ({ key: s.id, label: s.name, value: s.count, dot: s.color }))} empty="No leads yet" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader title="Top cities" />
              <CardContent>
                <BarList items={d.top_cities.map((c) => ({ label: c.name, value: c.count, key: c.name }))} empty="Add leads to see cities" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader title="Health" />
              <CardContent className="space-y-3 text-[13px]">
                {[
                  { icon: Smartphone, label: 'WhatsApp numbers online', value: `${connected} / ${accounts.length}`, href: '/whatsapp' },
                  { icon: Send, label: 'Active campaigns', value: String(d.campaigns_active), href: '/campaigns' },
                  { icon: Target, label: 'Leads on WhatsApp', value: formatPercent(d.leads.on_whatsapp, d.leads.total), href: '/leads' },
                  { icon: Users, label: 'Without website (web-design prospects)', value: formatNumber(d.leads.without_website), href: '/leads?view=no_website' },
                  { icon: Inbox, label: 'Opted out', value: formatNumber(d.leads.opted_out), href: '/leads?view=opted_out' },
                ].map((r) => (
                  <Link key={r.label} href={r.href} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                    <r.icon className="size-4 text-subtle" />
                    <span className="flex-1 text-muted">{r.label}</span>
                    <span className="font-semibold tabular">{r.value}</span>
                  </Link>
                ))}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </Page>
  );
}
