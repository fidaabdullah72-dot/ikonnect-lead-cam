'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { startOfDay, startOfMonth, subDays } from 'date-fns';
import { BarChart3, Download, MessageCircle, Send, Trophy, Users } from 'lucide-react';
import Papa from 'papaparse';
import type { CampaignSenderRow, DailyReportRow, MemberReportRow, TeamReportRow } from '@batsols/shared';
import { Page } from '@/components/shell/app-shell';
import { DailyColumns, Legend } from '@/components/charts/charts';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Segmented } from '@/components/ui/controls';
import { EmptyState, Skeleton } from '@/components/ui/feedback';
import { NativeSelect } from '@/components/ui/input';
import { PageHeader, StatCard, Table, Td, Th, Tr } from '@/components/ui/layout';
import { getSupabase } from '@/lib/supabase/client';
import { useWorkspace } from '@/lib/workspace';
import { downloadFile, formatMoney, formatNumber, formatPercent, timeAgo } from '@/lib/utils';

type Range = 'today' | '7d' | '30d' | '90d' | 'month';

function rangeDates(r: Range): { from: Date; to: Date } {
  const to = new Date(Date.now() + 60_000);
  const from = r === 'today' ? startOfDay(new Date()) : r === 'month' ? startOfMonth(new Date()) : startOfDay(subDays(new Date(), r === '7d' ? 6 : r === '30d' ? 29 : 89));
  return { from, to };
}

export function ReportsView() {
  const { workspace, can, role } = useWorkspace();
  const [range, setRange] = React.useState<Range>('30d');
  const [member, setMember] = React.useState('');
  const { from, to } = rangeDates(range);
  const args = { p_workspace: workspace.id, p_from: from.toISOString(), p_to: to.toISOString() };
  const key = [workspace.id, range];

  // Team totals are for admins and viewers; members get their own numbers only.
  const seesTeam = can.admin || role === 'viewer';
  const members = useQuery({ queryKey: ['report-members', ...key], queryFn: async () => ((await getSupabase().rpc('report_members', args)).data ?? []) as MemberReportRow[] });
  const teams = useQuery({ queryKey: ['report-teams', ...key], enabled: seesTeam, queryFn: async () => { const r = await getSupabase().rpc('report_teams', args); return (r.error ? [] : r.data) as TeamReportRow[]; } });
  const senders = useQuery({ queryKey: ['report-senders', ...key], queryFn: async () => ((await getSupabase().rpc('report_campaign_senders', { ...args, p_campaign: null })).data ?? []) as CampaignSenderRow[] });
  const daily = useQuery({ queryKey: ['report-daily', ...key], queryFn: async () => ((await getSupabase().rpc('report_daily', args)).data ?? []) as DailyReportRow[] });

  const rows = (members.data ?? []).filter((m) => !member || m.user_id === member);
  const total = rows.reduce((t, r) => ({ sent: t.sent + r.messages_sent, replies: t.replies + r.replies, contacted: t.contacted + r.leads_contacted, replied: t.replied + r.leads_replied, won: t.won + r.won, value: t.value + Number(r.won_value) }), { sent: 0, replies: 0, contacted: 0, replied: 0, won: 0, value: 0 });

  // Daily series (fill empty days).
  const days: Array<{ day: string; sent: number; replies: number }> = [];
  for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86400000)) {
    const k = d.toISOString().slice(0, 10);
    const hits = (daily.data ?? []).filter((x) => x.day === k && (!member || x.user_id === member));
    days.push({ day: k, sent: hits.reduce((s, x) => s + x.sent, 0), replies: hits.reduce((s, x) => s + x.replies, 0) });
  }
  const best = [...(members.data ?? [])].sort((a, b) => b.leads_replied - a.leads_replied)[0];

  function exportCsv() {
    downloadFile(
      `team-report-${range}.csv`,
      Papa.unparse(
        rows.map((r) => ({
          Member: r.full_name,
          Email: r.email,
          Role: r.role,
          Teams: r.teams.join(', '),
          'Messages sent': r.messages_sent,
          Delivered: r.delivered,
          Read: r.read,
          Failed: r.failed,
          'Replies received': r.replies,
          'Leads contacted': r.leads_contacted,
          'Leads replied': r.leads_replied,
          'Reply rate': formatPercent(r.leads_replied, r.leads_contacted, 1),
          'Leads owned': r.leads_owned,
          'Leads added': r.leads_added,
          'Campaigns created': r.campaigns_created,
          Meetings: r.meetings,
          Won: r.won,
          'Won value': r.won_value,
          'Numbers connected': `${r.numbers_connected}/${r.numbers}`,
        })),
      ),
    );
  }

  return (
    <Page wide>
      <PageHeader
        icon={<BarChart3 />}
        title={can.admin || can.owner ? 'Team reports' : 'My reports'}
        description={can.admin ? 'Who sent what, who got replies, and which campaigns work — per person, team and campaign.' : 'Your messages, replies and results.'}
        actions={
          <>
            <Segmented<Range>
              value={range}
              onChange={setRange}
              options={[
                { value: 'today', label: 'Today' },
                { value: '7d', label: '7 days' },
                { value: '30d', label: '30 days' },
                { value: 'month', label: 'This month' },
                { value: '90d', label: '90 days' },
              ]}
            />
            <Button variant="secondary" size="sm" onClick={exportCsv}>
              <Download /> Export
            </Button>
          </>
        }
      />
      {(members.data?.length ?? 0) > 1 && (
        <div className="mb-4 flex items-center gap-2">
          <NativeSelect inputSize="sm" className="w-56" value={member} onChange={(e) => setMember(e.target.value)}>
            <option value="">Whole team</option>
            {members.data?.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.full_name || m.email}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Messages sent" value={formatNumber(total.sent)} icon={<Send />} />
        <StatCard label="Leads contacted" value={formatNumber(total.contacted)} icon={<Users />} />
        <StatCard label="Replies" value={formatNumber(total.replies)} hint={`${formatNumber(total.replied)} leads replied`} icon={<MessageCircle />} accent="success" />
        <StatCard label="Reply rate" value={formatPercent(total.replied, total.contacted, 1)} icon={<MessageCircle />} accent="info" />
        <StatCard label="Won" value={formatNumber(total.won)} hint={formatMoney(total.value, workspace.settings.currency ?? 'USD')} icon={<Trophy />} accent="warning" />
      </div>

      <div className="mb-5 grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Messages sent per day" />
          <CardContent>{daily.isLoading ? <Skeleton className="h-60" /> : <DailyColumns data={days} series={[{ key: 'sent', label: 'Sent', color: 'var(--primary)' }]} stacked={false} />}</CardContent>
        </Card>
        <Card>
          <CardHeader title="Replies received per day" />
          <CardContent>{daily.isLoading ? <Skeleton className="h-60" /> : <DailyColumns data={days} series={[{ key: 'replies', label: 'Replies', color: 'var(--cat-3)' }]} stacked={false} />}</CardContent>
        </Card>
      </div>

      <Card className="mb-5 overflow-hidden">
        <CardHeader title="By team member" description={best && best.leads_replied > 0 ? `Top performer: ${best.full_name} with ${best.leads_replied} replying leads` : undefined} />
        {members.isLoading ? (
          <Skeleton className="m-5 h-40" />
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[1000px]">
              <thead>
                <tr>
                  <Th>Member</Th>
                  <Th className="text-right">Sent</Th>
                  <Th className="text-right">Delivered</Th>
                  <Th className="text-right">Read</Th>
                  <Th className="text-right">Contacted</Th>
                  <Th className="text-right">Replied</Th>
                  <Th className="text-right">Reply rate</Th>
                  <Th className="text-right">Leads added</Th>
                  <Th className="text-right">Meetings</Th>
                  <Th className="text-right">Won</Th>
                  <Th>Numbers</Th>
                  <Th>Last active</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <Tr key={r.user_id}>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <span className="w-4 text-xs text-subtle tabular">{i + 1}</span>
                        <Avatar name={r.full_name || r.email} size="sm" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 truncate font-medium">
                            {r.full_name || r.email}
                            {!r.active && <Badge tone="warning">Suspended</Badge>}
                          </div>
                          <div className="truncate text-xs text-subtle">{r.teams.join(', ') || r.role}</div>
                        </div>
                      </div>
                    </Td>
                    <Td className="text-right font-semibold tabular">{formatNumber(r.messages_sent)}</Td>
                    <Td className="text-right tabular">{formatPercent(r.delivered, r.messages_sent)}</Td>
                    <Td className="text-right tabular">{formatPercent(r.read, r.messages_sent)}</Td>
                    <Td className="text-right tabular">{formatNumber(r.leads_contacted)}</Td>
                    <Td className="text-right tabular text-success">{formatNumber(r.leads_replied)}</Td>
                    <Td className="text-right tabular">{formatPercent(r.leads_replied, r.leads_contacted, 1)}</Td>
                    <Td className="text-right tabular">{formatNumber(r.leads_added)}</Td>
                    <Td className="text-right tabular">{formatNumber(r.meetings)}</Td>
                    <Td className="text-right tabular">
                      {formatNumber(r.won)} <span className="text-xs text-subtle">{Number(r.won_value) ? formatMoney(Number(r.won_value), workspace.settings.currency ?? 'USD') : ''}</span>
                    </Td>
                    <Td className="text-xs text-muted">
                      {r.numbers_connected}/{r.numbers} online
                    </Td>
                    <Td className="text-xs text-muted">{r.last_active_at ? timeAgo(r.last_active_at) : '—'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>

      {seesTeam && (teams.data?.length ?? 0) > 0 && (
        <Card className="mb-5 overflow-hidden">
          <CardHeader title="By team" />
          <Table>
            <thead>
              <tr>
                <Th>Team</Th>
                <Th className="text-right">Members</Th>
                <Th className="text-right">Sent</Th>
                <Th className="text-right">Contacted</Th>
                <Th className="text-right">Replies</Th>
                <Th className="text-right">Read rate</Th>
                <Th className="text-right">Won</Th>
              </tr>
            </thead>
            <tbody>
              {teams.data!.map((t) => (
                <Tr key={t.team_id}>
                  <Td>
                    <span className="flex items-center gap-2 font-medium">
                      <span className="size-2.5 rounded-full" style={{ background: t.color }} /> {t.name}
                    </span>
                  </Td>
                  <Td className="text-right tabular">{t.members}</Td>
                  <Td className="text-right font-semibold tabular">{formatNumber(t.messages_sent)}</Td>
                  <Td className="text-right tabular">{formatNumber(t.leads_contacted)}</Td>
                  <Td className="text-right tabular text-success">{formatNumber(t.replies)}</Td>
                  <Td className="text-right tabular">{formatPercent(t.read, t.messages_sent)}</Td>
                  <Td className="text-right tabular">
                    {formatNumber(t.won)} <span className="text-xs text-subtle">{Number(t.won_value) ? formatMoney(Number(t.won_value), workspace.settings.currency ?? 'USD') : ''}</span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader title="Campaigns × people" description="Who sent which campaign messages from which number, and what came back." />
        {!senders.data?.length ? (
          <EmptyState compact title="No campaign messages in this period" />
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[860px]">
              <thead>
                <tr>
                  <Th>Campaign</Th>
                  <Th>Member</Th>
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
                {senders.data.filter((s) => !member || s.user_id === member).map((s) => (
                  <Tr key={`${s.campaign_id}-${s.account_id}`}>
                    <Td className="max-w-[240px] truncate font-medium">{s.campaign_name}</Td>
                    <Td>{s.full_name ?? '—'}</Td>
                    <Td className="text-muted">{s.account_label ?? '—'}</Td>
                    <Td className="text-right font-semibold tabular">{formatNumber(s.messages_sent)}</Td>
                    <Td className="text-right tabular">{formatNumber(s.leads_contacted)}</Td>
                    <Td className="text-right tabular">{formatPercent(s.delivered, s.messages_sent)}</Td>
                    <Td className="text-right tabular">{formatPercent(s.read, s.messages_sent)}</Td>
                    <Td className="text-right tabular text-success">{formatNumber(s.replied)}</Td>
                    <Td className="text-right tabular text-danger">{formatNumber(s.failed)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
      <Legend className="mt-3" items={[]} />
    </Page>
  );
}
