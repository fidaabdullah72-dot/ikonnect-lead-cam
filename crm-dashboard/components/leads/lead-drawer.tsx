'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRightLeft,
  Ban,
  CalendarClock,
  ExternalLink,
  Globe,
  Mail,
  MapPin,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  ShieldCheck,
  StickyNote,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { SOURCE_LABELS, formatPhone, type Activity, type Lead, type Message, type Task } from '@batsols/shared';
import { FacebookIcon, InstagramIcon, LinkedinIcon, WhatsAppIcon } from '@/components/brand';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Tag } from '@/components/ui/badge';
import { Dialog, SheetContent } from '@/components/ui/dialog';
import { Checkbox, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls';
import { EmptyState, Skeleton, useConfirm } from '@/components/ui/feedback';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from '@/components/ui/menu';
import { TagInput } from '@/components/ui/multi-select';
import { Composer, MessageThread, useReactToMessage, useSenderOf } from '@/components/whatsapp/chat';
import { LeadFormDialog } from './lead-form';
import { LandlineBadge, OwnerSelect, PhoneText, Rating, StageSelect, WaStatus } from './bits';
import { getSupabase } from '@/lib/supabase/client';
import { qk, useLeadFacets, useMembers, useRealtime, useStages } from '@/lib/queries';
import { useInvalidateLeads, useLead, useLeadTimeline, useUpdateLead, type TimelineItem } from '@/lib/leads';
import { useWorkspace } from '@/lib/workspace';
import { cn, errorMessage, formatMoney, fullDate, hostname, timeAgo } from '@/lib/utils';

export function LeadDrawer({ leadId, onClose, initialTab = 'activity' }: { leadId: string | null; onClose: () => void; initialTab?: string }) {
  return (
    <Dialog open={!!leadId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent width="max-w-[640px]" title="Lead details">
        {leadId && <LeadPanel leadId={leadId} onClose={onClose} initialTab={initialTab} />}
      </SheetContent>
    </Dialog>
  );
}

const NO_MESSAGES: Message[] = [];

function LeadPanel({ leadId, onClose, initialTab }: { leadId: string; onClose: () => void; initialTab: string }) {
  const { data: lead, isLoading } = useLead(leadId);
  const timeline = useLeadTimeline(leadId);
  const update = useUpdateLead();
  const invalidate = useInvalidateLeads();
  const confirm = useConfirm();
  const { can, workspace } = useWorkspace();
  const [tab, setTab] = React.useState(initialTab);
  const [editing, setEditing] = React.useState(false);
  const qc = useQueryClient();

  useRealtime('messages', `lead_id=eq.${leadId}`, [qk.leadTimeline(leadId)]);
  const timelineKeys = React.useMemo(() => [qk.leadTimeline(leadId)], [leadId]);
  const react = useReactToMessage({ invalidate: timelineKeys });
  const senderOf = useSenderOf(timeline.data?.messages ?? NO_MESSAGES);

  if (isLoading || !lead) {
    return (
      <div className="space-y-4 p-6">
        {isLoading ? (
          <>
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-64 w-full" />
          </>
        ) : (
          <EmptyState title="Lead not found" description="It may have been deleted." action={<Button onClick={onClose}>Close</Button>} />
        )}
      </div>
    );
  }

  const patch = (p: Partial<Lead>) => update.mutate({ id: lead.id, patch: p });

  async function remove() {
    if (!(await confirm({ title: `Delete ${lead!.business_name}?`, description: 'Notes, tasks, messages and campaign history for this lead are deleted too.', confirmLabel: 'Delete lead', danger: true }))) return;
    const { error } = await getSupabase().from('leads').delete().eq('id', lead!.id);
    if (error) return toast.error(errorMessage(error));
    toast.success('Lead deleted');
    invalidate();
    onClose();
  }

  const messages = timeline.data?.messages ?? [];
  const lastAccount = [...messages].reverse().find((m) => m.account_id)?.account_id ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border px-6 pb-4 pt-5">
        <div className="flex items-start gap-3.5">
          <Avatar name={lead.business_name} size="lg" square />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[17px] font-semibold tracking-[-0.015em]">{lead.business_name}</h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
              {lead.category && <span>{lead.category}</span>}
              {lead.category && lead.city && <span className="text-subtle">·</span>}
              {lead.city && <span>{lead.city}</span>}
              {lead.rating ? (
                <>
                  <span className="text-subtle">·</span>
                  <Rating rating={lead.rating} reviews={lead.reviews_count} />
                </>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {can.write && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="More">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-52">
                  <DropdownMenuItem onSelect={() => setEditing(true)}>
                    <Pencil /> Edit details
                  </DropdownMenuItem>
                  {lead.opted_out ? (
                    <DropdownMenuItem onSelect={() => patch({ opted_out: false })}>
                      <ShieldCheck /> Opt back in
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => patch({ opted_out: true })}>
                      <Ban /> Mark as opted out
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem danger onSelect={remove}>
                    <Trash2 /> Delete lead
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X />
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {lead.phone && (
            <>
              <Button size="sm" variant="whatsapp" onClick={() => setTab('chat')} disabled={lead.opted_out}>
                <WhatsAppIcon /> Message
              </Button>
              <Button size="sm" variant="secondary" asChild>
                <a href={`tel:+${lead.phone}`}>
                  <Phone /> Call
                </a>
              </Button>
            </>
          )}
          {lead.website && (
            <Button size="sm" variant="secondary" asChild>
              <a href={lead.website} target="_blank" rel="noreferrer">
                <Globe /> {hostname(lead.website)}
              </a>
            </Button>
          )}
          {lead.google_maps_url && (
            <Button size="sm" variant="ghost" asChild>
              <a href={lead.google_maps_url} target="_blank" rel="noreferrer">
                <MapPin /> Maps
              </a>
            </Button>
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-border bg-surface-2/40 p-3 sm:grid-cols-4">
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-subtle">Stage</div>
            <StageSelect value={lead.stage_id} onChange={(id) => patch({ stage_id: id })} disabled={!can.write} />
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-subtle">Owner</div>
            <OwnerSelect value={lead.owner_id} onChange={(id) => patch({ owner_id: id })} disabled={!can.write} />
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-subtle">Deal value</div>
            <DealValue value={lead.deal_value} currency={workspace.settings.currency} onSave={(v) => patch({ deal_value: v })} disabled={!can.write} />
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-subtle">WhatsApp</div>
            <div className="flex h-[26px] items-center gap-1.5">
              <WaStatus lead={lead} showLabel />
              {!lead.phone && <span className="text-xs text-subtle">No phone</span>}
            </div>
          </div>
        </div>
        {lead.opted_out && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">
            <Ban className="size-3.5" /> Opted out {timeAgo(lead.opted_out_at)} — excluded from all campaigns.
          </div>
        )}
      </div>

      {/* Body */}
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0 px-4">
          <TabsTrigger value="activity">
            <StickyNote /> Activity
          </TabsTrigger>
          <TabsTrigger value="chat">
            <MessageSquare /> Chat {messages.length > 0 && <span className="text-xs text-subtle">{messages.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="tasks">
            <CalendarClock /> Tasks
            {timeline.data && timeline.data.tasks.filter((t) => !t.completed_at).length > 0 && (
              <span className="text-xs text-subtle">{timeline.data.tasks.filter((t) => !t.completed_at).length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="details">
            <UserRound /> Details
          </TabsTrigger>
        </TabsList>

        <TabsContent value="activity" className="min-h-0 flex-1 overflow-y-auto">
          {can.write && <NoteComposer lead={lead} onAdded={() => qc.invalidateQueries({ queryKey: qk.leadTimeline(lead.id) })} />}
          <Timeline items={timeline.data?.timeline ?? []} loading={timeline.isLoading} lead={lead} />
        </TabsContent>

        <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
          <MessageThread
            messages={messages}
            className="min-h-0 flex-1 bg-surface-2/40"
            emptyHint={lead.phone ? `Start the conversation with ${lead.business_name}.` : 'Add a phone number to message this lead.'}
            onReact={can.write ? react : undefined}
            senderOf={senderOf}
          />
          <Composer lead={lead} defaultAccountId={lastAccount} />
        </TabsContent>

        <TabsContent value="tasks" className="min-h-0 flex-1 overflow-y-auto p-4">
          <LeadTasks lead={lead} tasks={timeline.data?.tasks ?? []} />
        </TabsContent>

        <TabsContent value="details" className="min-h-0 flex-1 overflow-y-auto p-6">
          <LeadDetails lead={lead} onEdit={() => setEditing(true)} onTags={(tags) => patch({ tags })} />
        </TabsContent>
      </Tabs>

      <LeadFormDialog open={editing} onOpenChange={setEditing} lead={lead} />
    </div>
  );
}

function DealValue({ value, currency, onSave, disabled }: { value: number; currency?: string; onSave: (v: number) => void; disabled?: boolean }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(String(value));
  if (editing) {
    return (
      <Input
        inputSize="sm"
        type="number"
        min={0}
        autoFocus
        className="h-[26px]"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const n = Math.max(0, Number(draft) || 0);
          if (n !== value) onSave(n);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        setDraft(String(value));
        setEditing(true);
      }}
      className={cn('flex h-[26px] items-center rounded-md px-1.5 text-[13px] font-medium tabular', !disabled && 'hover:bg-surface-2', !value && 'text-subtle')}
    >
      {value ? formatMoney(value, currency ?? 'USD') : 'Add value'}
    </button>
  );
}

function NoteComposer({ lead, onAdded }: { lead: Lead; onAdded: () => void }) {
  const { workspace, userId } = useWorkspace();
  const [body, setBody] = React.useState('');
  const add = useMutation({
    mutationFn: async () => {
      const { error } = await getSupabase().from('lead_notes').insert({ workspace_id: workspace.id, lead_id: lead.id, author_id: userId, body: body.trim() });
      if (error) throw error;
    },
    onSuccess: () => {
      setBody('');
      onAdded();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="border-b border-border p-4">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write a note… (call summary, requirements, next steps)"
        className="min-h-[64px]"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && body.trim()) add.mutate();
        }}
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-subtle">⌘ + Enter to save</span>
        <Button size="sm" variant="secondary" onClick={() => add.mutate()} disabled={!body.trim()} loading={add.isPending}>
          Add note
        </Button>
      </div>
    </div>
  );
}

function activityText(a: Activity, names: (id: unknown) => string): React.ReactNode {
  const d = a.data as Record<string, unknown>;
  switch (a.type) {
    case 'stage_changed':
      return (
        <>
          moved from <b className="font-medium text-foreground">{String(d.from_name ?? '—')}</b> to <b className="font-medium text-foreground">{String(d.to_name ?? '—')}</b>
        </>
      );
    case 'assigned':
      return d.to ? (
        <>
          assigned to <b className="font-medium text-foreground">{names(d.to)}</b>
        </>
      ) : (
        'unassigned the lead'
      );
    case 'opted_out':
      return 'opted out of messages';
    case 'campaign_added':
      return (
        <>
          added to campaign <b className="font-medium text-foreground">{String(d.campaign_name ?? '')}</b>
        </>
      );
    case 'wa_checked':
      return d.valid ? 'number verified on WhatsApp' : 'number is not on WhatsApp';
    case 'replied':
      return 'replied on WhatsApp';
    default:
      return a.type.replace(/_/g, ' ');
  }
}

function Timeline({ items, loading, lead }: { items: TimelineItem[]; loading: boolean; lead: Lead }) {
  const { byId } = useMembers();
  const name = (id: unknown) => {
    const m = typeof id === 'string' ? byId.get(id) : undefined;
    return m ? m.profile.full_name || m.profile.email : 'Someone';
  };
  if (loading) {
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    );
  }
  return (
    <ol className="relative px-6 py-5">
      <span className="absolute bottom-6 left-[35px] top-6 w-px bg-border" />
      {items.map((it) => {
        if (it.kind === 'note') {
          const n = it.item;
          return (
            <li key={`n-${n.id}`} className="relative mb-5 flex gap-3">
              <Avatar name={name(n.author_id)} size="sm" className="relative z-10 ring-4 ring-surface" />
              <div className="min-w-0 flex-1 rounded-xl border border-border bg-surface p-3 shadow-sm">
                <div className="mb-1 flex items-center gap-2 text-xs">
                  <span className="font-medium">{name(n.author_id)}</span>
                  <span className="text-subtle">added a note · {timeAgo(n.created_at)}</span>
                </div>
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{n.body}</p>
              </div>
            </li>
          );
        }
        if (it.kind === 'message') {
          const m = it.item;
          const out = m.direction === 'out';
          return (
            <li key={`m-${m.id}`} className="relative mb-4 flex gap-3">
              <span className={cn('relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full ring-4 ring-surface', out ? 'bg-whatsapp-soft text-whatsapp' : 'bg-info-soft text-info')}>
                <WhatsAppIcon className="size-3" />
              </span>
              <div className="min-w-0 flex-1 pt-0.5 text-[13px]">
                <span className="text-muted">
                  {out ? (m.campaign_id ? 'Campaign message sent' : `${name(m.sent_by)} sent a message`) : `${lead.business_name} replied`}
                  {m.status === 'failed' && <span className="text-danger"> · failed</span>} · {timeAgo(m.created_at)}
                </span>
                <div className="mt-1 line-clamp-3 whitespace-pre-wrap rounded-lg bg-surface-2/70 px-3 py-2 text-[13px]">{m.body || '[attachment]'}</div>
              </div>
            </li>
          );
        }
        const a = it.item;
        return (
          <li key={`a-${a.id}`} className="relative mb-4 flex gap-3">
            <span className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted ring-4 ring-surface">
              <ArrowRightLeft className="size-3" />
            </span>
            <div className="pt-0.5 text-[13px] text-muted">
              <span className="font-medium text-foreground">{a.actor_id ? name(a.actor_id) : 'BatWos'}</span> {activityText(a, name)}
              <span className="text-subtle"> · {timeAgo(a.created_at)}</span>
            </div>
          </li>
        );
      })}
      <li className="relative flex gap-3">
        <span className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary ring-4 ring-surface">
          <Plus className="size-3" />
        </span>
        <div className="pt-0.5 text-[13px] text-muted">
          Lead created from <span className="font-medium text-foreground">{SOURCE_LABELS[lead.source]}</span>
          {lead.created_by && <> by {name(lead.created_by)}</>}
          <span className="text-subtle"> · {timeAgo(lead.created_at)}</span>
        </div>
      </li>
    </ol>
  );
}

function LeadTasks({ lead, tasks }: { lead: Lead; tasks: Task[] }) {
  const { workspace, userId, can } = useWorkspace();
  const { members, byId } = useMembers();
  const qc = useQueryClient();
  const [title, setTitle] = React.useState('');
  const [due, setDue] = React.useState('');
  const [assignee, setAssignee] = React.useState(lead.owner_id ?? userId);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.leadTimeline(lead.id) });
    qc.invalidateQueries({ queryKey: qk.tasks(workspace.id) });
  };

  async function add() {
    if (!title.trim()) return;
    const { error } = await getSupabase()
      .from('tasks')
      .insert({ workspace_id: workspace.id, lead_id: lead.id, title: title.trim(), due_at: due ? new Date(due).toISOString() : null, assignee_id: assignee || null, created_by: userId });
    if (error) return toast.error(errorMessage(error));
    setTitle('');
    setDue('');
    refresh();
  }

  async function toggle(t: Task) {
    const { error } = await getSupabase().from('tasks').update({ completed_at: t.completed_at ? null : new Date().toISOString() }).eq('id', t.id);
    if (error) return toast.error(errorMessage(error));
    refresh();
  }

  return (
    <div className="space-y-4">
      {can.write && (
        <div className="rounded-xl border border-border bg-surface p-3 shadow-sm">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Follow up about pricing…" onKeyDown={(e) => e.key === 'Enter' && add()} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input type="datetime-local" inputSize="sm" className="w-auto" value={due} onChange={(e) => setDue(e.target.value)} />
            <NativeSelect inputSize="sm" className="w-auto" value={assignee ?? ''} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.profile.full_name || m.profile.email}
                </option>
              ))}
            </NativeSelect>
            <Button size="sm" variant="primary" className="ml-auto" onClick={add} disabled={!title.trim()}>
              Add task
            </Button>
          </div>
        </div>
      )}
      {tasks.length === 0 ? (
        <EmptyState compact icon={<CalendarClock />} title="No tasks" description="Add a reminder so this lead doesn’t go cold." />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {tasks.map((t) => {
            const overdue = !t.completed_at && t.due_at && new Date(t.due_at) < new Date();
            const who = t.assignee_id ? byId.get(t.assignee_id) : undefined;
            return (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2.5">
                <Checkbox checked={!!t.completed_at} onCheckedChange={() => toggle(t)} disabled={!can.write} />
                <div className="min-w-0 flex-1">
                  <div className={cn('text-[13px]', t.completed_at && 'text-subtle line-through')}>{t.title}</div>
                  <div className="flex items-center gap-2 text-[11.5px] text-subtle">
                    {t.due_at && <span className={cn(overdue && 'font-medium text-danger')}>{fullDate(t.due_at)}</span>}
                    {who && <span>· {who.profile.full_name || who.profile.email}</span>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function DetailRow({ icon: Icon, label, children }: { icon: React.ElementType; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-subtle" />
      <div className="w-28 shrink-0 text-[13px] text-muted">{label}</div>
      <div className="min-w-0 flex-1 break-words text-[13px]">{children}</div>
    </div>
  );
}

function LeadDetails({ lead, onEdit, onTags }: { lead: Lead; onEdit: () => void; onTags: (tags: string[]) => void }) {
  const { can } = useWorkspace();
  const facets = useLeadFacets();
  const { byId: stageById } = useStages();
  const socials = Object.entries(lead.socials ?? {}).filter(([, v]) => v);
  const socialIcon: Record<string, React.ElementType> = { facebook: FacebookIcon, instagram: InstagramIcon, linkedin: LinkedinIcon };
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold">Contact details</h3>
        {can.write && (
          <Button size="xs" variant="ghost" onClick={onEdit}>
            <Pencil /> Edit
          </Button>
        )}
      </div>
      <div className="divide-y divide-border">
        <DetailRow icon={Phone} label="Phone">
          <div className="flex items-center gap-2">
            <PhoneText phone={lead.phone} copy />
            {lead.phone_type === 'landline' && <LandlineBadge />}
          </div>
          {lead.phone_raw && lead.phone && formatPhone(lead.phone) !== lead.phone_raw && <div className="text-xs text-subtle">Original: {lead.phone_raw}</div>}
        </DetailRow>
        <DetailRow icon={UserRound} label="Contact">
          {lead.contact_name || <span className="text-subtle">—</span>}
        </DetailRow>
        <DetailRow icon={Mail} label="Email">
          {lead.email ? (
            <a className="text-primary hover:underline" href={`mailto:${lead.email}`}>
              {lead.email}
            </a>
          ) : (
            <span className="text-subtle">—</span>
          )}
        </DetailRow>
        <DetailRow icon={Globe} label="Website">
          {lead.website ? (
            <a className="inline-flex items-center gap-1 text-primary hover:underline" href={lead.website} target="_blank" rel="noreferrer">
              {hostname(lead.website)} <ExternalLink className="size-3" />
            </a>
          ) : (
            <span className="text-subtle">No website</span>
          )}
        </DetailRow>
        <DetailRow icon={MapPin} label="Address">
          {lead.address || <span className="text-subtle">—</span>}
        </DetailRow>
        {socials.length > 0 && (
          <DetailRow icon={Globe} label="Social">
            <div className="flex flex-wrap gap-2">
              {socials.map(([k, v]) => {
                const Icon = socialIcon[k] ?? Globe;
                return (
                  <Tooltip key={k} content={String(v)}>
                    <a href={String(v)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-1 text-xs capitalize hover:bg-surface-3">
                      <Icon className="size-3" /> {k}
                    </a>
                  </Tooltip>
                );
              })}
            </div>
          </DetailRow>
        )}
      </div>

      <h3 className="mb-2 mt-6 text-[14px] font-semibold">Tags</h3>
      {can.write ? (
        <TagInput value={lead.tags} onChange={onTags} suggestions={facets.data?.tags.map((t) => t.value)} />
      ) : (
        <div className="flex flex-wrap gap-1">{lead.tags.length ? lead.tags.map((t) => <Tag key={t}>{t}</Tag>) : <span className="text-[13px] text-subtle">No tags</span>}</div>
      )}

      <h3 className="mb-2 mt-6 text-[14px] font-semibold">Record</h3>
      <div className="grid grid-cols-2 gap-3 text-[13px]">
        {[
          ['Source', SOURCE_LABELS[lead.source]],
          ['Stage', lead.stage_id ? stageById.get(lead.stage_id)?.name : '—'],
          ['Created', fullDate(lead.created_at)],
          ['Last contacted', lead.last_contacted_at ? fullDate(lead.last_contacted_at) : 'Never'],
          ['Last reply', lead.last_replied_at ? fullDate(lead.last_replied_at) : 'Never'],
          ['WhatsApp checked', lead.wa_checked_at ? fullDate(lead.wa_checked_at) : 'Not yet'],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-border px-3 py-2">
            <div className="text-[11px] uppercase tracking-wider text-subtle">{k}</div>
            <div className="mt-0.5 truncate">{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
