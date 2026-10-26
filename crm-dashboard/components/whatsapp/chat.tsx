'use client';

import * as React from 'react';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { AlertCircle, Bot, Check, CheckCheck, Clock, FileText, ImageIcon, Send, SmilePlus, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { buildTemplateVars, renderTemplate, type Lead, type Message, type MessageTemplate } from '@batsols/shared';
import { WhatsAppIcon } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from '@/components/ui/menu';
import { getSupabase } from '@/lib/supabase/client';
import { qk, useAccounts, useEngineStatus, useMembers, useUsableAccounts } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, dayLabel, errorMessage, fullDate } from '@/lib/utils';
import { format, isSameDay } from 'date-fns';

export function MessageTicks({ status, className }: { status: Message['status']; className?: string }) {
  const map: Record<Message['status'], { icon: React.ElementType; cls: string; label: string }> = {
    queued: { icon: Clock, cls: 'text-subtle', label: 'Queued — waiting for the engine' },
    sending: { icon: Clock, cls: 'text-subtle', label: 'Sending…' },
    sent: { icon: Check, cls: 'text-subtle', label: 'Sent' },
    delivered: { icon: CheckCheck, cls: 'text-subtle', label: 'Delivered' },
    read: { icon: CheckCheck, cls: 'text-[#34b7f1]', label: 'Read' },
    failed: { icon: AlertCircle, cls: 'text-danger', label: 'Failed' },
    received: { icon: Check, cls: 'text-subtle', label: 'Received' },
  };
  const m = map[status];
  return (
    <Tooltip content={m.label}>
      <m.icon className={cn('size-3.5', m.cls, className)} />
    </Tooltip>
  );
}

function MediaChip({ m }: { m: Message }) {
  if (!m.media_type) return null;
  const Icon = m.media_type === 'image' ? ImageIcon : FileText;
  const label = m.media_name || (m.media_type === 'image' ? 'Photo' : m.media_type === 'audio' ? 'Voice note' : m.media_type === 'sticker' ? 'Sticker' : 'Attachment');
  const inner = (
    <span className="mb-1 flex items-center gap-1.5 rounded-md bg-black/5 px-2 py-1.5 text-xs dark:bg-white/5">
      <Icon className="size-3.5" />
      <span className="truncate">{label}</span>
    </span>
  );
  return m.media_url ? (
    <a href={m.media_url} target="_blank" rel="noreferrer" className="block">
      {m.media_type === 'image' ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={m.media_url} alt="" className="mb-1 max-h-56 rounded-lg object-cover" />
      ) : (
        inner
      )}
    </a>
  ) : (
    inner
  );
}

const WA_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/**
 * Names who sent each outgoing message: the teammate who typed it, the campaign
 * (and who runs it), or the number's owner when it was sent from the phone.
 */
export function useSenderOf(messages: Message[]) {
  const { userId } = useWorkspace();
  const { byId: members } = useMembers();
  const { byId: accounts } = useAccounts();
  const campaignIds = React.useMemo(() => [...new Set(messages.map((m) => m.campaign_id).filter((id): id is string => !!id))].sort(), [messages]);
  const { data: campaigns } = useQuery({
    queryKey: ['campaign-names', campaignIds],
    enabled: campaignIds.length > 0,
    queryFn: async () => {
      const { data } = await getSupabase().from('campaigns').select('id, name, created_by').in('id', campaignIds);
      return new Map((data ?? []).map((c) => [c.id, c]));
    },
    staleTime: 5 * 60_000,
  });
  return React.useCallback(
    (m: Message): string | null => {
      if (m.direction !== 'out') return null;
      const name = (id: string | null | undefined) =>
        !id ? null : id === userId ? 'You' : members.get(id)?.profile.full_name || members.get(id)?.profile.email || 'Former teammate';
      if (m.sent_by) return name(m.sent_by);
      if (m.campaign_id) {
        const c = campaigns?.get(m.campaign_id);
        const by = name(c?.created_by);
        return c ? `Campaign “${c.name}”${by ? ` · ${by}` : ''}` : 'Campaign';
      }
      const owner = m.account_id ? accounts.get(m.account_id)?.owner_id : null;
      return owner ? `${name(owner)} · from the phone` : null;
    },
    [userId, members, accounts, campaigns],
  );
}

export type ReactHandler = (m: Message, emoji: string) => void;

/** React to WhatsApp messages from the dashboard; the engine sends the reaction from the same number. */
export function useReactToMessage(opts: { optimisticKey?: QueryKey; invalidate?: QueryKey[] }): ReactHandler {
  const qc = useQueryClient();
  const { optimisticKey, invalidate } = opts;
  return React.useCallback(
    async (m: Message, emoji: string) => {
      if (optimisticKey) {
        qc.setQueryData<Message[]>(optimisticKey, (list) => list?.map((x) => (x.id === m.id ? { ...x, reaction_out: emoji || null, reaction_out_pending: true } : x)));
      }
      const { error } = await getSupabase().rpc('message_react', { p_message: m.id, p_emoji: emoji });
      if (error) toast.error(errorMessage(error));
      for (const k of [...(optimisticKey && error ? [optimisticKey] : []), ...(invalidate ?? [])]) qc.invalidateQueries({ queryKey: k });
    },
    [qc, optimisticKey, invalidate],
  );
}

function ReactionPicker({ m, onReact, side }: { m: Message; onReact: ReactHandler; side: 'left' | 'right' }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="React"
          className={cn(
            'shrink-0 rounded-full p-1 text-subtle transition-opacity hover:bg-surface-2 hover:text-foreground focus-visible:opacity-100',
            open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
          <SmilePlus className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align={side === 'left' ? 'end' : 'start'} className="flex gap-0.5 rounded-full p-1">
        {WA_REACTIONS.map((e) => (
          <button
            key={e}
            type="button"
            aria-label={`React ${e}`}
            className={cn('rounded-full p-1.5 text-lg leading-none transition-transform hover:scale-125 hover:bg-surface-2', m.reaction_out === e && 'bg-primary-soft')}
            onClick={() => {
              setOpen(false);
              onReact(m, m.reaction_out === e ? '' : e);
            }}
          >
            {e}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** sender: who sent an outgoing message (“You”, “Ali”, “Campaign “Promo” · Ali”), shown on the bubble. */
export function MessageBubble({ m, showCampaign, onReact, sender }: { m: Message; showCampaign?: boolean; onReact?: ReactHandler; sender?: string | null }) {
  const out = m.direction === 'out';
  const canReact = Boolean(onReact && m.wa_message_id && m.status !== 'failed');
  const hasReactions = Boolean(m.reaction_in || m.reaction_out);
  return (
    <div className={cn('group flex items-center gap-1', out ? 'justify-end' : 'justify-start', hasReactions && 'pb-3')}>
      {out && canReact && <ReactionPicker m={m} onReact={onReact!} side="left" />}
      <div
        className={cn(
          'relative max-w-[78%] rounded-2xl px-3 py-2 text-[13.5px] leading-relaxed shadow-sm',
          out ? 'rounded-br-md bg-[#d9fdd3] text-[#111b21] dark:bg-[#144d37] dark:text-[#e9edef]' : 'rounded-bl-md border border-border bg-surface text-foreground',
          m.status === 'failed' && 'ring-1 ring-danger/50',
        )}
      >
        {out && sender && <div className="mb-0.5 text-[11px] font-semibold text-[#027eb5] dark:text-[#53bdeb]">{sender}</div>}
        <MediaChip m={m} />
        {m.body && <div className="whitespace-pre-wrap break-words">{m.body}</div>}
        <div className={cn('mt-1 flex items-center justify-end gap-1.5 text-[10.5px]', out ? 'text-[#667781] dark:text-[#8696a0]' : 'text-subtle')}>
          {!out && m.auto_reply && (
            <Tooltip content="A WhatsApp Business greeting or away message sent by their phone. Not counted as a reply.">
              <span className="inline-flex items-center gap-0.5">
                <Bot className="size-2.5" /> automatic reply
              </span>
            </Tooltip>
          )}
          {showCampaign && m.campaign_id && !sender && (
            <span className="inline-flex items-center gap-0.5">
              <Sparkles className="size-2.5" /> campaign
            </span>
          )}
          <Tooltip content={fullDate(m.created_at)}>
            <span>{format(new Date(m.created_at), 'HH:mm')}</span>
          </Tooltip>
          {out && <MessageTicks status={m.status} className="size-3" />}
        </div>
        {m.status === 'failed' && m.error && <div className="mt-1 text-[11px] text-danger">{m.error}</div>}
        {hasReactions && (
          <div className={cn('absolute -bottom-3.5 flex items-center gap-0.5 rounded-full border border-border bg-surface px-1.5 py-0.5 text-[13px] leading-none shadow-sm', out ? 'right-2' : 'left-2')}>
            {m.reaction_in && (
              <Tooltip content="Lead reacted">
                <span>{m.reaction_in}</span>
              </Tooltip>
            )}
            {m.reaction_out && (
              <Tooltip content={m.reaction_out_pending ? 'Sending your reaction…' : onReact ? 'You reacted · click to remove' : 'You reacted'}>
                <button
                  type="button"
                  disabled={!onReact}
                  onClick={() => onReact?.(m, '')}
                  className={cn('leading-none', m.reaction_out_pending && 'opacity-50', !onReact && 'cursor-default')}
                >
                  {m.reaction_out}
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </div>
      {!out && canReact && <ReactionPicker m={m} onReact={onReact!} side="right" />}
    </div>
  );
}

export function MessageThread({
  messages,
  className,
  emptyHint,
  onReact,
  senderOf,
}: {
  messages: Message[];
  className?: string;
  emptyHint?: React.ReactNode;
  onReact?: ReactHandler;
  /** Names the sender of outgoing messages (shown on each bubble). */
  senderOf?: (m: Message) => string | null;
}) {
  const endRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  if (!messages.length) {
    return (
      <div className={cn('flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-[13px] text-muted', className)}>
        <WhatsAppIcon className="size-8 text-whatsapp/60" />
        {emptyHint ?? 'No messages yet.'}
      </div>
    );
  }
  return (
    <div className={cn('space-y-1.5 overflow-y-auto px-4 py-4', className)}>
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const newDay = !prev || !isSameDay(new Date(prev.created_at), new Date(m.created_at));
        return (
          <React.Fragment key={m.id}>
            {newDay && (
              <div className="sticky top-0 z-10 flex justify-center py-2">
                <Tooltip content={format(new Date(m.created_at), 'EEEE, d MMMM yyyy')}>
                  <span className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-muted shadow-sm">{dayLabel(m.created_at)}</span>
                </Tooltip>
              </div>
            )}
            <MessageBubble m={m} showCampaign onReact={onReact} sender={senderOf?.(m)} />
          </React.Fragment>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

export function useTemplates() {
  const { workspace } = useWorkspace();
  return useQuery({
    queryKey: qk.templates(workspace.id),
    queryFn: async () => {
      const { data, error } = await getSupabase().from('message_templates').select('*').eq('workspace_id', workspace.id).order('name');
      if (error) throw error;
      return data as MessageTemplate[];
    },
  });
}

export function TemplatePicker({ lead, onPick }: { lead?: Pick<Lead, 'business_name' | 'contact_name' | 'city' | 'category' | 'website' | 'address' | 'rating' | 'reviews_count'>; onPick: (text: string) => void }) {
  const { data: templates = [] } = useTemplates();
  const { profile, workspace } = useWorkspace();
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Insert template">
          <FileText />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 p-1">
        <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-subtle">Insert template</div>
        {templates.length === 0 && <div className="px-2 py-4 text-center text-[13px] text-muted">No templates yet. Create them under Templates.</div>}
        <div className="max-h-72 overflow-y-auto">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              className="block w-full rounded-md px-2 py-2 text-left hover:bg-surface-2"
              onClick={() => {
                const vars = lead
                  ? buildTemplateVars(lead, { sender_name: profile.full_name, company_name: workspace.settings.company_name ?? workspace.name })
                  : {};
                onPick(renderTemplate(t.body, vars));
                setOpen(false);
              }}
            >
              <div className="text-[13px] font-medium">{t.name}</div>
              <div className="line-clamp-2 text-xs text-muted">{t.body}</div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Queue an outbound WhatsApp message. The engine sends it and updates its status. */
export function Composer({
  lead,
  defaultAccountId,
  lockAccount,
  onSent,
  className,
}: {
  lead: Lead;
  defaultAccountId?: string | null;
  lockAccount?: boolean;
  onSent?: () => void;
  className?: string;
}) {
  const { workspace, userId, can } = useWorkspace();
  const { accounts, connected } = useUsableAccounts();
  const engine = useEngineStatus();
  const qc = useQueryClient();
  const [text, setText] = React.useState('');
  const [accountId, setAccountId] = React.useState<string>(defaultAccountId ?? '');
  const [sending, setSending] = React.useState(false);

  React.useEffect(() => {
    if (defaultAccountId) setAccountId(defaultAccountId);
    else if (!accountId && connected[0]) setAccountId(connected[0].id);
  }, [defaultAccountId, connected, accountId]);

  if (!can.write) return null;
  if (!lead.phone) return <div className={cn('border-t border-border px-4 py-3 text-[13px] text-muted', className)}>This lead has no phone number.</div>;
  if (lead.opted_out)
    return <div className={cn('border-t border-border px-4 py-3 text-[13px] text-warning', className)}>This lead opted out of messages. Opt them back in from the lead menu to message them.</div>;
  if (!accounts.length)
    return (
      <div className={cn('border-t border-border px-4 py-3 text-[13px] text-muted', className)}>
        Connect a WhatsApp number first — <a className="font-medium text-primary hover:underline" href="/whatsapp?connect=1">connect now</a>.
      </div>
    );

  async function send() {
    const body = text.trim();
    if (!body || !accountId) return;
    setSending(true);
    const { error } = await getSupabase().from('messages').insert({
      workspace_id: workspace.id,
      lead_id: lead.id,
      account_id: accountId,
      direction: 'out',
      body,
      status: 'queued',
      sent_by: userId,
    });
    setSending(false);
    if (error) {
      toast.error(errorMessage(error));
      return;
    }
    setText('');
    qc.invalidateQueries({ queryKey: qk.leadTimeline(lead.id) });
    qc.invalidateQueries({ queryKey: qk.conversations(workspace.id) });
    if (!engine.online) toast.warning('Queued. The engine is offline, so it will send once the engine is running.');
    onSent?.();
  }

  const selected = accounts.find((a) => a.id === accountId);

  return (
    <div className={cn('border-t border-border bg-surface p-3', className)}>
      <div className="rounded-xl border border-border bg-surface shadow-sm focus-within:border-primary focus-within:ring-[3px] focus-within:ring-ring/30">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={`Message ${lead.business_name}…`}
          className="block max-h-48 min-h-[56px] w-full resize-none bg-transparent px-3 py-2.5 text-[13.5px] outline-none placeholder:text-subtle"
        />
        <div className="flex items-center gap-2 border-t border-border px-2 py-1.5">
          <TemplatePicker lead={lead} onPick={(t) => setText(t)} />
          {!lockAccount && accounts.length > 1 ? (
            <NativeSelect inputSize="sm" className="h-7 w-auto max-w-[200px] border-transparent bg-transparent text-xs shadow-none" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  From: {a.label}
                  {a.status !== 'connected' ? ' (offline)' : ''}
                </option>
              ))}
            </NativeSelect>
          ) : (
            selected && <span className="truncate px-1 text-xs text-subtle">From: {selected.label}</span>
          )}
          {selected && selected.status !== 'connected' && <span className="text-xs text-warning">Number offline — will send when it reconnects</span>}
          <Button size="sm" variant="whatsapp" className="ml-auto" onClick={send} loading={sending} disabled={!text.trim() || !accountId}>
            <Send /> Send
          </Button>
        </div>
      </div>
      <div className="mt-1.5 px-1 text-[11px] text-subtle">Enter to send · Shift+Enter for a new line</div>
    </div>
  );
}
