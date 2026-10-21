import * as React from 'react';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/utils';
import { Spinner } from './spinner';

const variants = {
  primary:
    'bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover [box-shadow:inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(0,0,0,0.12)]',
  secondary: 'bg-surface text-foreground border border-border shadow-sm hover:bg-surface-2 hover:border-border-strong',
  soft: 'bg-primary-soft text-primary hover:bg-primary-soft-border/50',
  ghost: 'text-muted hover:text-foreground hover:bg-surface-2',
  outline: 'border border-border text-foreground hover:bg-surface-2',
  danger: 'bg-danger text-white shadow-sm hover:opacity-90',
  'danger-ghost': 'text-danger hover:bg-danger-soft',
  whatsapp: 'bg-[#1faa59] text-white shadow-sm hover:bg-[#1a964e] [box-shadow:inset_0_1px_0_rgba(255,255,255,0.18)]',
  link: 'text-primary underline-offset-4 hover:underline px-0 h-auto',
} as const;

const sizes = {
  xs: 'h-7 px-2 text-xs gap-1 rounded-md',
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-[13.5px] gap-2 rounded-lg',
  lg: 'h-11 px-5 text-sm gap-2 rounded-lg',
  icon: 'h-8 w-8 rounded-md',
  'icon-sm': 'h-7 w-7 rounded-md',
  'icon-xs': 'h-6 w-6 rounded',
} as const;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  loading?: boolean;
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', loading, asChild, disabled, children, ...props },
  ref,
) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      ref={ref}
      className={cn(
        // active:scale — every button visibly reacts to a press.
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,border-color,color,opacity,transform] duration-150 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:scale-100 [&_svg]:size-4 [&_svg]:shrink-0',
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading && <Spinner className="size-3.5" />}
          {children}
        </>
      )}
    </Comp>
  );
});
