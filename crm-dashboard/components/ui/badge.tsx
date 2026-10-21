import * as React from 'react';
import { cn } from '@/lib/utils';

const tones = {
  neutral: 'bg-surface-2 text-muted border-border',
  primary: 'bg-primary-soft text-primary border-primary-soft-border',
  success: 'bg-success-soft text-success border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  info: 'bg-info-soft text-info border-transparent',
  whatsapp: 'bg-whatsapp-soft text-whatsapp border-transparent',
  outline: 'bg-transparent text-muted border-border',
} as const;

export type BadgeTone = keyof typeof tones;

export function Badge({
  tone = 'neutral',
  dot,
  pulse,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; dot?: boolean; pulse?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-xs font-medium [&_svg]:size-3',
        tones[tone],
        className,
      )}
      {...props}
    >
      {dot && <span className={cn('size-1.5 rounded-full bg-current', pulse && 'animate-pulse-ring')} />}
      {children}
    </span>
  );
}

/** A colored dot + label, used for pipeline stages. */
export function StageBadge({ name, color, className }: { name: string; color: string; className?: string }) {
  return (
    <span
      className={cn('inline-flex h-[22px] max-w-full items-center gap-1.5 truncate rounded-md border border-border bg-surface px-2 text-xs font-medium text-foreground', className)}
    >
      <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate">{name}</span>
    </span>
  );
}

export function Tag({ children, onRemove, className }: { children: React.ReactNode; onRemove?: () => void; className?: string }) {
  return (
    <span className={cn('inline-flex h-5 max-w-full items-center gap-1 whitespace-nowrap rounded bg-surface-2 px-1.5 text-[11.5px] font-medium text-muted', className)}>
      <span className="truncate">#{children}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} className="-mr-0.5 rounded text-subtle hover:text-foreground" aria-label="Remove tag">
          ×
        </button>
      )}
    </span>
  );
}
