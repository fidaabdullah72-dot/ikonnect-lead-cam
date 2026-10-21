'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format, isSameDay } from 'date-fns';
import { AtSign, Building2, Hash, Lock, LogOut, MessageCirclePlus, Pencil, Plus, Send, SmilePlus, Trash2, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { ChatChannel, ChatMessage, ChatOverviewRow, ChatReaction } from '@batsols/shared';
import { Avatar, AvatarStack } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Checkbox, SwitchRow } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState, useConfirm } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from '@/components/ui/menu';
import { LeadDrawer } from '@/components/leads/lead-drawer';
import { getSupabase } from '@/lib/supabase/client';
import { useMembers, useRealtime } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, errorMessage, shortDate } from '@/lib/utils';

type Msg = ChatMessage & { lead: { id: string; business_name: string; city: string | null; category: string | null } | null };
const REACTIONS = ['👍', '✅', '🎉', '❤️', '👀', '🙏'];

function useChannels() {
  const { workspace, userId } = useWorkspace();
  const key = ['chat-channels', workspace.id];
  useRealtime('chat_channels', `workspace_id=eq.${workspace.id}`, [key]);
  useRealtime('chat_members', `user_id=eq.${userId}`, [key]);
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const sb = getSupabase();
      const [ch, mem, ov] = await Promise.all([
        sb.from('chat_channels').select('*').eq('workspace_id', workspace.id).eq('archived', false).order('last_message_at', { ascending: false, nullsFirst: false }),
        sb.from('chat_members').select('channel_id, user_id').eq('workspace_id', workspace.id),
        sb.rpc('chat_overview', { p_workspace: workspace.id }),
      ]);
      if (ch.error) throw ch.error;
      const members = new Map<string, string[]>();
      for (const m of mem.data ?? []) members.set(m.channel_id, [...(members.get(m.channel_id) ?? []), m.user_id]);
      const overview = new Map(((ov.data ?? []) as ChatOverviewRow[]).map((o) => [o.channel_id, o]));
      return (ch.data as ChatChannel[]).map((c) => ({ ...c, members: members.get(c.id) ?? [], unread: overview.get(c.id)?.unread ?? 0, mentions: overview.get(c.id)?.mentions ?? 0, joined: (members.get(c.id) ?? []).includes(userId) }));
    },
  });
}
type ChannelRow = NonNullable<ReturnType<typeof useChannels>['data']>[number];

export function ChatView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { userId } = useWorkspace();
  const { byId } = useMembers();
  const { data: channels = [] } = useChannels();
  const [newChannel, setNewChannel] = React.useState(false);
  const [newDm, setNewDm] = React.useState(false);
  const selectedId = params.get('c') ?? channels.find((c) => c.kind === 'channel' && c.joined)?.id ?? null;
  const selected = channels.find((c) => c.id === selectedId) ?? null;
  const open = (id: string) => router.replace(`${pathname}?c=${id}`, { scroll: false });

  const dmName = (c: ChannelRow) => {
    const others = c.members.filter((m) => m !== userId);
    if (!others.length) return 'Notes to self';
    return others.map((m) => byId.get(m)?.profile.full_name || 'Teammate').join(', ');
  };
  const channelsList = channels.filter((c) => c.kind === 'channel' && (c.joined || !c.is_private));
  const dms = channels.filter((c) => c.kind === 'dm');

  return (
    <div className="flex h-full min-h-0">
      <aside className={cn('flex w-full shrink-0 flex-col border-r border-border md:w-[280px]', params.get('c') && 'hidden md:flex')}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em]">Team chat</h1>
          <Tooltip content="New direct message">
            <Button size="icon-sm" variant="ghost" onClick={() => setNewDm(true)} aria-label="New direct message">
              <MessageCirclePlus />
            </Button>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-2">
          <div>
            <div className="flex items-center justify-between px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-subtle">
              Channels
              <button onClick={() => setNewChannel(true)} className="rounded p-0.5 hover:bg-surface-2 hover:text-foreground" aria-label="New channel">
                <Plus className="size-3.5" />
              </button>
            </div>
            {channelsList.map((c) => (
              <SidebarRow key={c.id} active={c.id === selectedId} onClick={() => open(c.id)} icon={c.is_private ? <Lock /> : <Hash />} label={c.name ?? ''} unread={c.unread} mentions={c.mentions} dim={!c.joined} />
            ))}
          </div>
          <div>
            <div className="flex items-center justify-between px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-subtle">
              Direct messages
              <button onClick={() => setNewDm(true)} className="rounded p-0.5 hover:bg-surface-2 hover:text-foreground" aria-label="New DM">
                <Plus className="size-3.5" />
              </button>
            </div>
            {dms.map((c) => (
              <SidebarRow key={c.id} active={c.id === selectedId} onClick={() => open(c.id)} icon={<Avatar name={dmName(c)} size="xs" />} label={dmName(c)} unread={c.unread} mentions={c.mentions} />
            ))}
            {!dms.length && <p className="px-2 py-1 text-xs text-subtle">No direct messages yet.</p>}
          </div>
        </div>
      </aside>
      {selected ? (
        <ChannelPane key={selected.id} channel={selected} title={selected.kind === 'dm' ? dmName(selected) : selected.name ?? ''} onBack={() => router.replace(pathname)} />
      ) : (
        <div className="hidden flex-1 items-center justify-center md:flex">
          <EmptyState icon={<Users />} title="Talk with your team" description="Channels for groups, direct messages for one-to-one. Share leads and @mention teammates." />
        </div>
      )}
      <NewChannelDialog open={newChannel} onOpenChange={setNewChannel} onCreated={open} />
      <NewDmDialog open={newDm} onOpenChange={setNewDm} onCreated={open} />
    </div>
  );
}

function SidebarRow({ active, onClick, icon, label, unread, mentions, dim }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; unread: number; mentions: number; dim?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13.5px] transition-colors [&_svg]:size-3.5',
        active ? 'bg-primary-soft font-medium text-primary' : unread ? 'font-semibold text-foreground hover:bg-surface-2' : 'text-muted hover:bg-surface-2 hover:text-foreground',
        dim && 'opacity-60',
      )}
    >
      <span className="flex shrink-0 text-subtle">{icon}</span>
      <span className="truncate">{label}</span>
      {mentions > 0 ? (
        <span className="ml-auto rounded-full bg-danger px-1.5 text-[10.5px] font-semibold leading-[18px] text-white">@{mentions}</span>
      ) : unread > 0 ? (
        <span className="ml-auto rounded-full bg-primary px-1.5 text-[10.5px] font-semibold leading-[18px] text-white">{unread}</span>
      ) : null}
    </button>
  );
}

function ChannelPane({ channel, title, onBack }: { channel: ChannelRow; title: string; onBack: () => void }) {
  const { workspace, userId, can } = useWorkspace();
  const { byId, members } = useMembers();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [leadId, setLeadId] = React.useState<string | null>(null);
  const [addMembers, setAddMembers] = React.useState(false);
  const [pickerFor, setPickerFor] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<{ id: string; body: string } | null>(null);
  const key = ['chat-messages', channel.id];
  const reactionsKey = ['chat-reactions', channel.id];
  // Reaction changes touch their message (reacted_at), so this one feed covers both.
  useRealtime('chat_messages', `channel_id=eq.${channel.id}`, [key, reactionsKey, ['chat-channels', workspace.id]]);
  const { data: messages = [] } = useQuery({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await getSupabase().from('chat_messages').select('*, lead:leads(id, business_name, city, category)').eq('channel_id', channel.id).order('created_at', { ascending: false }).limit(300);
      if (error) throw error;
      return (data as unknown as Msg[]).reverse();
    },
  });
  const { data: reactions = [] } = useQuery({
    queryKey: reactionsKey,
    enabled: messages.length > 0,
    queryFn: async () => {
      const { data, error } = await getSupabase().from('chat_reactions').select('*').in('message_id', messages.map((m) => m.id).slice(-150));
      if (error) throw error;
      return data as ChatReaction[];
    },
  });
  const endRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
    if (channel.joined) {
      void getSupabase()
        .from('chat_members')
        .update({ last_read_at: new Date().toISOString() })
        .eq('channel_id', channel.id)
        .eq('user_id', userId)
        .then(() => qc.invalidateQueries({ queryKey: ['chat-channels', workspace.id] }));
    }
  }, [messages.length, channel.id, channel.joined, userId, qc, workspace.id]);

  async function join() {
    const { error } = await getSupabase().from('chat_members').insert({ channel_id: channel.id, workspace_id: workspace.id, user_id: userId });
    if (error) return toast.error(errorMessage(error));
    qc.invalidateQueries({ queryKey: ['chat-channels', workspace.id] });
  }
  async function leave() {
    if (!(await confirm({ title: `Leave ${channel.kind === 'dm' ? 'this conversation' : `#${channel.name}`}?`, confirmLabel: 'Leave' }))) return;
    await getSupabase().from('chat_members').delete().eq('channel_id', channel.id).eq('user_id', userId);
    qc.invalidateQueries({ queryKey: ['chat-channels', workspace.id] });
    onBack();
  }
  async function react(m: Msg, emoji: string) {
    setPickerFor(null);
    const mine = reactions.some((r) => r.message_id === m.id && r.user_id === userId && r.emoji === emoji);
    // Show it straight away; the server result replaces it.
    await qc.cancelQueries({ queryKey: reactionsKey });
    qc.setQueryData<ChatReaction[]>(reactionsKey, (list = []) =>
      mine
        ? list.filter((r) => !(r.message_id === m.id && r.user_id === userId && r.emoji === emoji))
        : [...list, { message_id: m.id, workspace_id: workspace.id, user_id: userId, emoji, created_at: new Date().toISOString() }],
    );
    const sb = getSupabase();
    const { error } = mine
      ? await sb.from('chat_reactions').delete().eq('message_id', m.id).eq('user_id', userId).eq('emoji', emoji)
      : await sb.from('chat_reactions').upsert({ message_id: m.id, workspace_id: workspace.id, user_id: userId, emoji }, { onConflict: 'message_id,user_id,emoji', ignoreDuplicates: true });
    if (error) toast.error(errorMessage(error));
    qc.invalidateQueries({ queryKey: reactionsKey });
  }
  async function saveEdit() {
    if (!editing) return;
    const body = editing.body.trim();
    const original = messages.find((m) => m.id === editing.id)?.body;
    setEditing(null);
    if (!body || body === original) return;
    const { error } = await getSupabase().from('chat_messages').update({ body, edited_at: new Date().toISOString() }).eq('id', editing.id);
    if (error) toast.error(errorMessage(error));
    qc.invalidateQueries({ queryKey: key });
  }
  async function remove(m: Msg) {
    await getSupabase().from('chat_messages').update({ deleted_at: new Date().toISOString(), body: '' }).eq('id', m.id);
    qc.invalidateQueries({ queryKey: key });
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={onBack} aria-label="Back">
          ‹
        </Button>
        <span className="flex size-8 items-center justify-center rounded-lg bg-surface-2 text-muted">{channel.kind === 'dm' ? <AtSign className="size-4" /> : channel.is_private ? <Lock className="size-4" /> : <Hash className="size-4" />}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{title}</div>
          {channel.description && <div className="truncate text-xs text-muted">{channel.description}</div>}
        </div>
        <AvatarStack names={channel.members.map((m) => byId.get(m)?.profile.full_name ?? '?')} max={4} />
        {channel.kind === 'channel' && channel.joined && (
          <Tooltip content="Add people">
            <Button size="icon-sm" variant="ghost" onClick={() => setAddMembers(true)} aria-label="Add people">
              <UserPlus />
            </Button>
          </Tooltip>
        )}
        {channel.joined && !channel.is_default && (
          <Tooltip content="Leave">
            <Button size="icon-sm" variant="ghost" onClick={leave} aria-label="Leave">
              <LogOut />
            </Button>
          </Tooltip>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!messages.length && <EmptyState compact title={`This is the start of ${channel.kind === 'dm' ? 'your conversation' : `#${channel.name}`}`} description="Say hello, share a lead, or @mention someone." />}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const author = m.author_id ? byId.get(m.author_id) : undefined;
          const grouped = prev && prev.author_id === m.author_id && new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60_000;
          const newDay = !prev || !isSameDay(new Date(prev.created_at), new Date(m.created_at));
          const mine = m.author_id === userId;
          const rx = reactions.filter((r) => r.message_id === m.id);
          const grouped_rx = REACTIONS.map((e) => ({ e, n: rx.filter((r) => r.emoji === e).length, me: rx.some((r) => r.emoji === e && r.user_id === userId) })).filter((x) => x.n);
          return (
            <React.Fragment key={m.id}>
              {newDay && (
                <div className="my-3 flex items-center gap-3 text-[11px] font-medium text-subtle">
                  <span className="h-px flex-1 bg-border" />
                  {format(new Date(m.created_at), 'EEEE, d MMM')}
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <div className={cn('group relative flex gap-3 rounded-lg px-2 py-1 hover:bg-surface-2/50', !grouped && 'mt-2')}>
                <div className="w-8 shrink-0">{!grouped && <Avatar name={author?.profile.full_name ?? 'Former member'} src={author?.profile.avatar_url} size="md" />}</div>
                <div className="min-w-0 flex-1">
                  {!grouped && (
                    <div className="flex items-baseline gap-2">
                      <span className="text-[13.5px] font-semibold">{author?.profile.full_name ?? 'Former member'}</span>
                      <span className="text-[11px] text-subtle">{format(new Date(m.created_at), 'HH:mm')}</span>
                    </div>
                  )}
                  {m.deleted_at ? (
                    <p className="text-[13px] italic text-subtle">Message deleted</p>
                  ) : editing?.id === m.id ? (
                    <div className="mt-1 space-y-1.5">
                      <textarea
                        autoFocus
                        value={editing.body}
                        onChange={(e) => setEditing({ id: m.id, body: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            void saveEdit();
                          } else if (e.key === 'Escape') setEditing(null);
                        }}
                        rows={Math.min(6, editing.body.split('\n').length + 1)}
                        aria-label="Edit message"
                        className="w-full resize-none rounded-lg border border-primary bg-surface px-3 py-2 text-[13.5px] outline-none ring-[3px] ring-ring/30"
                      />
                      <div className="flex items-center gap-2 text-[11px] text-subtle">
                        <Button size="xs" variant="primary" onClick={saveEdit}>
                          Save
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                        Enter to save · Esc to cancel
                      </div>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">
                      {renderMentions(m.body, m.mentions, userId)}
                      {m.edited_at && <span className="ml-1 text-[11px] text-subtle">(edited)</span>}
                    </p>
                  )}
                  {m.lead && !m.deleted_at && (
                    <button onClick={() => setLeadId(m.lead!.id)} className="mt-1.5 flex max-w-sm items-center gap-3 rounded-xl border border-border bg-surface p-3 text-left shadow-sm transition-colors hover:border-primary">
                      <span className="flex size-9 items-center justify-center rounded-lg bg-primary-soft text-primary">
                        <Building2 className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold">{m.lead.business_name}</span>
                        <span className="block truncate text-xs text-muted">{[m.lead.category, m.lead.city].filter(Boolean).join(' · ') || 'Open lead'}</span>
                      </span>
                    </button>
                  )}
                  {grouped_rx.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {grouped_rx.map((x) => (
                        <button key={x.e} onClick={() => react(m, x.e)} className={cn('inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs', x.me ? 'border-primary bg-primary-soft' : 'border-border bg-surface')}>
                          {x.e} <span className="tabular">{x.n}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {!m.deleted_at && channel.joined && (
                  <div
                    className={cn(
                      'absolute -top-3 right-2 flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5 shadow-sm transition-opacity focus-within:opacity-100',
                      pickerFor === m.id ? 'opacity-100' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100',
                    )}
                  >
                    <Popover open={pickerFor === m.id} onOpenChange={(o) => setPickerFor(o ? m.id : null)}>
                      <PopoverTrigger asChild>
                        <button className="rounded p-1 text-subtle hover:bg-surface-2 hover:text-foreground" aria-label="React">
                          <SmilePlus className="size-3.5" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="flex gap-1 p-1.5" align="end">
                        {REACTIONS.map((e) => (
                          <button key={e} aria-label={`React ${e}`} className={cn('rounded p-1 text-base transition-transform hover:scale-125 hover:bg-surface-2', rx.some((r) => r.emoji === e && r.user_id === userId) && 'bg-primary-soft')} onClick={() => react(m, e)}>
                            {e}
                          </button>
                        ))}
                      </PopoverContent>
                    </Popover>
                    {mine && (
                      <button className="rounded p-1 text-subtle hover:bg-surface-2 hover:text-foreground" onClick={() => setEditing({ id: m.id, body: m.body })} aria-label="Edit">
                        <Pencil className="size-3.5" />
                      </button>
                    )}
                    {(mine || can.admin) && (
                      <button className="rounded p-1 text-subtle hover:bg-surface-2 hover:text-danger" onClick={() => remove(m)} aria-label="Delete">
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}
        <div ref={endRef} />
      </div>
      {channel.joined ? (
        <ChatComposer channel={channel} members={members.filter((m) => channel.kind === 'dm' ? channel.members.includes(m.user_id) : true)} onSent={() => qc.invalidateQueries({ queryKey: key })} />
      ) : (
        <div className="flex items-center justify-between border-t border-border px-4 py-3 text-[13px] text-muted">
          You’re viewing #{channel.name}.
          <Button size="sm" variant="primary" onClick={join}>
            Join channel
          </Button>
        </div>
      )}
      <AddMembersDialog open={addMembers} onOpenChange={setAddMembers} channel={channel} />
      <LeadDrawer leadId={leadId} onClose={() => setLeadId(null)} />
    </section>
  );
}

function renderMentions(body: string, mentions: string[], me: string) {
  if (!mentions.length) return body;
  const parts = body.split(/(@[\wÀ-ɏ]+(?: [\wÀ-ɏ]+)?)/g);
  return parts.map((p, i) =>
    p.startsWith('@') ? (
      <span key={i} className={cn('rounded px-0.5 font-medium', mentions.includes(me) ? 'bg-warning-soft text-warning' : 'bg-primary-soft text-primary')}>
        {p}
      </span>
    ) : (
      p
    ),
  );
}

function ChatComposer({ channel, members, onSent }: { channel: ChannelRow; members: ReturnType<typeof useMembers>['members']; onSent: () => void }) {
  const { workspace, userId } = useWorkspace();
  const [text, setText] = React.useState('');
  const [mentions, setMentions] = React.useState<string[]>([]);
  const [mentionQuery, setMentionQuery] = React.useState<string | null>(null);
  const [lead, setLead] = React.useState<{ id: string; business_name: string } | null>(null);
  const [leadSearch, setLeadSearch] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const leads = useQuery({
    queryKey: ['chat-lead-search', leadSearch],
    enabled: leadSearch.length >= 2,
    queryFn: async () => {
      const { data } = await getSupabase().rpc('filtered_leads', { p_workspace: workspace.id, p_filters: { q: leadSearch } }).select('id, business_name').limit(6);
      return (data ?? []) as Array<{ id: string; business_name: string }>;
    },
  });
  const candidates = mentionQuery !== null ? members.filter((m) => m.user_id !== userId && (m.profile.full_name || m.profile.email).toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6) : [];

  async function send() {
    if ((!text.trim() && !lead) || sending) return;
    setSending(true);
    const used = mentions.filter((id) => {
      const m = members.find((x) => x.user_id === id);
      return m && text.includes(`@${m.profile.full_name.split(' ')[0]}`);
    });
    const { error } = await getSupabase()
      .from('chat_messages')
      .insert({ workspace_id: workspace.id, channel_id: channel.id, author_id: userId, body: text.trim(), mentions: used, lead_id: lead?.id ?? null });
    setSending(false);
    if (error) return toast.error(errorMessage(error));
    setText('');
    setMentions([]);
    setLead(null);
    onSent();
  }

  return (
    <div className="relative border-t border-border p-3">
      {candidates.length > 0 && (
        <div className="absolute bottom-full left-3 mb-1 w-64 rounded-lg border border-border bg-surface p-1 shadow-lg">
          {candidates.map((m) => (
            <button
              key={m.user_id}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2"
              onMouseDown={(e) => {
                e.preventDefault();
                const first = m.profile.full_name.split(' ')[0] || m.profile.email;
                setText((t) => t.replace(/@[\wÀ-ɏ]*$/, `@${first} `));
                setMentions((x) => [...new Set([...x, m.user_id])]);
                setMentionQuery(null);
              }}
            >
              <Avatar name={m.profile.full_name} size="xs" /> {m.profile.full_name || m.profile.email}
            </button>
          ))}
        </div>
      )}
      {lead && (
        <div className="mb-2 inline-flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-1 text-xs">
          <Building2 className="size-3.5 text-primary" /> {lead.business_name}
          <button onClick={() => setLead(null)} className="text-subtle hover:text-foreground" aria-label="Remove lead">
            ×
          </button>
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-border bg-surface px-2 py-1.5 shadow-sm focus-within:border-primary focus-within:ring-[3px] focus-within:ring-ring/30">
        <Popover>
          <PopoverTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="Share a lead">
              <Building2 />
            </Button>
          </PopoverTrigger>
          <PopoverContent side="top" className="w-72 p-2">
            <Input inputSize="sm" autoFocus placeholder="Search a lead to share…" value={leadSearch} onChange={(e) => setLeadSearch(e.target.value)} />
            <div className="mt-1">
              {leads.data?.map((l) => (
                <button key={l.id} className="block w-full truncate rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2" onClick={() => setLead(l)}>
                  {l.business_name}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <textarea
          value={text}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            const m = e.target.value.match(/@([\wÀ-ɏ]*)$/);
            setMentionQuery(m ? m[1]! : null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={`Message ${channel.kind === 'dm' ? '' : '#'}${channel.name ?? 'your teammate'} — type @ to mention`}
          className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent py-2 text-[13.5px] outline-none placeholder:text-subtle"
        />
        <Button size="icon" variant="primary" onClick={send} loading={sending} disabled={!text.trim() && !lead} aria-label="Send">
          <Send />
        </Button>
      </div>
    </div>
  );
}

function PeoplePicker({ value, onChange, exclude = [] }: { value: string[]; onChange: (v: string[]) => void; exclude?: string[] }) {
  const { members } = useMembers();
  return (
    <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-xl border border-border">
      {members
        .filter((m) => !exclude.includes(m.user_id))
        .map((m) => (
          <label key={m.user_id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface-2/60">
            <Checkbox checked={value.includes(m.user_id)} onCheckedChange={(c) => onChange(c ? [...value, m.user_id] : value.filter((x) => x !== m.user_id))} />
            <Avatar name={m.profile.full_name || m.profile.email} size="sm" />
            <span className="text-[13px]">{m.profile.full_name || m.profile.email}</span>
          </label>
        ))}
    </div>
  );
}

function NewChannelDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const { workspace, userId } = useWorkspace();
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [priv, setPriv] = React.useState(false);
  const [people, setPeople] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setPriv(false);
      setPeople([]);
    }
  }, [open]);
  async function create() {
    const { data, error } = await getSupabase().rpc('chat_create_channel', { p_workspace: workspace.id, p_name: name, p_description: description, p_private: priv, p_member_ids: people });
    if (error) return toast.error(errorMessage(error).includes('chat_channels_name_uq') ? 'A channel with that name exists' : errorMessage(error));
    qc.invalidateQueries({ queryKey: ['chat-channels', workspace.id] });
    onOpenChange(false);
    onCreated(data as string);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" title="Create a channel" description="Group conversations for a team, a client or a campaign.">
        <DialogBody className="space-y-4">
          <Field label="Name">
            <Input autoFocus leading={<Hash />} value={name} onChange={(e) => setName(e.target.value)} placeholder="sales-lahore" />
          </Field>
          <Field label="What’s it about?" optional>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <SwitchRow label="Private channel" description="Only invited people can see it." checked={priv} onCheckedChange={setPriv} />
          <Field label="Add people">
            <PeoplePicker value={people} onChange={setPeople} exclude={[userId]} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={create} disabled={!name.trim()}>
            Create channel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewDmDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const { workspace, userId } = useWorkspace();
  const qc = useQueryClient();
  const [people, setPeople] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (open) setPeople([]);
  }, [open]);
  async function start() {
    const { data, error } = await getSupabase().rpc('chat_open_dm', { p_workspace: workspace.id, p_user_ids: people });
    if (error) return toast.error(errorMessage(error));
    qc.invalidateQueries({ queryKey: ['chat-channels', workspace.id] });
    onOpenChange(false);
    onCreated(data as string);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" title="New message" description="Pick one person, or several for a group conversation.">
        <DialogBody>
          <PeoplePicker value={people} onChange={setPeople} exclude={[userId]} />
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onClick={start} disabled={!people.length}>
            Start conversation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddMembersDialog({ open, onOpenChange, channel }: { open: boolean; onOpenChange: (o: boolean) => void; channel: ChannelRow }) {
  const qc = useQueryClient();
  const { workspace } = useWorkspace();
  const [people, setPeople] = React.useState<string[]>([]);
  async function add() {
    const { error } = await getSupabase().rpc('chat_add_members', { p_channel: channel.id, p_user_ids: people });
    if (error) return toast.error(errorMessage(error));
    qc.invalidateQueries({ queryKey: ['chat-channels', workspace.id] });
    setPeople([]);
    onOpenChange(false);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" title={`Add people to #${channel.name}`}>
        <DialogBody>
          <PeoplePicker value={people} onChange={setPeople} exclude={channel.members} />
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onClick={add} disabled={!people.length}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { shortDate };
