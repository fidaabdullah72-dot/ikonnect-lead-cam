'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { STAGE_COLORS, type PipelineStage, type StageKind } from '@batsols/shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Callout, useConfirm } from '@/components/ui/feedback';
import { Input, NativeSelect } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu';
import { getSupabase } from '@/lib/supabase/client';
import { qk, useStages } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { errorMessage } from '@/lib/utils';

const KINDS: Record<StageKind, string> = { new: 'New (entry)', contacted: 'Contacted', replied: 'Replied', open: 'In progress', won: 'Won', lost: 'Lost' };

export default function PipelineSettingsPage() {
  const { workspace, can } = useWorkspace();
  const { stages } = useStages();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [items, setItems] = React.useState<PipelineStage[]>([]);
  React.useEffect(() => setItems(stages), [stages]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.stages(workspace.id) });
    qc.invalidateQueries({ queryKey: ['pipeline', workspace.id] });
  };

  async function patch(id: string, p: Partial<PipelineStage>) {
    const { error } = await getSupabase().from('pipeline_stages').update(p).eq('id', id);
    if (error) return toast.error(errorMessage(error));
    refresh();
  }
  async function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const from = items.findIndex((s) => s.id === e.active.id);
    const to = items.findIndex((s) => s.id === e.over!.id);
    const next = arrayMove(items, from, to);
    setItems(next);
    await Promise.all(next.map((s, i) => getSupabase().from('pipeline_stages').update({ position: i }).eq('id', s.id)));
    refresh();
  }
  async function add() {
    const { error } = await getSupabase()
      .from('pipeline_stages')
      .insert({ workspace_id: workspace.id, name: 'New stage', color: STAGE_COLORS[items.length % STAGE_COLORS.length], position: items.length, kind: 'open' });
    if (error) return toast.error(errorMessage(error));
    refresh();
  }
  async function remove(s: PipelineStage) {
    const fallback = items.find((x) => x.id !== s.id && x.kind === 'new') ?? items.find((x) => x.id !== s.id);
    if (!(await confirm({ title: `Delete stage “${s.name}”?`, description: `Leads in it move to “${fallback?.name}”.`, confirmLabel: 'Delete stage', danger: true }))) return;
    const { error } = await getSupabase().rpc('delete_stage', { p_stage: s.id, p_move_to: fallback?.id ?? null });
    if (error) return toast.error(errorMessage(error));
    refresh();
  }

  return (
    <Card>
      <CardHeader title="Pipeline stages" description="Drag to reorder. The stage type tells CoreNexa where to move leads automatically (contacted after the first message, replied when they answer) and what counts as won." action={can.admin && <Button size="sm" variant="secondary" onClick={add}><Plus /> Add stage</Button>} />
      {!can.admin && <Callout tone="info" className="mx-5 mb-4">Only admins can edit stages.</Callout>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ul className="divide-y divide-border border-t border-border">
            {items.map((s) => (
              <StageRow key={s.id} stage={s} disabled={!can.admin} onPatch={(p) => patch(s.id, p)} onRemove={() => remove(s)} canRemove={items.length > 2} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </Card>
  );
}

function StageRow({ stage, disabled, onPatch, onRemove, canRemove }: { stage: PipelineStage; disabled: boolean; onPatch: (p: Partial<PipelineStage>) => void; onRemove: () => void; canRemove: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: stage.id, disabled });
  const [name, setName] = React.useState(stage.name);
  React.useEffect(() => setName(stage.name), [stage.name]);
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`flex items-center gap-3 bg-surface px-5 py-2.5 ${isDragging ? 'relative z-10 shadow-lg' : ''}`}>
      <button className="cursor-grab touch-none text-subtle disabled:cursor-default" disabled={disabled} aria-label="Drag to reorder" {...attributes} {...listeners}>
        <GripVertical className="size-4" />
      </button>
      <Popover>
        <PopoverTrigger asChild disabled={disabled}>
          <button className="size-5 shrink-0 rounded-full ring-2 ring-surface" style={{ background: stage.color }} aria-label="Colour" />
        </PopoverTrigger>
        <PopoverContent className="flex w-auto gap-1.5 p-2">
          {STAGE_COLORS.map((c) => (
            <button key={c} className="size-6 rounded-full" style={{ background: c }} onClick={() => onPatch({ color: c })} aria-label={c} />
          ))}
        </PopoverContent>
      </Popover>
      <Input inputSize="sm" className="max-w-xs" value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== stage.name && onPatch({ name: name.trim() })} />
      <NativeSelect inputSize="sm" className="w-40" value={stage.kind} disabled={disabled} onChange={(e) => onPatch({ kind: e.target.value as StageKind })}>
        {Object.entries(KINDS).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </NativeSelect>
      {!disabled && canRemove && (
        <Button size="icon-sm" variant="ghost" className="ml-auto" onClick={onRemove} aria-label="Delete stage">
          <Trash2 />
        </Button>
      )}
    </li>
  );
}
