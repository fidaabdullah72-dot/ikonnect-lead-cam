import { cn, colorFor, initials } from '@/lib/utils';

const sizes = {
  xs: 'size-5 text-[9px]',
  sm: 'size-6 text-[10px]',
  md: 'size-8 text-xs',
  lg: 'size-10 text-sm',
  xl: 'size-14 text-lg',
};

export function Avatar({
  name,
  src,
  size = 'md',
  className,
  square,
}: {
  name: string | null | undefined;
  src?: string | null;
  size?: keyof typeof sizes;
  className?: string;
  square?: boolean;
}) {
  const color = colorFor(name);
  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-semibold text-white',
        square ? 'rounded-lg' : 'rounded-full',
        sizes[size],
        className,
      )}
      style={{ background: src ? undefined : `linear-gradient(135deg, ${color}, ${color}cc)` }}
      title={name ?? undefined}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="size-full object-cover" />
      ) : (
        initials(name)
      )}
    </span>
  );
}

export function AvatarStack({ names, max = 4 }: { names: string[]; max?: number }) {
  const shown = names.slice(0, max);
  return (
    <div className="flex -space-x-1.5">
      {shown.map((n, i) => (
        <Avatar key={`${n}-${i}`} name={n} size="sm" className="ring-2 ring-surface" />
      ))}
      {names.length > max && (
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-surface-3 text-[10px] font-semibold text-muted ring-2 ring-surface">
          +{names.length - max}
        </span>
      )}
    </div>
  );
}
