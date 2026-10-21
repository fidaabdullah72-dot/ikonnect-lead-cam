'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ExternalLink, Inbox, MessagesSquare, Search, UserRound, Users } from 'lucide-react';
import { formatPhone, type Conversation, type InboxFolderCount, type Lead, type Message } from '@batsols/shared';
import { WhatsAppIcon } from '@/components/brand';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/controls';
import { EmptyState, Skeleton } from '@/components/ui/feedback';
import { Input, NativeSelect } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/menu';
import { Composer, MessageThread, useReactToMessage, useSenderOf } from '@/components/whatsapp/chat';
import { LeadDrawer } from '@/components/leads/lead-drawer';
import { OwnerSelect, Rating, StageSelect, WaStatus } from '@/components/leads/bits';
import { getSupabase } from '@/lib/supabase/client';
import { useTeams } from '@/lib/access';
import { qk, useAccounts, useMembers, useRealtime, useUsableAccounts } from '@/lib/queries';
import { useLead, useUpdateLead } from '@/lib/leads';
import { useWorkspace } from '@/lib/workspace';
import { cn, dayLabel, hostname, shortDate } from '@/lib/utils';

type ConvRow = Conversation & { lead: Pick<Lead, 'id' | 'business_name' | 'phone' | 'owner_id' | 'city' | 'opted_out'> };
type Filter = 'all' | 'unread' | 'mine' | 'archived';
/** Whose chats: everyone's, one teammate's ("u:<id>") or one team's ("t:<id>"). */
type FolderKey = 'all' | `u:${string}` | `t:${string}`;

interface Folder {
  key: FolderKey;
  label: string;
  /** Title above the chat list. */
  title: string;
  kind: 'all' | 'member' | 'team';
  conversations: number;
  unread: number;
  color?: string;
}

function useInboxFolders() {
  const { workspace } = useWorkspace();
  return useQuery({
    // Under the conversations key, so the realtime refresh of chats refreshes the counts too.
    queryKey: [...qk.conversations(workspace.id), 'folders'],
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('inbox_folders', { p_workspace: workspace.id });
      if (error) throw error;
      return (data ?? []) as InboxFolderCount[];
    },
  });
}

/** Folders: all chats, then you and every teammate with chats, then teams. */
function useFolders(): Folder[] {
  const { userId } = useWorkspace();
  const { byId } = useMembers();
  const { teams } = useTeams();
  const counts = useInboxFolders().data;
  return React.useMemo(() => {
    const count = (kind: InboxFolderCount['kind'], id: string | null) => counts?.find((c) => c.kind === kind && c.id === id);
    const all = count('all', null);
    const name = (id: string) => byId.get(id)?.profile.full_name || byId.get(id)?.profile.email || 'Former teammate';
    const people = [userId, ...(counts ?? []).filter((c) => c.kind === 'member' && c.id && c.id !== userId).map((c) => c.id!)]
      .map((id): Folder => {
        const c = count('member', id);
        const me = id === userId;
        return { key: `u:${id}`, label: me ? `You · ${name(id)}` : name(id), title: me ? 'Your chats' : `${name(id)}’s chats`, kind: 'member', conversations: c?.conversations ?? 0, unread: c?.unread ?? 0 };
      })
      .sort((a, b) => Number(b.key === `u:${userId}`) - Number(a.key === `u:${userId}`) || b.unread - a.unread || a.label.localeCompare(b.label));
    const teamFolders = teams.map((t): Folder => {
      const c = count('team', t.id);
      return { key: `t:${t.id}`, label: t.name, title: `${t.name} team`, kind: 'team', conversations: c?.conversations ?? 0, unread: c?.unread ?? 0, color: t.color };
    });
    return [{ key: 'all', label: 'All chats', title: 'Inbox', kind: 'all', conversations: all?.conversations ?? 0, unread: all?.unread ?? 0 }, ...people, ...teamFolders];
  }, [counts, byId, teams, userId]);
}

function FolderButton({ folder, active, onSelect }: { folder: Folder; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors',
        active ? 'bg-surface font-semibold text-foreground shadow-sm ring-1 ring-border' : 'text-muted hover:bg-surface-2/70 hover:text-foreground',
      )}
    >
      {folder.kind === 'all' ? (
        <Inbox className="size-4 shrink-0 text-subtle" />
      ) : folder.kind === 'team' ? (
        <span className="mx-1 size-2.5 shrink-0 rounded-full" style={{ background: folder.color }} />
      ) : (
        <Avatar name={folder.label.replace(/^You · /, '')} size="xs" />
      )}
      <span className="min-w-0 flex-1 truncate">{folder.label}</span>
      {folder.unread > 0 ? (
        <Tooltip content={`${folder.unread} unread of ${folder.conversations} chats`}>
          <span className="tabular rounded-full bg-whatsapp-bright px-1.5 text-[11px] font-semibold leading-[18px] text-black/80">{folder.unread}</span>
        </Tooltip>
      ) : (
        folder.conversations > 0 && <span className="tabular text-[11px] text-subtle">{folder.conversations}</span>
      )}
    </button>
  );
}

/** Groups chats under Today / Yesterday / … by their latest message (the list is newest first). */
function byDay(list: ConvRow[]): Array<{ label: string; items: ConvRow[] }> {
  const out: Array<{ label: string; items: ConvRow[] }> = [];
  for (const c of list) {
    const label = dayLabel(c.last_message_at);
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(c);
    else out.push({ label, items: [c] });
  }
  return out;
}

export function InboxView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { workspace, userId } = useWorkspace();
  const { accounts, byId: accountById } = useAccounts();
  const { byId: memberById } = useMembers();
  const { membersOf } = useTeams();
  const folders = useFolders();
  const qc = useQueryClient();
  const [filter, setFilter] = React.useState<Filter>('all');
  const [account, setAccount] = React.useState('');
  const [q, setQ] = React.useState('');
  const [drawer, setDrawer] = React.useState<string | null>(null);
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const selected = params.get('c');
  const folderKey = (params.get('f') as FolderKey | null) ?? 'all';
  const folder = folders.find((f) => f.key === folderKey) ?? folders[0]!;
  const teamIds = folderKey.startsWith('t:') ? membersOf(folderKey.slice(2)) : null;
  const listKey = [...qk.conversations(workspace.id), filter, account, q, folderKey, teamIds];

  useRealtime('conversations', `workspace_id=eq.${workspace.id}`, [qk.conversations(workspace.id)]);
  const list = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      let query = getSupabase()
        .from('conversations')
        .select('*, lead:leads!inner(id, business_name, phone, owner_id, city, opted_out)')
        .eq('workspace_id', workspace.id)
        .eq('archived', filter === 'archived')
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(200);
      if (filter === 'unread') query = query.gt('unread_count', 0);
      if (filter === 'mine') query = query.eq('lead.owner_id', userId);
      if (account) query = query.eq('account_id', account);
      if (folderKey.startsWith('u:')) query = query.contains('member_ids', [folderKey.slice(2)]);
      if (teamIds) {
        if (!teamIds.length) return [];
        query = query.overlaps('member_ids', teamIds);
      }
      if (q.trim()) query = query.ilike('lead.business_name', `%${q.trim()}%`);
      const { data, error } = await query;
      if (error) throw error;
      return data as unknown as ConvRow[];
    },
  });

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const select = (id: string) => setParams({ c: id });
  const openFolder = (key: FolderKey) => setParams({ f: key === 'all' ? null : key, c: null });
  const current = list.data?.find((c) => c.id === selected) ?? null;

  // Opening a chat marks it read.
  React.useEffect(() => {
    if (current && current.unread_count > 0) {
      void getSupabase()
        .from('conversations')
        .update({ unread_count: 0 })
        .eq('id', current.id)
        .then(() => qc.invalidateQueries({ queryKey: qk.conversations(workspace.id) }));
    }
  }, [current, qc, workspace.id]);

  const firstName = (id: string | null) => (!id ? null : id === userId ? 'You' : (memberById.get(id)?.profile.full_name || memberById.get(id)?.profile.email || 'Former teammate').split(' ')[0]!);
  const people = folders.filter((f) => f.kind === 'member');
  const teamFolders = folders.filter((f) => f.kind === 'team');

  return (
    <div className="flex h-full min-h-0">
      {/* Folders */}
      <nav className="hidden w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-surface-2/30 p-2 xl:flex" aria-label="Inbox folders">
        <h1 className="flex items-center gap-2 px-2.5 pb-2 pt-1.5 text-[17px] font-semibold tracking-[-0.01em]">
          <Inbox className="size-4.5 text-primary" /> Inbox
        </h1>
        <FolderButton folder={folders[0]!} active={folder.key === 'all'} onSelect={() => openFolder('all')} />
        <div className="px-2.5 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wider text-subtle">Teammates</div>
        {people.map((f) => (
          <FolderButton key={f.key} folder={f} active={folder.key === f.key} onSelect={() => openFolder(f.key)} />
        ))}
        {teamFolders.length > 0 && <div className="px-2.5 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wider text-subtle">Teams</div>}
        {teamFolders.map((f) => (
          <FolderButton key={f.key} folder={f} active={folder.key === f.key} onSelect={() => openFolder(f.key)} />
        ))}
        <p className="mt-auto px-2.5 pt-4 text-[11px] leading-relaxed text-subtle">
          A chat is in the folder of whoever owns the number and of everyone who sent a message in it.
        </p>
      </nav>

      {/* Conversation list */}
      <aside className={cn('flex w-full shrink-0 flex-col border-r border-border md:w-[340px]', selected && 'hidden md:flex')}>
        <div className="space-y-2.5 border-b border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex min-w-0 items-center gap-2 text-[17px] font-semibold tracking-[-0.01em]">
              {folder.kind === 'all' ? <Inbox className="size-4.5 shrink-0 text-primary" /> : <Users className="size-4.5 shrink-0 text-primary" />}
              <span className="truncate">{folder.title}</span>
            </h2>
            {mounted && accounts.length > 1 && (
              <NativeSelect inputSize="sm" className="w-36 shrink-0" value={account} onChange={(e) => setAccount(e.target.value)}>
                <option value="">All numbers</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </div>
          {/* Folders on small screens */}
          <NativeSelect inputSize="sm" className="xl:hidden" value={folder.key} onChange={(e) => openFolder(e.target.value as FolderKey)} aria-label="Folder">
            <option value="all">All chats{folders[0]!.unread ? ` (${folders[0]!.unread} unread)` : ''}</option>
            <optgroup label="Teammates">
              {people.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                  {f.unread ? ` (${f.unread} unread)` : ''}
                </option>
              ))}
            </optgroup>
            {teamFolders.length > 0 && (
              <optgroup label="Teams">
                {teamFolders.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                    {f.unread ? ` (${f.unread} unread)` : ''}
                  </option>
                ))}
              </optgroup>
            )}
          </NativeSelect>
          <Input inputSize="sm" leading={<Search />} placeholder="Search chats…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Segmented<Filter>
            size="sm"
            value={filter}
            onChange={setFilter}
            className="w-full"
            options={[
              { value: 'all', label: 'All' },
              { value: 'unread', label: 'Unread' },
              { value: 'mine', label: 'My leads' },
              { value: 'archived', label: 'Archived' },
            ]}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.isLoading &&
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex gap-3 border-b border-border p-3">
                <Skeleton className="size-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
            ))}
          {!list.isLoading && !list.data?.length && (
            <EmptyState
              compact
              icon={<MessagesSquare />}
              title={filter === 'unread' ? 'All caught up' : folder.kind === 'all' ? 'No conversations yet' : 'No chats in this folder yet'}
              description={
                folder.kind === 'member'
                  ? 'Chats on their numbers, and chats they sent a message in, appear here.'
                  : 'Replies to your campaigns and messages appear here instantly.'
              }
            />
          )}
          {byDay(list.data ?? []).map((group) => (
            <section key={group.label}>
              <div className="sticky top-0 z-10 border-b border-border bg-surface/95 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle backdrop-blur">
                {group.label}
              </div>
              {group.items.map((c) => {
                const who = c.last_direction === 'out' ? firstName(c.last_sender_id) : null;
                const inChat = c.member_ids.map(firstName).filter(Boolean).join(', ');
                const via = accounts.length > 1 ? accountById.get(c.account_id)?.label : null;
                return (
                  <button
                    key={c.id}
                    onClick={() => select(c.id)}
                    className={cn('flex w-full gap-3 border-b border-border px-3 py-3 text-left transition-colors hover:bg-surface-2/60', c.id === selected && 'bg-primary-soft hover:bg-primary-soft')}
                  >
                    <Avatar name={c.lead.business_name} size="lg" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={cn('truncate text-[13.5px]', c.unread_count ? 'font-semibold' : 'font-medium')}>{c.lead.business_name}</span>
                        <span className={cn('ml-auto shrink-0 text-[11px]', c.unread_count ? 'font-semibold text-whatsapp' : 'text-subtle')}>{shortDate(c.last_message_at)}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <span className={cn('truncate text-[12.5px]', c.unread_count ? 'text-foreground' : 'text-muted')}>
                          {who && <span className="font-medium text-subtle">{who}: </span>}
                          {c.last_message_preview}
                        </span>
                        {c.unread_count > 0 && (
                          <span className="ml-auto flex min-w-5 shrink-0 items-center justify-center rounded-full bg-whatsapp-bright px-1.5 text-[11px] font-semibold leading-5 text-black/80">{c.unread_count}</span>
                        )}
                      </div>
                      {(inChat || via) && (
                        <div className="mt-0.5 truncate text-[11px] text-subtle">
                          {inChat}
                          {inChat && via ? ' · ' : ''}
                          {via ? `via ${via}` : ''}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </section>
          ))}
        </div>
      </aside>

      {/* Chat */}
      {current ? (
        <ChatPane key={current.id} conv={current} onBack={() => setParams({ c: null })} onOpenLead={() => setDrawer(current.lead.id)} />
      ) : (
        <div className="hidden flex-1 items-center justify-center md:flex">
          <EmptyState icon={<WhatsAppIcon />} title="Select a conversation" description="Every WhatsApp reply from every teammate’s number lands here, live — sorted into a folder per teammate." />
        </div>
      )}
      <LeadDrawer leadId={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}

function ChatPane({ conv, onBack, onOpenLead }: { conv: ConvRow; onBack: () => void; onOpenLead: () => void }) {
  const { workspace, can } = useWorkspace();
  const { byId: accountById } = useAccounts();
  const { byId: members } = useMembers();
  const qc = useQueryClient();
  const { data: lead } = useLead(conv.lead.id);
  const update = useUpdateLead();
  const key = qk.messages(conv.id);
  useRealtime('messages', `conversation_id=eq.${conv.id}`, [key]);
  const messages = useQuery({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await getSupabase().from('messages').select('*').eq('conversation_id', conv.id).order('created_at', { ascending: false }).limit(300);
      if (error) throw error;
      return (data as Message[]).reverse();
    },
  });
  // Queued manual messages have no conversation yet: show them too.
  const queued = useQuery({
    queryKey: [...key, 'queued'],
    queryFn: async () => {
      const { data } = await getSupabase().from('messages').select('*').eq('lead_id', conv.lead.id).eq('account_id', conv.account_id).is('conversation_id', null).order('created_at');
      return (data ?? []) as Message[];
    },
    refetchInterval: 4000,
  });
  const thread = React.useMemo(() => [...(messages.data ?? []), ...(queued.data ?? [])], [messages.data, queued.data]);
  const senderOf = useSenderOf(thread);
  const account = accountById.get(conv.account_id);
  const { accounts: usable } = useUsableAccounts();
  const react = useReactToMessage({ optimisticKey: key });
  const canReact = usable.some((a) => a.id === conv.account_id);
  const assignee = conv.assigned_to ? members.get(conv.assigned_to) : undefined;
  const owner = account?.owner_id ? members.get(account.owner_id) : undefined;

  async function setConv(patch: Partial<Conversation>) {
    await getSupabase().from('conversations').update(patch).eq('id', conv.id);
    qc.invalidateQueries({ queryKey: qk.conversations(workspace.id) });
  }

  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={onBack} aria-label="Back">
            ‹
          </Button>
          <Avatar name={conv.lead.business_name} size="md" />
          <button className="min-w-0 flex-1 text-left" onClick={onOpenLead}>
            <div className="truncate text-[14px] font-semibold hover:text-primary">{conv.lead.business_name}</div>
            <div className="truncate text-xs text-muted">
              {formatPhone(conv.lead.phone)} · via {account?.label ?? 'number'}
              {owner ? ` (${owner.profile.full_name || owner.profile.email})` : ''}
            </div>
          </button>
          {can.write && (
            <OwnerSelect value={conv.assigned_to} onChange={(id) => setConv({ assigned_to: id })} compact />
          )}
          <Tooltip content={conv.archived ? 'Move back to inbox' : 'Archive chat'}>
            <Button variant="ghost" size="icon-sm" onClick={() => setConv({ archived: !conv.archived })} aria-label="Archive">
              {conv.archived ? <ArchiveRestore /> : <Archive />}
            </Button>
          </Tooltip>
        </header>
        <MessageThread
          messages={thread}
          className="min-h-0 flex-1 bg-[#efeae2]/60 dark:bg-[#0b141a]/60"
          emptyHint="No messages in this chat yet."
          onReact={canReact ? react : undefined}
          senderOf={senderOf}
        />
        {lead && <Composer lead={lead} defaultAccountId={conv.account_id} lockAccount onSent={() => queued.refetch()} />}
        {assignee && <div className="border-t border-border px-4 py-1.5 text-[11px] text-subtle">Assigned to {assignee.profile.full_name}</div>}
      </section>

      {lead && (
        <aside className="hidden w-[300px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4 2xl:flex">
          <div className="text-center">
            <Avatar name={lead.business_name} size="xl" square className="mx-auto" />
            <div className="mt-2 text-[15px] font-semibold">{lead.business_name}</div>
            <div className="text-xs text-muted">{[lead.category, lead.city].filter(Boolean).join(' · ')}</div>
            <div className="mt-1 flex items-center justify-center gap-2">
              <Rating rating={lead.rating} reviews={lead.reviews_count} />
              <WaStatus lead={lead} />
            </div>
          </div>
          <div className="space-y-3 rounded-xl border border-border p-3">
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-subtle">Stage</div>
              <StageSelect value={lead.stage_id} onChange={(id) => update.mutate({ id: lead.id, patch: { stage_id: id } })} disabled={!can.write} size="md" />
            </div>
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-subtle">Lead owner</div>
              <OwnerSelect value={lead.owner_id} onChange={(id) => update.mutate({ id: lead.id, patch: { owner_id: id } })} disabled={!can.write} />
            </div>
          </div>
          <div className="space-y-1.5 text-[13px]">
            {lead.website && (
              <a href={lead.website} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-primary hover:underline">
                <ExternalLink className="size-3.5" /> {hostname(lead.website)}
              </a>
            )}
            {lead.email && <div className="truncate text-muted">{lead.email}</div>}
            {lead.address && <div className="text-muted">{lead.address}</div>}
          </div>
          <Button variant="secondary" onClick={onOpenLead}>
            <UserRound /> Open full profile
          </Button>
        </aside>
      )}
    </>
  );
}
