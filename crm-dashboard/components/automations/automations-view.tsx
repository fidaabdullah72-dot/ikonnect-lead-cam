'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Bot, CheckSquare, History, KanbanSquare, MessageSquareReply, MoreHorizontal, Pencil, Plus, Share2, Tag, Trash2, UserPlus, Workflow, Zap } from 'lucide-react';
import { toast } from 'sonner';
import type { Automation, AutomationAction, AutomationConditions, AutomationRun, AutomationTrigger } from '@batsols/shared';
import { Page } from '@/components/shell/app-shell';
import { ShareDialog } from '@/components/access/share-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch, SwitchRow } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter, SheetContent } from '@/components/ui/dialog';
import { EmptyState, useConfirm } from '@/components/ui/feedback';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/layout';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/menu';
import { TagInput } from '@/components/ui/multi-select';
import { useTemplates } from '@/components/whatsapp/chat';
import { getSupabase } from '@/lib/supabase/client';
import { useMembers, useStages } from '@/lib/queries';
import { useAllGrants } from '@/lib/access';
import { useWorkspace } from '@/lib/workspace';
import { cn, errorMessage, timeAgo } from '@/lib/utils';

const TRIGGERS: Record<AutomationTrigger, { label: string; icon: React.ElementType; text: string }> = {
  reply_received: { label: 'A lead replies', icon: MessageSquareReply, text: 'Any WhatsApp reply from a lead' },
  keyword: { label: 'Reply contains a keyword', icon: Zap, text: 'e.g. “price”, “interested”, “call me”' },
  stage_changed: { label: 'Lead moves stage', icon: KanbanSquare, text: 'Someone (or something) changes the pipeline stage' },
  campaign_no_reply: { label: 'Campaign ends without a reply', icon: History, text: 'After the last follow-up, no answer' },
  lead_created: { label: 'New lead is added', icon: UserPlus, text: 'From the finder, an import or an inbound chat' },
};

const ACTIONS: Record<AutomationAction['type'], { label: string; icon: React.ElementType }> = {
  send_template: { label: 'Send a template', icon: MessageSquareReply },
  send_text: { label: 'Send a message', icon: MessageSquareReply },
  move_stage: { label: 'Move to stage', icon: KanbanSquare },
  assign: { label: 'Assign lead', icon: UserPlus },
  add_tag: { label: 'Add tag', icon: Tag },
  create_task: { label: 'Create task', icon: CheckSquare },
  notify: { label: 'Notify', icon: Bell },
};

const PRESETS: Array<{ name: string; trigger: AutomationTrigger; conditions: AutomationConditions; actions: AutomationAction[] }> = [
  {
    name: 'Reply outside working hours',
    trigger: 'reply_received',
    conditions: { first_reply_only: false, outside_hours: { start: '09:00', end: '19:00', days: [1, 2, 3, 4, 5, 6], timezone: 'Asia/Karachi' } },
    actions: [{ type: 'send_text', body: 'Thanks for your message, {{business_name}}! Our team is offline right now and will reply first thing in the morning.' }],
  },
  {
    name: '“Price” → notify owner + task',
    trigger: 'keyword',
    conditions: { keywords: ['price', 'pricing', 'cost', 'rate', 'charges'], match: 'any' },
    actions: [
      { type: 'notify', target: 'owner', message: '💰 {{business_name}} asked about pricing' },
      { type: 'create_task', title: 'Send pricing to {{business_name}}', due_in_hours: 2, assignee: 'owner' },
    ],
  },
  {
    name: 'First reply → follow-up task',
    trigger: 'reply_received',
    conditions: { first_reply_only: true },
    actions: [
      { type: 'create_task', title: 'Follow up with {{business_name}}', due_in_hours: 24, assignee: 'owner' },
      { type: 'add_tag', tag: 'engaged' },
    ],
  },
  {
    name: 'Round-robin new inbound leads',
    trigger: 'lead_created',
    conditions: { sources: ['inbound'] },
    actions: [{ type: 'assign', user_id: 'round_robin' }],
  },
];

function useAutomations() {
  const { workspace } = useWorkspace();
  return useQuery({
    queryKey: ['automations', workspace.id],
    queryFn: async () => {
      const { data, error } = await getSupabase().from('automations').select('*').eq('workspace_id', workspace.id).order('created_at');
      if (error) throw error;
      return data as Automation[];
    },
  });
}

export function AutomationsView() {
  const { workspace, userId, can } = useWorkspace();
  const { data: autos = [] } = useAutomations();
  const grants = useAllGrants();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = React.useState<Partial<Automation> | null>(null);
  const [share, setShare] = React.useState<Automation | null>(null);
  const [runs, setRuns] = React.useState<Automation | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['automations', workspace.id] });
  const canManage = (a: Automation) => can.admin || a.owner_id === userId;

  async function toggle(a: Automation, enabled: boolean) {
    const { error } = await getSupabase().from('automations').update({ enabled }).eq('id', a.id);
    if (error) return toast.error(errorMessage(error));
    refresh();
  }
  async function remove(a: Automation) {
    if (!(await confirm({ title: `Delete “${a.name}”?`, confirmLabel: 'Delete', danger: true }))) return;
    await getSupabase().from('automations').delete().eq('id', a.id);
    refresh();
  }

  return (
    <Page>
      <PageHeader
        icon={<Workflow />}
        title="Automations"
        description="When something happens to a lead, BatWos does the next step for you — instantly, 24/7."
        actions={
          can.write && (
            <Button variant="primary" onClick={() => setEditing({ trigger: 'keyword', conditions: {}, actions: [], enabled: true })}>
              <Plus /> New automation
            </Button>
          )
        }
      />
      {can.write && (
        <div className="mb-6">
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-subtle">Start from a recipe</div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {PRESETS.map((p) => {
              const T = TRIGGERS[p.trigger];
              return (
                <button key={p.name} onClick={() => setEditing({ ...p, conditions: p.conditions.outside_hours ? { ...p.conditions, outside_hours: { ...p.conditions.outside_hours, timezone: workspace.timezone } } : p.conditions, enabled: true })} className="rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:border-primary hover:bg-primary-soft/40">
                  <T.icon className="size-4 text-primary" />
                  <div className="mt-2 text-[13.5px] font-semibold">{p.name}</div>
                  <div className="mt-0.5 text-xs text-muted">{p.actions.map((a) => ACTIONS[a.type].label).join(' → ')}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {!autos.length ? (
        <Card>
          <EmptyState icon={<Bot />} title="No automations yet" description="Pick a recipe above or build your own rule." />
        </Card>
      ) : (
        <div className="space-y-3">
          {autos.map((a) => {
            const T = TRIGGERS[a.trigger];
            const assigned = (grants.data ?? []).filter((g) => g.resource_type === 'automation' && g.resource_id === a.id).length;
            return (
              <Card key={a.id} className="flex flex-wrap items-center gap-4 p-4">
                <span className={cn('flex size-10 items-center justify-center rounded-xl', a.enabled ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-subtle')}>
                  <T.icon className="size-4.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-semibold">{a.name}</span>
                    {a.owner_id ? <Badge tone="outline">Personal</Badge> : assigned ? <Badge tone="info">Assigned to {assigned}</Badge> : <Badge tone="primary">Whole team</Badge>}
                  </div>
                  <div className="mt-0.5 text-[12.5px] text-muted">
                    <b className="font-medium text-foreground">When</b> {T.label.toLowerCase()}
                    {a.trigger === 'keyword' && a.conditions.keywords?.length ? ` (${a.conditions.keywords.join(', ')})` : ''} <b className="font-medium text-foreground">then</b> {a.actions.map((x) => ACTIONS[x.type].label.toLowerCase()).join(', ') || 'nothing yet'}
                  </div>
                </div>
                <button onClick={() => setRuns(a)} className="text-right text-xs text-muted hover:text-foreground">
                  <div className="font-semibold tabular text-foreground">{a.run_count} runs</div>
                  {a.last_run_at ? `last ${timeAgo(a.last_run_at)}` : 'never run'}
                </button>
                <Switch checked={a.enabled} onCheckedChange={(v) => toggle(a, v)} disabled={!canManage(a)} aria-label="Enabled" />
                {canManage(a) && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon-sm" variant="ghost" aria-label="Automation actions">
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem onSelect={() => setEditing(a)}>
                        <Pencil /> Edit
                      </DropdownMenuItem>
                      {!a.owner_id && can.admin && (
                        <DropdownMenuItem onSelect={() => setShare(a)}>
                          <Share2 /> Assign to members / teams
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onSelect={() => setRuns(a)}>
                        <History /> Run history
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem danger onSelect={() => remove(a)}>
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </Card>
            );
          })}
        </div>
      )}
      <AutomationDialog value={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      {share && <ShareDialog open onOpenChange={(o) => !o && setShare(null)} type="automation" resourceId={share.id} resourceName={share.name} />}
      <RunsSheet automation={runs} onClose={() => setRuns(null)} />
    </Page>
  );
}

function AutomationDialog({ value, onClose, onSaved }: { value: Partial<Automation> | null; onClose: () => void; onSaved: () => void }) {
  const { workspace, userId, can } = useWorkspace();
  const { stages } = useStages();
  const { members } = useMembers();
  const { data: templates = [] } = useTemplates();
  const [a, setA] = React.useState<Partial<Automation>>({});
  const [scope, setScope] = React.useState<'team' | 'personal'>('team');
  React.useEffect(() => {
    if (value) {
      setA(value);
      setScope(value.owner_id || !can.admin ? 'personal' : 'team');
    }
  }, [value, can.admin]);
  const c = a.conditions ?? {};
  const setC = (patch: Partial<AutomationConditions>) => setA((x) => ({ ...x, conditions: { ...(x.conditions ?? {}), ...patch } }));
  const actions = a.actions ?? [];
  const setAction = (i: number, next: AutomationAction) => setA((x) => ({ ...x, actions: (x.actions ?? []).map((y, j) => (j === i ? next : y)) }));

  async function save() {
    if (!a.name?.trim()) return toast.error('Name the automation');
    if (!a.trigger) return toast.error('Pick when it runs');
    if (a.trigger === 'keyword' && !c.keywords?.length) return toast.error('Add at least one keyword');
    if (!actions.length) return toast.error('Add at least one action');
    const incomplete = actions.find(
      (x) =>
        (x.type === 'send_template' && !x.template_id) ||
        (x.type === 'send_text' && !x.body.trim()) ||
        (x.type === 'move_stage' && !x.stage_id) ||
        (x.type === 'add_tag' && !x.tag.trim()) ||
        (x.type === 'create_task' && !x.title.trim()),
    );
    if (incomplete) return toast.error(`Finish the “${ACTIONS[incomplete.type].label}” step`);
    const sb = getSupabase();
    const row = { name: a.name.trim(), trigger: a.trigger!, conditions: c, actions, enabled: a.enabled ?? true };
    const { error } = a.id
      ? await sb.from('automations').update(row).eq('id', a.id)
      : await sb.from('automations').insert({ ...row, workspace_id: workspace.id, created_by: userId, owner_id: scope === 'personal' ? userId : null });
    if (error) return toast.error(errorMessage(error));
    toast.success('Automation saved');
    onSaved();
    onClose();
  }

  const newAction = (type: AutomationAction['type']): AutomationAction => {
    switch (type) {
      case 'send_template':
        return { type, template_id: templates[0]?.id ?? '' };
      case 'send_text':
        return { type, body: '' };
      case 'move_stage':
        return { type, stage_id: stages[0]?.id ?? '' };
      case 'assign':
        return { type, user_id: 'round_robin' };
      case 'add_tag':
        return { type, tag: '' };
      case 'create_task':
        return { type, title: 'Follow up with {{business_name}}', due_in_hours: 24, assignee: 'owner' };
      case 'notify':
        return { type, target: 'owner' };
    }
  };

  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg" title={a.id ? 'Edit automation' : 'New automation'}>
        <DialogBody className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
            <Field label="Name">
              <Input autoFocus value={a.name ?? ''} onChange={(e) => setA({ ...a, name: e.target.value })} placeholder="Price question → notify owner" />
            </Field>
            {!a.id && can.admin && (
              <Field label="Applies to">
                <NativeSelect value={scope} onChange={(e) => setScope(e.target.value as 'team' | 'personal')}>
                  <option value="team">Whole team</option>
                  <option value="personal">Only my leads & numbers</option>
                </NativeSelect>
              </Field>
            )}
          </div>
          <Card className="space-y-3 p-4">
            <div className="text-[12px] font-semibold uppercase tracking-wider text-subtle">When</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {(Object.keys(TRIGGERS) as AutomationTrigger[]).map((t) => {
                const T = TRIGGERS[t];
                return (
                  <button key={t} type="button" onClick={() => setA({ ...a, trigger: t })} className={cn('flex gap-3 rounded-lg border p-3 text-left', a.trigger === t ? 'border-primary bg-primary-soft' : 'border-border hover:border-border-strong')}>
                    <T.icon className="mt-0.5 size-4 text-primary" />
                    <span>
                      <span className="block text-[13px] font-medium">{T.label}</span>
                      <span className="block text-xs text-muted">{T.text}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {a.trigger === 'keyword' && (
              <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
                <Field label="Keywords">
                  <TagInput value={c.keywords ?? []} onChange={(v) => setC({ keywords: v })} placeholder="price" />
                </Field>
                <Field label="Match">
                  <NativeSelect value={c.match ?? 'any'} onChange={(e) => setC({ match: e.target.value as 'any' | 'exact' })}>
                    <option value="any">Contains word</option>
                    <option value="exact">Whole reply equals</option>
                  </NativeSelect>
                </Field>
              </div>
            )}
            {a.trigger === 'stage_changed' && (
              <Field label="Moved to">
                <NativeSelect value={c.stage_id ?? ''} onChange={(e) => setC({ stage_id: e.target.value || undefined })}>
                  <option value="">Any stage</option>
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
            {a.trigger === 'campaign_no_reply' && (
              <Field label="Wait after the last message (hours)">
                <Input type="number" min={1} value={(c as { wait_hours?: number }).wait_hours ?? 48} onChange={(e) => setC({ ...({ wait_hours: Number(e.target.value) } as object) })} />
              </Field>
            )}
            {(a.trigger === 'reply_received' || a.trigger === 'keyword') && (
              <>
                <SwitchRow label="Only the lead’s first reply" checked={!!c.first_reply_only} onCheckedChange={(v) => setC({ first_reply_only: v })} />
                <SwitchRow
                  label="Only outside working hours"
                  description={c.outside_hours ? `Working hours: ${c.outside_hours.start}–${c.outside_hours.end}` : 'Runs any time'}
                  checked={!!c.outside_hours}
                  onCheckedChange={(v) => setC({ outside_hours: v ? { start: '09:00', end: '19:00', days: [1, 2, 3, 4, 5, 6], timezone: workspace.timezone } : null })}
                />
              </>
            )}
          </Card>
          <Card className="space-y-3 p-4">
            <div className="text-[12px] font-semibold uppercase tracking-wider text-subtle">Then</div>
            {actions.map((x, i) => (
              <div key={i} className="flex gap-2 rounded-lg border border-border p-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <NativeSelect inputSize="sm" value={x.type} onChange={(e) => setAction(i, newAction(e.target.value as AutomationAction['type']))}>
                    {Object.entries(ACTIONS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v.label}
                      </option>
                    ))}
                  </NativeSelect>
                  {x.type === 'send_template' && (
                    <NativeSelect inputSize="sm" value={x.template_id} onChange={(e) => setAction(i, { ...x, template_id: e.target.value })}>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                  {x.type === 'send_text' && <Textarea value={x.body} onChange={(e) => setAction(i, { ...x, body: e.target.value })} placeholder="Hi {{business_name}}, …" className="min-h-[64px]" />}
                  {x.type === 'move_stage' && (
                    <NativeSelect inputSize="sm" value={x.stage_id} onChange={(e) => setAction(i, { ...x, stage_id: e.target.value })}>
                      {stages.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                  {x.type === 'assign' && (
                    <NativeSelect inputSize="sm" value={x.user_id} onChange={(e) => setAction(i, { ...x, user_id: e.target.value })}>
                      <option value="round_robin">Round-robin between members</option>
                      {members.map((m) => (
                        <option key={m.user_id} value={m.user_id}>
                          {m.profile.full_name || m.profile.email}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                  {x.type === 'add_tag' && <Input inputSize="sm" value={x.tag} onChange={(e) => setAction(i, { ...x, tag: e.target.value })} placeholder="hot-lead" />}
                  {x.type === 'create_task' && (
                    <div className="grid gap-2 sm:grid-cols-[1fr_120px]">
                      <Input inputSize="sm" value={x.title} onChange={(e) => setAction(i, { ...x, title: e.target.value })} />
                      <Input inputSize="sm" type="number" min={0} value={x.due_in_hours ?? 24} onChange={(e) => setAction(i, { ...x, due_in_hours: Number(e.target.value) })} title="Due in hours" />
                    </div>
                  )}
                  {x.type === 'notify' && (
                    <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
                      <NativeSelect inputSize="sm" value={x.target} onChange={(e) => setAction(i, { ...x, target: e.target.value })}>
                        <option value="owner">Lead owner</option>
                        <option value="admins">Admins</option>
                        {members.map((m) => (
                          <option key={m.user_id} value={m.user_id}>
                            {m.profile.full_name}
                          </option>
                        ))}
                      </NativeSelect>
                      <Input inputSize="sm" value={x.message ?? ''} onChange={(e) => setAction(i, { ...x, message: e.target.value })} placeholder="Message (optional)" />
                    </div>
                  )}
                </div>
                <Button size="icon-sm" variant="ghost" onClick={() => setA({ ...a, actions: actions.filter((_, j) => j !== i) })} aria-label="Remove action">
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={() => setA({ ...a, actions: [...actions, newAction('notify')] })}>
              <Plus /> Add action
            </Button>
          </Card>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save automation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunsSheet({ automation, onClose }: { automation: Automation | null; onClose: () => void }) {
  const { data = [] } = useQuery({
    queryKey: ['automation-runs', automation?.id],
    enabled: !!automation,
    queryFn: async () => {
      const { data } = await getSupabase().from('automation_runs').select('*').eq('automation_id', automation!.id).order('id', { ascending: false }).limit(100);
      return (data ?? []) as AutomationRun[];
    },
  });
  return (
    <Dialog open={!!automation} onOpenChange={(o) => !o && onClose()}>
      <SheetContent width="max-w-md" title="Run history">
        <div className="border-b border-border px-5 py-4">
          <div className="text-[15px] font-semibold">{automation?.name}</div>
          <div className="text-xs text-muted">Last 100 runs</div>
        </div>
        <ul className="flex-1 divide-y divide-border overflow-y-auto">
          {!data.length && <EmptyState compact title="No runs yet" />}
          {data.map((r) => (
            <li key={r.id} className="px-5 py-3 text-[13px]">
              <div className="flex items-center gap-2">
                <Badge tone={r.status === 'success' ? 'success' : r.status === 'failed' ? 'danger' : 'neutral'}>{r.status}</Badge>
                <span className="ml-auto text-xs text-subtle">{timeAgo(r.created_at)}</span>
              </div>
              <div className="mt-1 text-xs text-muted">{r.detail}</div>
            </li>
          ))}
        </ul>
      </SheetContent>
    </Dialog>
  );
}
