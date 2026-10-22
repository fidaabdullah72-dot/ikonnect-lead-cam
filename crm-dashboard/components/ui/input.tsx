import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Label as LabelPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

const fieldBase =
  'w-full rounded-lg border border-border bg-surface text-foreground shadow-sm transition-[border-color,box-shadow] duration-150 placeholder:text-subtle hover:border-border-strong focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  inputSize?: 'sm' | 'md' | 'lg';
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, leading, trailing, inputSize = 'md', ...props },
  ref,
) {
  const h = inputSize === 'sm' ? 'h-8 text-[13px]' : inputSize === 'lg' ? 'h-11 text-sm' : 'h-9 text-[13.5px]';
  if (!leading && !trailing) {
    return <input ref={ref} className={cn(fieldBase, h, 'px-3', className)} {...props} />;
  }
  return (
    <div className={cn('relative flex items-center', className)}>
      {leading && <span className="pointer-events-none absolute left-3 flex text-subtle [&_svg]:size-4">{leading}</span>}
      <input ref={ref} className={cn(fieldBase, h, leading ? 'pl-9' : 'pl-3', trailing ? 'pr-9' : 'pr-3')} {...props} />
      {trailing && <span className="absolute right-2 flex items-center text-subtle [&_svg]:size-4">{trailing}</span>}
    </div>
  );
});

/** Password field with a show/hide button. */
export const PasswordInput = React.forwardRef<HTMLInputElement, Omit<InputProps, 'type' | 'trailing'>>(function PasswordInput(props, ref) {
  const [shown, setShown] = React.useState(false);
  return (
    <Input
      ref={ref}
      {...props}
      type={shown ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          className="rounded p-1 text-subtle hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {shown ? <EyeOff /> : <Eye />}
        </button>
      }
    />
  );
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(fieldBase, 'min-h-[88px] px-3 py-2 text-[13.5px] leading-relaxed', className)} {...props} />;
  },
);

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn('text-[13px] font-medium text-foreground', className)} {...props} />;
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
  optional,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
  optional?: boolean;
}) {
  // Tie the label to a single control automatically so clicking the label
  // focuses it and screen readers announce it.
  const autoId = React.useId();
  const only = !htmlFor && label && React.isValidElement<{ id?: string }>(children) ? children : null;
  const id = htmlFor ?? (only ? (only.props.id ?? autoId) : undefined);
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <Label htmlFor={id} className="flex items-center gap-1.5">
          {label}
          {optional && <span className="text-xs font-normal text-subtle">Optional</span>}
        </Label>
      )}
      {only && !only.props.id ? React.cloneElement(only, { id }) : children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-subtle">{hint}</p> : null}
    </div>
  );
}

/** Styled native select — great for short, simple option lists. */
export const NativeSelect = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement> & { inputSize?: 'sm' | 'md' }>(
  function NativeSelect({ className, inputSize = 'md', children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          fieldBase,
          inputSize === 'sm' ? 'h-8 text-[13px]' : 'h-9 text-[13.5px]',
          'appearance-none bg-[length:16px] bg-[right_8px_center] bg-no-repeat pl-3 pr-8',
          "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238c8c9a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 10 5 5 5-5'/%3E%3C/svg%3E\")]",
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);
