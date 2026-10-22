'use client';

import * as React from 'react';
import { Checkbox as CB, Switch as SW, Tabs as TB, Progress as PR } from 'radix-ui';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Checkbox({ className, ...props }: React.ComponentProps<typeof CB.Root>) {
  return (
    <CB.Root
      className={cn(
        'peer inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-border-strong bg-surface shadow-sm transition-colors hover:border-primary data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <CB.Indicator className="text-white">
        {props.checked === 'indeterminate' ? <Minus className="size-3" strokeWidth={3} /> : <Check className="size-3" strokeWidth={3} />}
      </CB.Indicator>
    </CB.Root>
  );
}

export function Switch({ className, ...props }: React.ComponentProps<typeof SW.Root>) {
  return (
    <SW.Root
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-surface-3 transition-colors data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SW.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[17px]" />
    </SW.Root>
  );
}

/** A labelled switch row used in settings forms. */
export function SwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const id = React.useId();
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <div className="text-[13.5px] font-medium">{label}</div>
        {description && <div className="mt-0.5 text-[12.5px] text-muted">{description}</div>}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="mt-0.5" />
    </div>
  );
}

export const Tabs = TB.Root;
export const TabsContent = TB.Content;

export function TabsList({ className, ...props }: React.ComponentProps<typeof TB.List>) {
  return <TB.List className={cn('flex items-center gap-1 border-b border-border', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TB.Trigger>) {
  return (
    <TB.Trigger
      className={cn(
        'relative -mb-px inline-flex h-9 items-center gap-1.5 border-b-2 border-transparent px-3 text-[13px] font-medium text-muted transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground [&_svg]:size-4',
        className,
      )}
      {...props}
    />
  );
}

/** Pill-style segmented control. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = 'md',
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: React.ReactNode; icon?: React.ReactNode; count?: number }>;
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div className={cn('no-scrollbar inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-border bg-surface-2 p-0.5', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-all [&_svg]:size-3.5',
            size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-[13px]',
            value === o.value ? 'bg-surface text-foreground shadow-sm' : 'text-muted hover:text-foreground',
          )}
        >
          {o.icon}
          {o.label}
          {o.count !== undefined && <span className="tabular text-[11px] text-subtle">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, className, tone = 'primary' }: { value: number; className?: string; tone?: 'primary' | 'success' | 'whatsapp' | 'warning' }) {
  const color = { primary: 'bg-primary', success: 'bg-success', whatsapp: 'bg-whatsapp-bright', warning: 'bg-warning' }[tone];
  const v = Math.max(0, Math.min(100, value));
  return (
    <PR.Root className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-surface-3', className)} value={v}>
      <PR.Indicator className={cn('h-full rounded-full transition-[width] duration-500 ease-out', color)} style={{ width: `${v}%` }} />
    </PR.Root>
  );
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-surface-2 px-1 font-sans text-[11px] font-medium text-subtle', className)}>
      {children}
    </kbd>
  );
}
