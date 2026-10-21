'use client';

import * as React from 'react';
import { AlertCircle, AlertTriangle, CalendarClock, CheckCircle2, FileEdit, Rocket } from 'lucide-react';
import { TEMPLATE_VARIABLE_KEYS, estimateCampaignDuration, lintTemplate, warmupLimit } from '@batsols/shared';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useUsableAccounts } from '@/lib/queries';
import { cn, formatNumber } from '@/lib/utils';
import { useAudienceCount } from './audience-step';
import type { BuilderState } from './state';

export interface Check {
  level: 'ok' | 'warning' | 'error';
  text: string;
}

export function useChecks(state: BuilderState, eligible: number | undefined): Check[] {
  const { accounts } = useUsableAccounts();
  const chosen = accounts.filter((a) => state.account_ids.includes(a.id));
  const checks: Check[] = [];
  if (!state.name.trim()) checks.push({ level: 'error', text: 'Give the campaign a name' });
  if (eligible === 0) checks.push({ level: 'error', text: 'No leads will receive this campaign' });
  state.steps.forEach((st, i) =>
    st.variants.forEach((v, j) => {
      if (!v.body.trim() && !v.media_url) checks.push({ level: 'error', text: `${i === 0 ? 'First message' : `Follow-up ${i}`}, variant ${'ABCDE'[j]} is empty` });
      for (const issue of lintTemplate(v.body, TEMPLATE_VARIABLE_KEYS).filter((x) => x.level === 'error' && v.body.trim())) {
        checks.push({ level: 'error', text: `${i === 0 ? 'First message' : `Follow-up ${i}`} ${'ABCDE'[j]}: ${issue.message}` });
      }
    }),
  );
  if (!state.account_ids.length) checks.push({ level: 'error', text: 'Choose at least one WhatsApp number' });
  else if (!chosen.some((a) => a.status === 'connected')) checks.push({ level: 'warning', text: 'None of the chosen numbers is connected right now — the campaign will wait for them' });
  if (chosen.some((a) => !a.warmup_started_at && a.daily_limit > 60)) checks.push({ level: 'warning', text: 'Some numbers have a high daily limit without warm-up' });
  if (state.steps[0]?.variants.some((v) => /https?:\/\/|www\./i.test(v.body))) checks.push({ level: 'warning', text: 'The first message contains a link — consider sending links after they reply' });
  if (state.steps[0]?.variants.length === 1) checks.push({ level: 'warning', text: 'Tip: add a second variant to A/B test your opener' });
  if (state.settings.min_delay_sec < 30) checks.push({ level: 'warning', text: 'Gaps under 30 seconds raise the risk of a ban' });
  if (!checks.some((c) => c.level !== 'ok')) checks.push({ level: 'ok', text: 'Everything looks ready' });
  return checks;
}

export function ReviewStep({ state, set, campaignId }: { state: BuilderState; set: (fn: (s: BuilderState) => BuilderState) => void; campaignId?: string }) {
  const { accounts } = useUsableAccounts();
  const count = useAudienceCount(state.audience, state.settings.skip_landlines, campaignId);
  const checks = useChecks(state, count.data?.eligible);
  const chosen = accounts.filter((a) => state.account_ids.includes(a.id));
  const avgLimit = chosen.length ? Math.round(chosen.reduce((s, a) => s + warmupLimit(a.daily_limit, a.warmup_started_at, new Date()), 0) / chosen.length) : 40;
  const est = estimateCampaignDuration(count.data?.eligible ?? 0, chosen.length, state.settings, avgLimit);
  const s = state.settings;

  const rows: Array<[string, React.ReactNode]> = [
    ['Recipients', <b key="r" className="tabular">{formatNumber(count.data?.eligible ?? 0)} leads</b>],
    ['Messages', `${state.steps.length === 1 ? 'One message' : `${state.steps.length} messages (1 + ${state.steps.length - 1} follow-ups)`} · ${state.steps.reduce((n, st) => n + st.variants.length, 0)} variants`],
    ['Senders', chosen.map((a) => a.label).join(', ') || '—'],
    ['Pace', `${s.min_delay_sec}–${s.max_delay_sec}s apart, ${s.batch_pause_min}-min break every ${s.batch_size}`],
    ['Hours', `${s.window.start}–${s.window.end}, ${s.window.days.map((d) => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d]).join(' ')}`],
    ['Estimated time', est.days ? `≈ ${formatNumber(est.perDay)} messages/day → about ${est.days} day${est.days === 1 ? '' : 's'}` : '—'],
  ];

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <div className="space-y-5">
        <Card className="divide-y divide-border">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-4 px-5 py-3 text-[13.5px]">
              <span className="w-36 shrink-0 text-muted">{k}</span>
              <span className="min-w-0">{v}</span>
            </div>
          ))}
        </Card>
        <Card className="p-5">
          <div className="mb-3 text-[14px] font-semibold">When should it start?</div>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { id: 'now' as const, icon: Rocket, title: 'Start now', text: 'Begins within seconds (inside sending hours)' },
              { id: 'schedule' as const, icon: CalendarClock, title: 'Schedule', text: 'Pick a date and time' },
              { id: 'draft' as const, icon: FileEdit, title: 'Save as draft', text: 'Finish later' },
            ].map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => set((st) => ({ ...st, launch: o.id }))}
                className={cn('rounded-xl border p-3.5 text-left transition-colors', state.launch === o.id ? 'border-primary bg-primary-soft ring-1 ring-primary/30' : 'border-border hover:border-border-strong')}
              >
                <o.icon className={cn('size-4', state.launch === o.id ? 'text-primary' : 'text-subtle')} />
                <div className="mt-2 text-[13.5px] font-semibold">{o.title}</div>
                <div className="text-xs text-muted">{o.text}</div>
              </button>
            ))}
          </div>
          {state.launch === 'schedule' && (
            <Input type="datetime-local" className="mt-3 w-64" value={state.scheduled_at} onChange={(e) => set((st) => ({ ...st, scheduled_at: e.target.value }))} />
          )}
        </Card>
      </div>
      <Card className="h-fit p-5">
        <div className="mb-3 text-[14px] font-semibold">Pre-flight checks</div>
        <ul className="space-y-2.5">
          {checks.map((c) => (
            <li key={c.text} className={cn('flex items-start gap-2 text-[13px]', c.level === 'error' ? 'text-danger' : c.level === 'warning' ? 'text-warning' : 'text-success')}>
              {c.level === 'error' ? <AlertCircle className="mt-0.5 size-4 shrink-0" /> : c.level === 'warning' ? <AlertTriangle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
              <span className="text-foreground/90">{c.text}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
