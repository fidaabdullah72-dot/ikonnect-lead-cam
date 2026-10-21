'use client';

import * as React from 'react';
import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl', full: 'max-w-6xl' };

export function DialogContent({
  className,
  children,
  size = 'md',
  title,
  description,
  hideClose,
  ...props
}: React.ComponentProps<typeof D.Content> & {
  size?: keyof typeof widths;
  title?: React.ReactNode;
  description?: React.ReactNode;
  hideClose?: boolean;
}) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
      <D.Content
        className={cn(
          'fixed left-1/2 top-[8vh] z-50 flex max-h-[84vh] w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-lg focus:outline-none data-[state=open]:animate-scale-in',
          widths[size],
          className,
        )}
        {...(description ? {} : { 'aria-describedby': undefined })}
        {...props}
      >
        {(title || description) && (
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-4">
            <div>
              {title && <D.Title className="text-[15px] font-semibold tracking-[-0.01em]">{title}</D.Title>}
              {description && <D.Description className="mt-1 text-[13px] text-muted">{description}</D.Description>}
            </div>
          </div>
        )}
        {!title && <D.Title className="sr-only">Dialog</D.Title>}
        {children}
        {!hideClose && (
          <D.Close className="absolute right-4 top-4 rounded-md p-1 text-subtle transition-colors hover:bg-surface-2 hover:text-foreground" aria-label="Close">
            <X className="size-4" />
          </D.Close>
        )}
      </D.Content>
    </D.Portal>
  );
}

export function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 py-5', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface-2/50 px-6 py-3', className)} {...props} />;
}

/** Right-hand slide-over panel. */
export function SheetContent({
  className,
  children,
  width = 'max-w-xl',
  title,
  ...props
}: React.ComponentProps<typeof D.Content> & { width?: string; title?: string }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in" />
      <D.Content
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-surface shadow-lg focus:outline-none data-[state=open]:animate-slide-in-right',
          width,
          className,
        )}
        aria-describedby={undefined}
        {...props}
      >
        <D.Title className="sr-only">{title ?? 'Panel'}</D.Title>
        {children}
      </D.Content>
    </D.Portal>
  );
}
