'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, Clock, Download, MessageCircle, Pause, Pencil, Play, Plus, Search, Send, Split, UserRound, XCircle, AlertCircle, Info } from 'lucide-react';
import { toast } from 'sonner';
import Papa from 'papaparse';
import { formatPhone, nextWindowStart, normalizeCampaignSettings, type CampaignEvent } from '@batsols/shared';
import { Page } from '@/components/shell/app-shell';
import { Funnel } from '@/components/charts/charts';
import { LeadDrawer } from '@/components/leads/lead-drawer';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Progress, Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls';
import { Callout, EmptyState, Skeleton } from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { StatCard, Table, Td, Th, Tr } from '@/components/ui/layout';
import { PageSpinner } from '@/components/ui/spinner';
import { CampaignMenu, useCampaignActions } from './campaign-actions';
import { AddLeadsDialog } from './add-leads-dialog';
import { CAMPAIGN_STATUS, useCampaign, useCampaignEvents, useCampaignSenders, useRecipients, useVariantStats } from '@/lib/campaigns';
import { useAccounts, useMembers } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, downloadFile, fullDate, formatNumber, formatPercent, timeAgo } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase/client';

const EVENT_ICON: Record<CampaignEvent['type'], { icon: React.ElementType; cls: string }> = {
  sent: { icon: Send, cls: 'text-primary bg-primary-soft' },
  failed: { icon: AlertCircle, cls: 'text-danger bg-danger-soft' },
  skipped: { icon: XCircle, cls: 'text-subtle bg-surface-2' },
  replied: { icon: MessageCircle, cls: 'text-success bg-success-soft' },
  opted_out: { icon: XCircle, cls: 'text-warning bg-warning-soft' },
  started: { icon: Play, cls: 'text-success bg-success-soft' },
  paused: { icon: Pause, cls: 'text-warning bg-warning-soft' },
  resumed: { icon: Play, cls: 'text-success bg-success-soft' },
  completed: { icon: CheckCircle2, cls: 'text-primary bg-primary-soft' },
  waiting: { icon: Clock, cls: 'text-subtle bg-surface-2' },
  info: { icon: Info, cls: 'text-info bg-info-soft' },
};

const RECIPIENT_TONE: Record<string, 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'> = {
  pending: 'neutral',
  waiting: 'info',
  sending: 'primary',
  completed: 'primary',
  replied: 'success',
  failed: 'danger',
  skipped: 'neutral',
  cancelled: 'warning',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function CampaignDetail({ id }: { id: string }) {
  const router = useRouter();
  const { data, isLoading } = useCampaign(id);
  const { byId: members } = useMembers();
  const { byId: accounts } = useAccounts();
  const [leadId, setLeadId] = React.useState<string | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);

  if (isLoading) return <PageSpinner label="Loading campaign…" />;
  if (!data) return <Page><EmptyState title="Campaign not found" description="It may have been deleted, or it isn’t shared with you." action={<Button onClick={() => router.push('/campaigns')}>Back to campaigns</Button>} /></Page>;
  const { campaign: c, steps, stats } = data;
  return <Inner key={c.id} {...{ c, steps, stats, members, accounts, leadId, setLeadId, addOpen, setAddOpen }} />;
}

function Inner({ c, steps, stats, members, accounts, leadId, setLeadId, addOpen, setAddOpen }: {
  c: NonNullable<ReturnType<typeof useCampaign>['data']>['campaign'];
  steps: NonNullable<ReturnType<typeof useCampaign>['data']>['steps'];
  stats: NonNullable<ReturnType<typeof useCampaign>['data']>['stats'];
  members: ReturnType<typeof useMembers>['byId'];
  accounts: ReturnType<typeof useAccounts>['byId'];
  leadId: string | null;
  setLeadId: (v: string | null) => void;
  addOpen: boolean;
  setAddOpen: (v: boolean) => void;
}) {
  const { workspace } = useWorkspace();
  const actions = useCampaignActions(c);
  const settings = normalizeCampaignSettings(c.settings, workspace.timezone);
  const st = CAMPAIGN_STATUS[c.status];
  const total = stats?.total ?? 0;
  const sent = stats?.sent ?? 0;
  const remaining = (stats?.pending ?? 0) + (stats?.waiting ?? 0);
  const done = total - remaining;
  const owner = c.created_by ? members.get(c.created_by) : undefined;
  const note =
    c.status === 'running' && c.paused_reason === 'Outside sending hours'
      ? `Outside sending hours — resumes ${fullDate(nextWindowStart(new Date(), settings.window))}`
      : c.status === 'running'
        ? c.paused_reason
        : c.status === 'paused'
          ? c.paused_reason ?? 'Paused. Nothing is sent until you resume.'
          : null;

  async function exportResults() {
    const { data } = await getSupabase()
      .from('campaign_recipients')
      .select('status, steps_sent, delivery, last_sent_at, replied_at, error, lead:leads!inner(business_name, phone, city, category)')
      .eq('campaign_id', c.id)
      .limit(20000);
    const rows = ((data ?? []) as unknown as Array<{ status: string; steps_sent: number; delivery: string; last_sent_at: string | null; replied_at: string | null; error: string | null; lead: { business_name: string; phone: string; city: string | null; category: string | null } }>).map((r) => ({
      Business: r.lead.business_name,
      Phone: formatPhone(r.lead.phone),
      City: r.lead.city ?? '',
      Category: r.lead.category ?? '',
      Status: r.status,
      'Messages sent': r.steps_sent,
      Delivery: r.delivery,
      'Last sent': r.last_sent_at ?? '',
      Replied: r.replied_at ?? '',
      Error: r.error ?? '',
    }));
    downloadFile(`${c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-results.csv`, Papa.unparse(rows));
  }

  return (
    <Page wide>
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" asChild className="mt-1">
            <Link href="/campaigns" aria-label="Back to campaigns">
              <ArrowLeft />
            </Link>
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{c.name}</h1>
              <Badge tone={st.tone} dot pulse={c.status === 'running'}>{st.label}</Badge>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
              {owner && (
                <span className="inline-flex items-center gap-1.5">
                  <Avatar name={owner.profile.full_name} size="xs" /> {owner.profile.full_name}
                </span>
              )}
              <span>Created {timeAgo(c.created_at)}</span>
              {c.started_at && <span>· Started {fullDate(c.started_at)}</span>}
              {c.status === 'scheduled' && c.scheduled_at && <span>· Starts {fullDate(c.scheduled_at)}</span>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions.canEdit && c.status === 'running' && (
            <Button variant="secondary" onClick={actions.pause}>
              <Pause /> Pause
            </Button>
          )}
          {actions.canEdit && (c.status === 'paused' || c.status === 'draft') && (
            <Button variant="primary" onClick={actions.resume}>
              <Play /> {c.status === 'draft' ? 'Start' : 'Resume'}
            </Button>
          )}
          {actions.canEdit && !['completed', 'cancelled'].includes(c.status) && (
            <>
              <Button variant="secondary" onClick={() => setAddOpen(true)}>
                <Plus /> Add leads
              </Button>
              <Button variant="secondary" asChild>
                <Link href={`/campaigns/${c.id}/edit`}>
                  <Pencil /> Edit
                </Link>
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={exportResults}>
            <Download /> Export
          </Button>
          <CampaignMenu campaign={c} />
        </div>
      </div>

      {note && (
        <Callout tone={c.status === 'paused' ? 'warning' : 'info'} className="mb-5">
          {note}
        </Callout>
      )}

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Recipients" value={formatNumber(total)} hint={`${formatNumber(remaining)} still queued`} icon={<UserRound />} />
        <StatCard label="Messaged" value={formatNumber(sent)} hint={formatPercent(sent, total) + ' of recipients'} icon={<Send />} />
        <StatCard label="Delivered" value={formatPercent(stats?.delivered ?? 0, sent)} hint={`${formatNumber(stats?.delivered ?? 0)} leads`} icon={<CheckCircle2 />} accent="info" />
        <StatCard label="Read" value={formatPercent(stats?.read ?? 0, sent)} hint={`${formatNumber(stats?.read ?? 0)} leads`} icon={<Activity />} accent="primary" />
        <StatCard label="Replied" value={formatPercent(stats?.replied ?? 0, sent)} hint={`${formatNumber(stats?.replied ?? 0)} replies`} icon={<MessageCircle />} accent="success" />
      </div>

      <div className="mb-5 grid gap-5 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title="Funnel" description="From first message to reply" />
          <CardContent>
            <Funnel
              stages={[
                { label: 'Messaged', value: sent },
                { label: 'Delivered', value: stats?.delivered ?? 0 },
                { label: 'Read', value: stats?.read ?? 0 },
                { label: 'Replied', value: stats?.replied ?? 0 },
              ]}
            />
            <div className="mt-5">
              <div className="mb-1.5 flex justify-between text-xs text-muted">
                <span>Overall progress</span>
                <span className="tabular">
                  {formatNumber(done)} / {formatNumber(total)} finished
                </span>
              </div>
              <Progress value={total ? (done / total) * 100 : 0} tone={c.status === 'completed' ? 'success' : 'primary'} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader title="Setup" />
          <CardContent className="space-y-2.5 text-[13px]">
            {[
              ['Messages', `${steps.length} step${steps.length === 1 ? '' : 's'} · ${plural(steps.reduce((n, s) => n + s.variants.length, 0), 'variant')}`],
              ['Senders', c.account_ids.map((a) => accounts.get(a)?.label ?? 'Removed number').join(', ') || '—'],
              ['Pace', `${settings.min_delay_sec}–${settings.max_delay_sec}s · break ${settings.batch_pause_min}m / ${settings.batch_size}`],
              ['Hours', `${settings.window.start}–${settings.window.end} (${settings.window.timezone})`],
              ['Failed / skipped', `${formatNumber(stats?.failed ?? 0)} / ${formatNumber(stats?.skipped ?? 0)}`],
            ].map(([k, v]) => (
              <div key={k} className="flex gap-3">
                <span className="w-28 shrink-0 text-muted">{k}</span>
                <span className="min-w-0">{v}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="activity">
        <TabsList className="mb-4">
          <TabsTrigger value="activity">
            <Activity /> Live activity
          </TabsTrigger>
          <TabsTrigger value="recipients">
            <UserRound /> Recipients
          </TabsTrigger>
          <TabsTrigger value="variants">
            <Split /> A/B results
          </TabsTrigger>
          <TabsTrigger value="senders">
            <Send /> By sender
          </TabsTrigger>
        </TabsList>
        <TabsContent value="activity">
          <ActivityFeed id={c.id} onLead={setLeadId} />
        </TabsContent>
        <TabsContent value="recipients">
          <Recipients id={c.id} onLead={setLeadId} accounts={accounts} />
        </TabsContent>
        <TabsContent value="variants">
          <Variants id={c.id} steps={steps} />
        </TabsContent>
        <TabsContent value="senders">
          <Senders id={c.id} />
        </TabsContent>
      </Tabs>

      <LeadDrawer leadId={leadId} onClose={() => setLeadId(null)} />
      <AddLeadsDialog open={addOpen} onOpenChange={setAddOpen} campaignId={c.id} />
    </Page>
  );
}

function ActivityFeed({ id, onLead }: { id: string; onLead: (id: string) => void }) {
  const { data = [], isLoading } = useCampaignEvents(id);
  if (isLoading) return <Skeleton className="h-64 rounded-xl" />;
  if (!data.length) return <Card><EmptyState compact icon={<Activity />} title="No activity yet" description="Sends, replies and pauses appear here live." /></Card>;
  return (
    <Card className="max-h-[560px] overflow-y-auto">
      <ul className="divide-y divide-border">
        {data.map((e) => {
          const ic = EVENT_ICON[e.type];
          return (
            <li key={e.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg', ic.cls)}>
                <ic.icon className="size-3.5" />
              </span>
              <button className="min-w-0 flex-1 truncate text-left hover:text-primary disabled:hover:text-foreground" disabled={!e.lead_id} onClick={() => e.lead_id && onLead(e.lead_id)}>
                {e.message}
              </button>
              <span className="shrink-0 text-xs text-subtle">{timeAgo(e.created_at)}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Recipients({ id, onLead, accounts }: { id: string; onLead: (id: string) => void; accounts: ReturnType<typeof useAccounts>['byId'] }) {
  const [status, setStatus] = React.useState('all');
  const [q, setQ] = React.useState('');
  const [page, setPage] = React.useState(0);
  const { data, isLoading } = useRecipients(id, status, q, page);
  const qc = useQueryClient();
  const total = data?.total ?? 0;

  async function retryFailed() {
    const { error } = await getSupabase().from('campaign_recipients').update({ status: 'pending' }).eq('campaign_id', id).eq('status', 'failed');
    if (error) return toast.error(error.message);
    toast.success('Failed recipients re-queued');
    qc.invalidateQueries({ queryKey: ['campaign-recipients', id] });
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <Segmented
          size="sm"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(0);
          }}
          options={['all', 'pending', 'waiting', 'sent', 'replied', 'completed', 'failed', 'skipped'].map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) }))}
        />
        <Input inputSize="sm" className="w-56" leading={<Search />} placeholder="Search business…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        {status === 'failed' && total > 0 && (
          <Button size="sm" variant="secondary" onClick={retryFailed}>
            Retry failed
          </Button>
        )}
      </div>
      <div className="overflow-x-auto">
        <Table className="min-w-[860px]">
          <thead>
            <tr>
              <Th>Lead</Th>
              <Th>Status</Th>
              <Th>Progress</Th>
              <Th>Delivery</Th>
              <Th>Sender</Th>
              <Th>Last message</Th>
              <Th>Note</Th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <Td colSpan={7}>
                  <Skeleton className="h-5" />
                </Td>
              </tr>
            )}
            {data?.rows.map((r) => (
              <Tr key={r.id} className="cursor-pointer" onClick={() => r.lead && onLead(r.lead.id)}>
                <Td>
                  <div className="font-medium">{r.lead?.business_name}</div>
                  <div className="font-mono text-xs text-subtle">{formatPhone(r.lead?.phone)}</div>
                </Td>
                <Td>
                  <Badge tone={RECIPIENT_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
                </Td>
                <Td className="text-xs text-muted tabular">{r.steps_sent} sent</Td>
                <Td className="text-xs capitalize text-muted">{r.delivery === 'none' ? '—' : r.delivery}</Td>
                <Td className="text-xs text-muted">{r.account_id ? accounts.get(r.account_id)?.label ?? '—' : '—'}</Td>
                <Td className="text-xs text-muted">{r.last_sent_at ? timeAgo(r.last_sent_at) : r.next_send_at ? `next ${timeAgo(r.next_send_at)}` : '—'}</Td>
                <Td className="max-w-[220px] truncate text-xs text-danger">{r.error}</Td>
              </Tr>
            ))}
            {!isLoading && !data?.rows.length && (
              <tr>
                <td colSpan={7}>
                  <EmptyState compact title="No recipients here" />
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </div>
      {total > 50 && (
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2 text-xs text-muted">
          {page * 50 + 1}–{Math.min(total, page * 50 + 50)} of {formatNumber(total)}
          <Button size="icon-sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous">
            <ChevronLeft />
          </Button>
          <Button size="icon-sm" variant="ghost" disabled={(page + 1) * 50 >= total} onClick={() => setPage((p) => p + 1)} aria-label="Next">
            <ChevronRight />
          </Button>
        </div>
      )}
    </Card>
  );
}

function Variants({ id, steps }: { id: string; steps: NonNullable<ReturnType<typeof useCampaign>['data']>['steps'] }) {
  const { data = [] } = useVariantStats(id);
  return (
    <div className="space-y-4">
      {steps.map((s) => {
        const rows = s.variants.map((v, i) => {
          const r = data.find((d) => d.step === s.position && d.variant_index === i);
          return { v, i, sent: r?.sent ?? 0, read: r?.read ?? 0, replied: r?.replied ?? 0 };
        });
        const best = rows.length > 1 ? rows.reduce((b, r) => (r.sent >= 10 && r.replied / Math.max(1, r.sent) > b.replied / Math.max(1, b.sent) ? r : b), rows[0]!) : null;
        return (
          <Card key={s.id}>
            <CardHeader title={s.position === 0 ? 'First message' : `Follow-up ${s.position}`} description={s.position ? `Sent ${Math.round(s.delay_hours / 24)} day(s) after the previous one if no reply` : undefined} />
            <CardContent className="grid gap-3 md:grid-cols-2">
              {rows.map((r) => (
                <div key={r.i} className={cn('rounded-xl border p-3', best && best.i === r.i && best.sent >= 10 ? 'border-success/50 bg-success-soft/30' : 'border-border')}>
                  <div className="mb-2 flex items-center gap-2 text-xs">
                    <Badge tone="primary">Variant {'ABCDE'[r.i]}</Badge>
                    {best && best.i === r.i && best.sent >= 10 && <Badge tone="success">Leading</Badge>}
                    <span className="ml-auto tabular text-muted">
                      {formatNumber(r.sent)} sent · {formatPercent(r.read, r.sent)} read · <b className="text-foreground">{formatPercent(r.replied, r.sent)} replied</b>
                    </span>
                  </div>
                  <p className="line-clamp-4 whitespace-pre-wrap font-mono text-[12px] text-muted">{r.v.body}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function Senders({ id }: { id: string }) {
  const { data = [], isLoading } = useCampaignSenders(id);
  if (isLoading) return <Skeleton className="h-40 rounded-xl" />;
  if (!data.length) return <Card><EmptyState compact title="No messages sent yet" /></Card>;
  return (
    <Card className="overflow-hidden">
      <Table>
        <thead>
          <tr>
            <Th>Team member</Th>
            <Th>Number</Th>
            <Th className="text-right">Messages</Th>
            <Th className="text-right">Leads</Th>
            <Th className="text-right">Delivered</Th>
            <Th className="text-right">Read</Th>
            <Th className="text-right">Replied</Th>
            <Th className="text-right">Failed</Th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <Tr key={`${r.account_id}`}>
              <Td>
                <span className="flex items-center gap-2">
                  <Avatar name={r.full_name ?? '—'} size="xs" /> {r.full_name ?? '—'}
                </span>
              </Td>
              <Td className="text-muted">{r.account_label ?? '—'}</Td>
              <Td className="text-right tabular font-medium">{formatNumber(r.messages_sent)}</Td>
              <Td className="text-right tabular">{formatNumber(r.leads_contacted)}</Td>
              <Td className="text-right tabular">{formatPercent(r.delivered, r.messages_sent)}</Td>
              <Td className="text-right tabular">{formatPercent(r.read, r.messages_sent)}</Td>
              <Td className="text-right tabular text-success">{formatNumber(r.replied)}</Td>
              <Td className="text-right tabular text-danger">{formatNumber(r.failed)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
