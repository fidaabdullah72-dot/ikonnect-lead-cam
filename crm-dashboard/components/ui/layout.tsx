import * as React from 'react';
import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  description,
  actions,
  icon,
  className,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn('mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <div className="mt-0.5 hidden size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-primary shadow-sm sm:flex [&_svg]:size-5">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
          {description && <p className="mt-1 text-[13.5px] text-muted">{description}</p>}
          {children}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  trend,
  accent = 'primary',
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  trend?: { value: string; positive?: boolean } | null;
  accent?: 'primary' | 'success' | 'warning' | 'info' | 'whatsapp' | 'danger';
  className?: string;
}) {
  const accents = {
    primary: 'text-primary bg-primary-soft',
    success: 'text-success bg-success-soft',
    warning: 'text-warning bg-warning-soft',
    info: 'text-info bg-info-soft',
    whatsapp: 'text-whatsapp bg-whatsapp-soft',
    danger: 'text-danger bg-danger-soft',
  };
  return (
    <div className={cn('group relative overflow-hidden rounded-xl border border-border bg-surface p-4 shadow-sm', className)}>
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-medium text-muted">{label}</span>
        {icon && <span className={cn('flex size-7 items-center justify-center rounded-lg [&_svg]:size-3.5', accents[accent])}>{icon}</span>}
      </div>
      <div className="tabular mt-2 text-[26px] font-semibold leading-none tracking-[-0.02em]">{value}</div>
      <div className="mt-2 flex items-center gap-2 text-xs text-subtle">
        {trend && (
          <span className={cn('font-medium', trend.positive === false ? 'text-danger' : 'text-success')}>{trend.value}</span>
        )}
        {hint}
      </div>
    </div>
  );
}

export function Section({
  title,
  description,
  children,
  className,
  aside,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  aside?: React.ReactNode;
}) {
  return (
    <section className={cn('grid gap-6 border-b border-border py-8 first:pt-0 last:border-0 lg:grid-cols-[280px_1fr]', className)}>
      <div>
        <h2 className="text-[14px] font-semibold">{title}</h2>
        {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
        {aside}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------- Table

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full border-separate border-spacing-0 text-[13px]', className)} {...props} />;
}

export function Th({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'sticky top-0 z-10 h-9 border-b border-border bg-surface-2/95 px-3 text-left text-[11.5px] font-medium uppercase tracking-wider text-subtle backdrop-blur first:pl-4 last:pr-4',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('h-12 border-b border-border px-3 align-middle first:pl-4 last:pr-4', className)} {...props} />;
}

export function Tr({ className, selected, ...props }: React.HTMLAttributes<HTMLTableRowElement> & { selected?: boolean }) {
  return (
    <tr
      className={cn('group transition-colors hover:bg-surface-2/60', selected && 'bg-primary-soft hover:bg-primary-soft', className)}
      {...props}
    />
  );
}
