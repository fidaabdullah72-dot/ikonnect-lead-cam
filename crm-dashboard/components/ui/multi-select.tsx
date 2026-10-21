'use client';

import * as React from 'react';
import { Command } from 'cmdk';
import { Check, ChevronDown, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './menu';

export interface Option {
  value: string;
  label: string;
  count?: number;
  color?: string;
  hint?: string;
}

/** Filter-chip style multi select with search. */
export function MultiSelect({
  options,
  value,
  onChange,
  label,
  icon,
  placeholder = 'Search…',
  single,
  className,
  emptyText = 'No matches',
  align = 'start',
}: {
  options: Option[];
  value: string[];
  onChange: (v: string[]) => void;
  label: string;
  icon?: React.ReactNode;
  placeholder?: string;
  single?: boolean;
  className?: string;
  emptyText?: string;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = React.useState(false);
  const selected = new Set(value);
  const active = value.length > 0;
  const summary = active
    ? value.length === 1
      ? (options.find((o) => o.value === value[0])?.label ?? value[0])
      : `${value.length} selected`
    : null;

  const toggle = (v: string) => {
    if (single) {
      onChange(selected.has(v) ? [] : [v]);
      setOpen(false);
      return;
    }
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange([...next]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-8 max-w-[240px] items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium transition-colors [&_svg]:size-3.5',
            active
              ? 'border-primary-soft-border bg-primary-soft text-primary'
              : 'border-dashed border-border-strong text-muted hover:border-solid hover:bg-surface-2 hover:text-foreground',
            className,
          )}
        >
          {icon}
          <span className="shrink-0">{label}</span>
          {summary && (
            <>
              <span className="h-3.5 w-px bg-current opacity-30" />
              <span className="truncate font-semibold">{summary}</span>
            </>
          )}
          {active ? (
            <span
              role="button"
              tabIndex={-1}
              aria-label={`Clear ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange([]);
              }}
              className="-mr-1 rounded p-0.5 hover:bg-primary/15"
            >
              <X />
            </span>
          ) : (
            <ChevronDown className="opacity-60" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align={align}>
        <Command className="flex flex-col" loop>
          <div className="border-b border-border px-3">
            <Command.Input placeholder={placeholder} className="h-10 w-full bg-transparent text-[13px] outline-none placeholder:text-subtle" />
          </div>
          <Command.List className="max-h-64 overflow-y-auto p-1">
            <Command.Empty className="px-3 py-6 text-center text-[13px] text-subtle">{emptyText}</Command.Empty>
            {options.map((o) => (
              <Command.Item
                key={o.value}
                value={`${o.label} ${o.value}`}
                onSelect={() => toggle(o.value)}
                className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-[13px] data-[selected=true]:bg-surface-2"
              >
                <span
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded border',
                    selected.has(o.value) ? 'border-primary bg-primary text-white' : 'border-border-strong',
                    single && 'rounded-full',
                  )}
                >
                  {selected.has(o.value) && <Check className="size-3" strokeWidth={3} />}
                </span>
                {o.color && <span className="size-2 shrink-0 rounded-full" style={{ background: o.color }} />}
                <span className="truncate">{o.label}</span>
                {o.count !== undefined && <span className="tabular ml-auto text-xs text-subtle">{o.count}</span>}
              </Command.Item>
            ))}
          </Command.List>
          {active && !single && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="border-t border-border px-3 py-2 text-left text-xs font-medium text-muted hover:text-foreground"
            >
              Clear selection
            </button>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Free-form tag entry with suggestions. */
export function TagInput({
  value,
  onChange,
  suggestions = [],
  placeholder = 'Add tag…',
  className,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = React.useState('');
  const add = (raw: string) => {
    const tags = raw
      .split(',')
      .map((t) => t.trim().replace(/^#/, ''))
      .filter(Boolean);
    if (!tags.length) return;
    onChange([...new Set([...value, ...tags])]);
    setDraft('');
  };
  const filtered = draft ? suggestions.filter((s) => s.toLowerCase().includes(draft.toLowerCase()) && !value.includes(s)).slice(0, 6) : [];

  return (
    <div className={cn('relative', className)}>
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 shadow-sm focus-within:border-primary focus-within:ring-[3px] focus-within:ring-ring/40">
        {value.map((t) => (
          <span key={t} className="inline-flex h-6 items-center gap-1 rounded-md bg-surface-2 pl-2 pr-1 text-xs font-medium">
            #{t}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} className="rounded p-0.5 text-subtle hover:text-foreground" aria-label={`Remove ${t}`}>
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(draft);
            } else if (e.key === 'Backspace' && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => draft && add(draft)}
          placeholder={value.length ? '' : placeholder}
          className="h-6 min-w-[80px] flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-subtle"
        />
      </div>
      {filtered.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border border-border bg-surface p-1 shadow-lg">
          {filtered.map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                add(s);
              }}
              className="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[13px] hover:bg-surface-2"
            >
              <Plus className="size-3 text-subtle" />#{s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
