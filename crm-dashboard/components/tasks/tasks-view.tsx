'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { endOfDay, isPast, isToday, startOfDay } from 'date-fns';
import { CalendarClock, CheckSquare, Phone, Plus, Trash2, Users2, Video, ListTodo } from 'lucide-react';
import { toast } from 'sonner';
import type { Task, TaskType } from '@batsols/shared';
import { Page } from '@/components/shell/app-shell';
import { LeadDrawer } from '@/components/leads/lead-drawer';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox, Segmented } from '@/components/ui/controls';
import { EmptyState, Skeleton } from '@/components/ui/feedback';
import { Input, NativeSelect } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/layout';
import { getSupabase } from '@/lib/supabase/client';
import { qk, useMembers } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, errorMessage, fullDate } from '@/lib/utils';

type Row = Task & { lead: { id: string; business_name: string } | null };

const TYPE: Record<TaskType, { label: string; icon: React.ElementType }> = {
  todo: { label: 'To-do', icon: ListTodo },
  call: { label: 'Call', icon: Phone },
  meeting: { label: 'Meeting', icon: Video },
  follow_up: { label: 'Follow-up', icon: CalendarClock },
};

export function TasksView() {
  const { workspace, userId, can } = useWorkspace();
  const { members, byId } = useMembers();
  const qc = useQueryClient();
  const [scope, setScope] = React.useState<'mine' | 'all'>('mine');
  const [showDone, setShowDone] = React.useState(false);
  const [leadId, setLeadId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState({ title: '', due: '', type: 'todo' as TaskType, assignee: userId });
  const key = [...qk.tasks(workspace.id), scope, showDone];

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: async () => {
      let q = getSupabase().from('tasks').select('*, lead:leads(id, business_name)').eq('workspace_id', workspace.id).order('due_at', { ascending: true, nullsFirst: false }).limit(500);
      if (scope === 'mine') q = q.eq('assignee_id', userId);
      if (!showDone) q = q.is('completed_at', null);
      const { data, error } = await q;
      if (error) throw error;
      return data as unknown as Row[];
    },
  });
  const refresh = () => qc.invalidateQueries({ queryKey: qk.tasks(workspace.id) });

  async function add() {
    if (!draft.title.trim()) return;
    const { error } = await getSupabase()
      .from('tasks')
      .insert({ workspace_id: workspace.id, title: draft.title.trim(), type: draft.type, due_at: draft.due ? new Date(draft.due).toISOString() : null, assignee_id: draft.assignee || null, created_by: userId });
    if (error) return toast.error(errorMessage(error));
    setDraft((d) => ({ ...d, title: '', due: '' }));
    refresh();
  }
  async function toggle(t: Row) {
    await getSupabase().from('tasks').update({ completed_at: t.completed_at ? null : new Date().toISOString() }).eq('id', t.id);
    refresh();
  }
  async function remove(t: Row) {
    const { error } = await getSupabase().from('tasks').delete().eq('id', t.id);
    if (error) return toast.error(errorMessage(error));
    refresh();
  }

  const groups: Array<{ title: string; items: Row[]; tone?: string }> = [
    { title: 'Overdue', items: tasks.filter((t) => !t.completed_at && t.due_at && isPast(new Date(t.due_at)) && !isToday(new Date(t.due_at))), tone: 'text-danger' },
    { title: 'Today', items: tasks.filter((t) => !t.completed_at && t.due_at && isToday(new Date(t.due_at))) },
    { title: 'Upcoming', items: tasks.filter((t) => !t.completed_at && t.due_at && new Date(t.due_at) > endOfDay(new Date())) },
    { title: 'No date', items: tasks.filter((t) => !t.completed_at && !t.due_at) },
    { title: 'Done', items: tasks.filter((t) => t.completed_at) },
  ];

  return (
    <Page>
      <PageHeader icon={<CheckSquare />} title="Tasks" description="Calls, meetings and follow-ups for you and your team." />
      {can.write && (
        <Card className="mb-5 flex flex-wrap items-center gap-2 p-3">
          <NativeSelect inputSize="sm" className="w-full sm:w-32" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as TaskType })}>
            {Object.entries(TYPE).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </NativeSelect>
          <Input inputSize="sm" className="w-full sm:w-auto sm:min-w-[200px] sm:flex-1" placeholder="What needs doing? e.g. Call Smile Dental about pricing" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <Input inputSize="sm" type="datetime-local" className="w-full sm:w-52" value={draft.due} onChange={(e) => setDraft({ ...draft, due: e.target.value })} />
          <NativeSelect inputSize="sm" className="min-w-0 flex-1 sm:w-40 sm:flex-none" value={draft.assignee} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.user_id === userId ? 'Me' : m.profile.full_name || m.profile.email}
              </option>
            ))}
          </NativeSelect>
          <Button size="sm" variant="primary" onClick={add} disabled={!draft.title.trim()}>
            <Plus /> Add task
          </Button>
        </Card>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented value={scope} onChange={setScope} options={[{ value: 'mine', label: 'Assigned to me' }, { value: 'all', label: 'Everyone', icon: <Users2 /> }]} />
        <Segmented value={showDone ? 'all' : 'open'} onChange={(v) => setShowDone(v === 'all')} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'Include done' }]} />
      </div>
      {isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : !tasks.length ? (
        <Card>
          <EmptyState icon={<CheckSquare />} title="Nothing to do" description="Add tasks here or from any lead. Automations can create follow-up tasks for you too." />
        </Card>
      ) : (
        <div className="space-y-5">
          {groups
            .filter((g) => g.items.length)
            .map((g) => (
              <section key={g.title}>
                <h2 className={cn('mb-2 text-[12px] font-semibold uppercase tracking-wider text-subtle', g.tone)}>
                  {g.title} · {g.items.length}
                </h2>
                <Card className="divide-y divide-border">
                  {g.items.map((t) => {
                    const T = TYPE[t.type];
                    const who = t.assignee_id ? byId.get(t.assignee_id) : undefined;
                    const overdue = !t.completed_at && t.due_at && new Date(t.due_at) < startOfDay(new Date());
                    return (
                      <div key={t.id} className="group flex items-center gap-3 px-4 py-3">
                        <Checkbox checked={!!t.completed_at} onCheckedChange={() => toggle(t)} disabled={!can.write} aria-label="Complete task" />
                        <T.icon className="size-4 shrink-0 text-subtle" />
                        <div className="min-w-0 flex-1">
                          <div className={cn('truncate text-[13.5px]', t.completed_at && 'text-subtle line-through')}>{t.title}</div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                            {t.due_at && <span className={cn(overdue && 'font-medium text-danger')}>{fullDate(t.due_at)}</span>}
                            {t.lead && (
                              <button className="text-primary hover:underline" onClick={() => setLeadId(t.lead!.id)}>
                                {t.lead.business_name}
                              </button>
                            )}
                          </div>
                        </div>
                        <Badge tone="outline">{T.label}</Badge>
                        {who && <Avatar name={who.profile.full_name || who.profile.email} size="sm" />}
                        {can.write && (
                          <Button size="icon-sm" variant="ghost" className="opacity-0 group-hover:opacity-100" onClick={() => remove(t)} aria-label="Delete task">
                            <Trash2 />
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </Card>
              </section>
            ))}
        </div>
      )}
      <LeadDrawer leadId={leadId} onClose={() => setLeadId(null)} />
    </Page>
  );
}
