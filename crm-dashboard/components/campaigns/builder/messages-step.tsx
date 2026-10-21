'use client';

import * as React from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Clock, FileText, GripVertical, MessageSquarePlus, Plus, Split, Trash2, X } from 'lucide-react';
import type { CampaignVariant, LeadFilters } from '@batsols/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, Tooltip } from '@/components/ui/menu';
import { MessageEditor } from '@/components/messaging/message-editor';
import { MediaPicker } from '@/components/messaging/media-picker';
import { useTemplates } from '@/components/whatsapp/chat';
import { cleanFilters } from '@/lib/leads';
import { cn } from '@/lib/utils';
import { emptyVariant, newKey, type BuilderState, type BuilderStep } from './state';

const LETTERS = 'ABCDE';

export function MessagesStep({ state, set }: { state: BuilderState; set: (fn: (s: BuilderState) => BuilderState) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [first, ...followUps] = state.steps;
  const { audience } = state;
  const previewFilters = React.useMemo(() => cleanFilters(audience.mode === 'selection' && audience.ids ? { ids: audience.ids } : audience.filters), [audience]);

  const updateStep = (key: string, patch: Partial<BuilderStep>) => set((s) => ({ ...s, steps: s.steps.map((st) => (st.key === key ? { ...st, ...patch } : st)) }));
  const removeStep = (key: string) => set((s) => ({ ...s, steps: s.steps.filter((st) => st.key !== key) }));
  const addFollowUp = () =>
    set((s) => ({ ...s, steps: [...s.steps, { key: newKey(), delay_hours: 48, variants: [emptyVariant()] }] }));

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    set((s) => {
      const [head, ...rest] = s.steps;
      const from = rest.findIndex((x) => x.key === active.id);
      const to = rest.findIndex((x) => x.key === over.id);
      if (from < 0 || to < 0) return s;
      return { ...s, steps: [head!, ...arrayMove(rest, from, to)] };
    });
  }

  return (
    <div className="space-y-4">
      {first && <StepCard step={first} index={0} onChange={(p) => updateStep(first.key, p)} senderName={state.settings.sender_name} previewFilters={previewFilters} />}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={followUps.map((f) => f.key)} strategy={verticalListSortingStrategy}>
          {followUps.map((step, i) => (
            <SortableStep key={step.key} id={step.key}>
              {(handle) => (
                <StepCard
                  step={step}
                  index={i + 1}
                  handle={handle}
                  onChange={(p) => updateStep(step.key, p)}
                  onRemove={() => removeStep(step.key)}
                  senderName={state.settings.sender_name}
                  previewFilters={previewFilters}
                />
              )}
            </SortableStep>
          ))}
        </SortableContext>
      </DndContext>

      {state.steps.length < 6 && (
        <button
          type="button"
          onClick={addFollowUp}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong py-4 text-[13.5px] font-medium text-muted transition-colors hover:border-primary hover:bg-primary-soft hover:text-primary"
        >
          <MessageSquarePlus className="size-4" /> Add a follow-up (sent only if they haven’t replied)
        </button>
      )}
    </div>
  );
}

function SortableStep({ id, children }: { id: string; children: (handle: React.ReactNode) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const handle = (
    <button type="button" className="cursor-grab touch-none rounded p-1 text-subtle hover:bg-surface-2 hover:text-foreground active:cursor-grabbing" aria-label="Drag to reorder" {...attributes} {...listeners}>
      <GripVertical className="size-4" />
    </button>
  );
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn(isDragging && 'relative z-10 opacity-90 shadow-lg')}>
      {children(handle)}
    </div>
  );
}

function StepCard({
  step,
  index,
  onChange,
  onRemove,
  handle,
  senderName,
  previewFilters,
}: {
  step: BuilderStep;
  index: number;
  onChange: (p: Partial<BuilderStep>) => void;
  onRemove?: () => void;
  handle?: React.ReactNode;
  senderName: string;
  previewFilters?: LeadFilters;
}) {
  const [active, setActive] = React.useState(0);
  const { data: templates = [] } = useTemplates();
  const v = step.variants[Math.min(active, step.variants.length - 1)]!;
  const setVariant = (patch: Partial<CampaignVariant>) => onChange({ variants: step.variants.map((x, i) => (i === active ? { ...x, ...patch } : x)) });
  const days = step.delay_hours % 24 === 0 ? step.delay_hours / 24 : null;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-2/40 px-4 py-3">
        {handle}
        <span className={cn('flex size-7 items-center justify-center rounded-lg text-xs font-semibold', index === 0 ? 'bg-primary text-white' : 'bg-surface-3 text-muted')}>{index + 1}</span>
        <div className="text-[14px] font-semibold">{index === 0 ? 'First message' : `Follow-up ${index}`}</div>
        {index > 0 && (
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <Clock className="size-3.5" /> If no reply after
            <Input
              inputSize="sm"
              type="number"
              min={1}
              className="w-16"
              value={days ?? Math.round(step.delay_hours)}
              onChange={(e) => onChange({ delay_hours: Math.max(1, Number(e.target.value) || 1) * (days !== null ? 24 : 1) })}
            />
            <NativeSelect
              inputSize="sm"
              className="w-24"
              value={days !== null ? 'days' : 'hours'}
              onChange={(e) => onChange({ delay_hours: e.target.value === 'days' ? Math.max(1, Math.round(step.delay_hours / 24)) * 24 : step.delay_hours })}
            >
              <option value="days">days</option>
              <option value="hours">hours</option>
            </NativeSelect>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="xs" variant="ghost">
                <FileText /> Use template
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-80 w-72 overflow-y-auto">
              <DropdownMenuLabel>Load into variant {LETTERS[active]}</DropdownMenuLabel>
              {templates.length === 0 && <div className="px-2 py-3 text-xs text-muted">No templates yet.</div>}
              {templates.map((t) => (
                <DropdownMenuItem key={t.id} onSelect={() => setVariant({ body: t.body, media_url: t.media_url, media_type: t.media_type, media_name: t.media_name })}>
                  <div className="min-w-0">
                    <div className="truncate">{t.name}</div>
                    <div className="truncate text-[11px] text-subtle">{t.body}</div>
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {onRemove && (
            <Tooltip content="Remove this follow-up">
              <Button type="button" size="icon-sm" variant="ghost" onClick={onRemove} aria-label="Remove follow-up">
                <Trash2 />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {step.variants.map((_, i) => (
            <div
              key={i}
              className={cn(
                'group inline-flex h-7 items-center gap-1 rounded-md border pl-2.5 pr-1 text-xs font-semibold transition-colors',
                i === active ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:text-foreground',
              )}
            >
              <button type="button" onClick={() => setActive(i)}>
                Variant {LETTERS[i]}
              </button>
              {step.variants.length > 1 && (
                <button
                  type="button"
                  className="rounded p-0.5 opacity-60 hover:bg-black/5 hover:opacity-100"
                  aria-label={`Remove variant ${LETTERS[i]}`}
                  onClick={() => {
                    onChange({ variants: step.variants.filter((__, j) => j !== i) });
                    setActive(0);
                  }}
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          ))}
          {step.variants.length < 5 && (
            <Tooltip content="A/B test: leads get variants in turn, and BatSols shows which gets more replies">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => {
                  onChange({ variants: [...step.variants, { ...emptyVariant(), body: v.body }] });
                  setActive(step.variants.length);
                }}
              >
                <Split /> <Plus className="-ml-1" /> Variant
              </Button>
            </Tooltip>
          )}
        </div>
        <MessageEditor
          key={`${step.key}-${active}`}
          value={v.body}
          onChange={(body) => setVariant({ body })}
          rows={index === 0 ? 7 : 5}
          senderName={senderName}
          previewFilters={previewFilters}
          footer={<MediaPicker value={{ media_url: v.media_url ?? null, media_type: v.media_type ?? null, media_name: v.media_name ?? null }} onChange={(m) => setVariant(m)} />}
        />
      </div>
    </Card>
  );
}
