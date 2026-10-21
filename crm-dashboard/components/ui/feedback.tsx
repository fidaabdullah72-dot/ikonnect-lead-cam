'use client';

import * as React from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Dialog, DialogBody, DialogContent, DialogFooter } from './dialog';

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-md', className)} />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'px-4 py-8' : 'px-6 py-16', className)}>
      {icon && (
        <div className="relative mb-4">
          <div className="absolute inset-0 rounded-2xl bg-primary/20 blur-xl" />
          <div className="relative flex size-12 items-center justify-center rounded-2xl border border-border bg-surface text-primary shadow-sm [&_svg]:size-5">
            {icon}
          </div>
        </div>
      )}
      <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-[13px] text-muted text-balance">{description}</p>}
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Callout({
  tone = 'info',
  title,
  children,
  className,
  icon,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success' | 'primary';
  title?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  icon?: React.ReactNode;
}) {
  const styles = {
    info: 'border-info/20 bg-info-soft text-info',
    warning: 'border-warning/25 bg-warning-soft text-warning',
    danger: 'border-danger/20 bg-danger-soft text-danger',
    success: 'border-success/20 bg-success-soft text-success',
    primary: 'border-primary-soft-border bg-primary-soft text-primary',
  }[tone];
  return (
    <div className={cn('flex gap-3 rounded-lg border px-3.5 py-3 text-[13px]', styles, className)}>
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon ?? (tone === 'warning' || tone === 'danger' ? <AlertTriangle /> : <Info />)}</span>
      <div className="min-w-0 text-foreground/90">
        {title && <div className="font-medium text-foreground">{title}</div>}
        {children && <div className={cn(title && 'mt-0.5', 'text-muted')}>{children}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Confirm dialog (promise based)

type ConfirmOptions = {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
};

const ConfirmContext = React.createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = React.useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={!!state} onOpenChange={(o) => !o && close(false)}>
        <DialogContent size="sm" hideClose>
          <DialogBody className="pt-6">
            <div className="flex gap-3.5">
              {state?.danger && (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
                  <AlertTriangle className="size-4" />
                </div>
              )}
              <div>
                <h3 className="text-[15px] font-semibold">{state?.title}</h3>
                {state?.description && <div className="mt-1.5 text-[13px] text-muted">{state.description}</div>}
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
              {state?.confirmLabel ?? 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => React.useContext(ConfirmContext);
