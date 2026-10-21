'use client';

import * as React from 'react';
import { DropdownMenu as DM, Popover as P, Tooltip as T } from 'radix-ui';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------- Dropdown

export const DropdownMenu = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;
export const DropdownMenuGroup = DM.Group;
export const DropdownMenuSub = DM.Sub;

const menuSurface =
  'z-50 min-w-[180px] overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-lg data-[state=open]:animate-scale-in';

export function DropdownMenuContent({ className, sideOffset = 6, align = 'end', ...props }: React.ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content sideOffset={sideOffset} align={align} className={cn(menuSurface, className)} {...props} />
    </DM.Portal>
  );
}

const itemBase =
  'relative flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-[13px] text-foreground outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2 [&_svg]:size-4 [&_svg]:text-muted';

export function DropdownMenuItem({
  className,
  danger,
  shortcut,
  children,
  ...props
}: React.ComponentProps<typeof DM.Item> & { danger?: boolean; shortcut?: string }) {
  return (
    <DM.Item className={cn(itemBase, danger && 'text-danger data-[highlighted]:bg-danger-soft [&_svg]:text-danger', className)} {...props}>
      {children}
      {shortcut && <span className="ml-auto pl-4 text-[11px] tracking-wide text-subtle">{shortcut}</span>}
    </DM.Item>
  );
}

export function DropdownMenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof DM.CheckboxItem>) {
  return (
    <DM.CheckboxItem className={cn(itemBase, 'pr-7', className)} {...props}>
      {children}
      <DM.ItemIndicator className="absolute right-2">
        <Check className="size-3.5 !text-primary" />
      </DM.ItemIndicator>
    </DM.CheckboxItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DM.Label>) {
  return <DM.Label className={cn('px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-subtle', className)} {...props} />;
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <DM.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} />;
}

export function DropdownMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof DM.SubTrigger>) {
  return (
    <DM.SubTrigger className={cn(itemBase, 'data-[state=open]:bg-surface-2', className)} {...props}>
      {children}
      <span className="ml-auto text-subtle">›</span>
    </DM.SubTrigger>
  );
}

export function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof DM.SubContent>) {
  return (
    <DM.Portal>
      <DM.SubContent sideOffset={6} className={cn(menuSurface, 'max-h-[320px] overflow-y-auto', className)} {...props} />
    </DM.Portal>
  );
}

// ---------------------------------------------------------------- Popover

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

export function PopoverContent({ className, sideOffset = 6, align = 'start', ...props }: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        sideOffset={sideOffset}
        align={align}
        className={cn('z-50 rounded-xl border border-border bg-surface p-3 shadow-lg outline-none data-[state=open]:animate-scale-in', className)}
        {...props}
      />
    </P.Portal>
  );
}

// ---------------------------------------------------------------- Tooltip

export const TooltipProvider = T.Provider;

export function Tooltip({
  content,
  children,
  side = 'top',
  delay,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}) {
  if (!content) return <>{children}</>;
  return (
    <T.Root delayDuration={delay}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-[60] max-w-xs rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-md data-[state=delayed-open]:animate-fade-in"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
