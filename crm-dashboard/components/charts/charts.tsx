'use client';

import * as React from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { format } from 'date-fns';
import { cn, formatNumber, formatPercent } from '@/lib/utils';

/** Ordered stages (sent → delivered → read → replied) as horizontal bars on the ordinal ramp. */
export function Funnel({ stages }: { stages: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, stages[0]?.value ?? 1);
  return (
    <div className="space-y-2.5">
      {stages.map((s, i) => (
        <div key={s.label} className="group grid grid-cols-[96px_1fr_92px] items-center gap-3 text-[13px]" title={`${s.label}: ${formatNumber(s.value)}`}>
          <span className="text-muted">{s.label}</span>
          <div className="h-6 rounded-r-[4px] bg-surface-2">
            <div
              className="h-full rounded-r-[4px] transition-[width] duration-500"
              style={{ width: `${Math.max(s.value ? 1.5 : 0, (s.value / max) * 100)}%`, background: `var(--ord-${Math.min(4, i + 1)})` }}
            />
          </div>
          <span className="text-right tabular">
            <b className="font-semibold">{formatNumber(s.value)}</b> <span className="text-xs text-subtle">{i === 0 ? '' : formatPercent(s.value, max)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Ranked magnitudes with labels (single hue). */
export function BarList({ items, empty = 'No data yet', color = 'var(--primary)', format: fmt = formatNumber }: { items: Array<{ label: React.ReactNode; value: number; key?: string; dot?: string }>; empty?: string; color?: string; format?: (n: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <p className="py-6 text-center text-[13px] text-subtle">{empty}</p>;
  return (
    <ul className="space-y-2">
      {items.map((it, idx) => (
        <li key={it.key ?? idx} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-[13px]">
          <div className="relative h-7 overflow-hidden rounded-md">
            <div className="absolute inset-y-0 left-0 rounded-md opacity-[0.14]" style={{ width: `${(it.value / max) * 100}%`, background: color }} />
            <div className="relative flex h-full items-center gap-2 px-2.5">
              {it.dot && <span className="size-2 shrink-0 rounded-full" style={{ background: it.dot }} />}
              <span className="truncate">{it.label}</span>
            </div>
          </div>
          <span className="tabular font-medium">{fmt(it.value)}</span>
        </li>
      ))}
    </ul>
  );
}

type SeriesDef = { key: string; label: string; color: string };

/** Daily columns; stacked when several ordered series are given. Hover shows a tooltip. */
export function DailyColumns({ data, series, height = 240, stacked = true }: { data: Array<Record<string, number | string>>; series: SeriesDef[]; height?: number; stacked?: boolean }) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -18 }} barCategoryGap="28%">
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={{ stroke: 'var(--border-strong)' }}
            tick={{ fill: 'var(--subtle)', fontSize: 11 }}
            tickFormatter={(d: string) => format(new Date(`${d}T00:00:00`), 'd MMM')}
            minTickGap={16}
          />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: 'var(--subtle)', fontSize: 11 }} width={44} />
          <RTooltip
            cursor={{ fill: 'var(--surface-2)' }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg">
                  <div className="mb-1 font-medium">{format(new Date(`${label}T00:00:00`), 'EEE d MMM')}</div>
                  {series.map((s) => {
                    const p = payload.find((x) => x.dataKey === s.key);
                    return (
                      <div key={s.key} className="flex items-center gap-2">
                        <span className="size-2 rounded-sm" style={{ background: s.color }} />
                        <span className="text-muted">{s.label}</span>
                        <span className="ml-auto pl-4 font-medium tabular">{formatNumber(Number(p?.value ?? 0))}</span>
                      </div>
                    );
                  })}
                </div>
              ) : null
            }
          />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId={stacked ? 'a' : undefined}
              fill={s.color}
              maxBarSize={24}
              radius={!stacked || i === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
              stroke="var(--surface)"
              strokeWidth={stacked ? 1 : 0}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Legend({ items, className }: { items: Array<{ label: string; color: string }>; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted', className)}>
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}
