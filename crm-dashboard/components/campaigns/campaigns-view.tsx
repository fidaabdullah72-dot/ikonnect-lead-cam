'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, Send, Sparkles } from 'lucide-react';
import { Page } from '@/components/shell/app-shell';
import { Avatar, AvatarStack } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress, Segmented } from '@/components/ui/controls';
import { EmptyState, Skeleton } from '@/components/ui/feedback';
import { PageHeader, Table, Td, Th, Tr } from '@/components/ui/layout';
import { CampaignMenu } from './campaign-actions';
import { CAMPAIGN_STATUS, useCampaigns, type CampaignWithStats } from '@/lib/campaigns';
import { useAssignments } from '@/lib/access';
import { useAccounts, useMembers } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { formatNumber, formatPercent, timeAgo } from '@/lib/utils';

type Tab = 'all' | 'active' | 'draft' | 'done';

export function CampaignsView() {
  const router = useRouter();
  const { can, userId } = useWorkspace();
  const { data: campaigns = [], isLoading } = useCampaigns();
  const { byId: members } = useMembers();
  const { byId: accounts } = useAccounts();
  const assignments = useAssignments('campaign');
  const [tab, setTab] = React.useState<Tab>('all');
  const [mine, setMine] = React.useState(false);

  const matches = (c: CampaignWithStats) =>
    (tab === 'all' ||
      (tab === 'active' && ['running', 'scheduled', 'paused'].includes(c.status)) ||
      (tab === 'draft' && c.status === 'draft') ||
      (tab === 'done' && ['completed', 'cancelled'].includes(c.status))) &&
    (!mine || c.created_by === userId || assignments.isMine(c.id));
  const list = campaigns.filter(matches);
  const count = (t: Tab) => campaigns.filter((c) => (t === 'all' ? true : t === 'active' ? ['running', 'scheduled', 'paused'].includes(c.status) : t === 'draft' ? c.status === 'draft' : ['completed', 'cancelled'].includes(c.status))).length;

  return (
    <Page wide>
      <PageHeader
        icon={<Send />}
        title="Campaigns"
        description="WhatsApp sequences that run on the server — safely paced, personalised and tracked."
        actions={
          can.write && (
            <Button variant="primary" onClick={() => router.push('/campaigns/new')}>
              <Plus /> New campaign
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'all', label: 'All', count: count('all') },
            { value: 'active', label: 'Active', count: count('active') },
            { value: 'draft', label: 'Drafts', count: count('draft') },
            { value: 'done', label: 'Finished', count: count('done') },
          ]}
        />
        <Segmented
          value={mine ? 'mine' : 'team'}
          onChange={(v) => setMine(v === 'mine')}
          options={[
            { value: 'team', label: 'Team' },
            { value: 'mine', label: 'Mine & assigned' },
          ]}
        />
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : campaigns.length === 0 ? (
          <EmptyState
            icon={<Sparkles />}
            title="Launch your first campaign"
            description="Pick leads, write a personal message with variations, choose your numbers — BatWos handles pacing, follow-ups and replies."
            action={
              can.write && (
                <Button variant="primary" onClick={() => router.push('/campaigns/new')}>
                  <Plus /> New campaign
                </Button>
              )
            }
          />
        ) : list.length === 0 ? (
          <EmptyState compact title="Nothing here" description="No campaigns match this view." />
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[960px]">
              <thead>
                <tr>
                  <Th>Campaign</Th>
                  <Th>Status</Th>
                  <Th className="w-[220px]">Progress</Th>
                  <Th className="text-right">Delivered</Th>
                  <Th className="text-right">Read</Th>
                  <Th className="text-right">Replied</Th>
                  <Th>Senders</Th>
                  <Th>Owner</Th>
                  <Th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {list.map((c) => {
                  const s = c.stats;
                  const total = s?.total ?? 0;
                  const sent = s?.sent ?? 0;
                  const done = (s?.completed ?? 0) + (s?.replied ?? 0) + (s?.failed ?? 0) + (s?.skipped ?? 0);
                  const owner = c.created_by ? members.get(c.created_by) : undefined;
                  const st = CAMPAIGN_STATUS[c.status];
                  return (
                    <Tr key={c.id} className="cursor-pointer" onClick={() => router.push(`/campaigns/${c.id}`)}>
                      <Td className="max-w-[300px]">
                        <Link href={`/campaigns/${c.id}`} className="block truncate font-medium hover:text-primary" onClick={(e) => e.stopPropagation()}>
                          {c.name}
                        </Link>
                        <div className="truncate text-xs text-subtle">
                          {c.paused_reason ?? (c.started_at ? `Started ${timeAgo(c.started_at)}` : `Created ${timeAgo(c.created_at)}`)}
                        </div>
                      </Td>
                      <Td>
                        <Badge tone={st.tone} dot pulse={c.status === 'running'}>
                          {st.label}
                        </Badge>
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <Progress value={total ? (done / total) * 100 : 0} tone={c.status === 'completed' ? 'success' : 'primary'} className="flex-1" />
                          <span className="w-20 text-right text-xs tabular text-muted">
                            {formatNumber(sent)}/{formatNumber(total)}
                          </span>
                        </div>
                      </Td>
                      <Td className="text-right tabular">{formatPercent(s?.delivered ?? 0, sent)}</Td>
                      <Td className="text-right tabular">{formatPercent(s?.read ?? 0, sent)}</Td>
                      <Td className="text-right">
                        <span className="font-semibold tabular text-success">{formatNumber(s?.replied ?? 0)}</span>
                        <span className="ml-1 text-xs text-subtle">{formatPercent(s?.replied ?? 0, sent)}</span>
                      </Td>
                      <Td>
                        <AvatarStack names={c.account_ids.map((id) => accounts.get(id)?.label ?? 'Number')} max={3} />
                      </Td>
                      <Td>
                        {owner && (
                          <span className="flex items-center gap-2 text-[13px]">
                            <Avatar name={owner.profile.full_name || owner.profile.email} src={owner.profile.avatar_url} size="xs" />
                            <span className="truncate">{owner.profile.full_name.split(' ')[0]}</span>
                          </span>
                        )}
                        {(assignments.byResource.get(c.id)?.length ?? 0) > 0 && (
                          <div className="mt-1 truncate text-xs text-muted">
                            {c.created_by !== userId && assignments.isMine(c.id) ? (
                              <span className="font-medium text-primary">Assigned to you</span>
                            ) : (
                              <>
                                →{' '}
                                {assignments.byResource
                                  .get(c.id)!
                                  .map((g) => (g.team_id ? assignments.teamName(g.team_id) : (members.get(g.user_id!)?.profile.full_name.split(' ')[0] ?? 'Member')))
                                  .join(', ')}
                              </>
                            )}
                          </div>
                        )}
                      </Td>
                      <Td onClick={(e) => e.stopPropagation()}>
                        <CampaignMenu campaign={c} />
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </Page>
  );
}
