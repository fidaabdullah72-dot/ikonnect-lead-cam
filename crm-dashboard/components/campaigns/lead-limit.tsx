'use client';

import { Input } from '@/components/ui/input';
import { LEAD_LIMIT_PRESETS } from '@/lib/campaigns';
import { cn, formatNumber } from '@/lib/utils';

/** "How many leads" box: a number (null = all matching leads) with quick picks. */
export function LeadLimitField({ value, onChange, available }: { value: number | null; onChange: (v: number | null) => void; available?: number }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => onChange(null)}
        className={cn('h-7 rounded-md border px-2.5 text-xs font-medium', value === null ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:text-foreground')}
      >
        All{available !== undefined ? ` (${formatNumber(available)})` : ''}
      </button>
      {LEAD_LIMIT_PRESETS.map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          className={cn('h-7 rounded-md border px-2.5 text-xs font-medium tabular', value === n ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:text-foreground')}
        >
          {formatNumber(n)}
        </button>
      ))}
      <Input
        inputSize="sm"
        type="number"
        min={1}
        step={1}
        className="w-28"
        placeholder="Custom"
        aria-label="Number of leads"
        value={value ?? ''}
        onChange={(e) => {
          const n = Math.floor(Number(e.target.value));
          onChange(e.target.value && n > 0 ? n : null);
        }}
      />
    </div>
  );
}
