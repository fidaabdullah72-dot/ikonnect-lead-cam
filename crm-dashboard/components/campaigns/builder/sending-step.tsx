'use client';

import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, Gauge, Plus, ShieldCheck, Timer } from 'lucide-react';
import { formatPhone, warmupLimit, type CampaignSettings } from '@batsols/shared';
import { WhatsAppIcon } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { SwitchRow } from '@/components/ui/controls';
import { Callout } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/input';
import { useMembers, useUsableAccounts } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { PACE_PRESETS, type BuilderState } from './state';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function SendingStep({ state, set }: { state: BuilderState; set: (fn: (s: BuilderState) => BuilderState) => void }) {
  const { accounts } = useUsableAccounts();
  const { byId } = useMembers();
  const s = state.settings;
  const setS = (patch: Partial<CampaignSettings>) => set((st) => ({ ...st, settings: { ...st.settings, ...patch } }));
  const toggleAccount = (id: string) =>
    set((st) => ({ ...st, account_ids: st.account_ids.includes(id) ? st.account_ids.filter((x) => x !== id) : [...st.account_ids, id] }));
  const preset = PACE_PRESETS.find((p) => p.values.min_delay_sec === s.min_delay_sec && p.values.max_delay_sec === s.max_delay_sec && p.values.batch_size === s.batch_size && p.values.batch_pause_min === s.batch_pause_min)?.id;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader icon={<WhatsAppIcon />} title="Send from" description="Pick one or more numbers. With several, BatSols rotates between them and each keeps its own pace and daily limit." />
        <CardContent>
          {accounts.length === 0 ? (
            <Callout tone="warning" title="No WhatsApp numbers yet">
              <Link href="/whatsapp?connect=1" className="font-medium text-primary hover:underline">
                Connect a number
              </Link>{' '}
              first, then come back. Your draft is kept.
            </Callout>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {accounts.map((a) => {
                const on = state.account_ids.includes(a.id);
                const owner = a.owner_id ? byId.get(a.owner_id) : undefined;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => toggleAccount(a.id)}
                    className={cn(
                      'relative flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors',
                      on ? 'border-whatsapp/60 bg-whatsapp-soft ring-1 ring-whatsapp/30' : 'border-border bg-surface hover:border-border-strong',
                    )}
                  >
                    <span className={cn('flex size-9 items-center justify-center rounded-lg', a.status === 'connected' ? 'bg-whatsapp-soft text-whatsapp' : 'bg-surface-2 text-subtle')}>
                      <WhatsAppIcon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-semibold">{a.label}</div>
                      <div className="truncate font-mono text-xs text-muted">{a.phone ? formatPhone(a.phone) : 'not linked'}</div>
                      <div className="mt-1 text-[11.5px] text-subtle">
                        {a.status === 'connected' ? (
                          <span className="text-whatsapp">● Connected</span>
                        ) : (
                          <span className="text-warning">● {a.status === 'connecting' ? 'Reconnecting' : 'Offline — will wait'}</span>
                        )}{' '}
                        · {warmupLimit(a.daily_limit, a.warmup_started_at, new Date())}/day{owner ? ` · ${owner.profile.full_name.split(' ')[0]}` : ''}
                      </div>
                    </div>
                    {on && <CheckCircle2 className="absolute right-3 top-3 size-4 text-whatsapp" />}
                  </button>
                );
              })}
              <Link href="/whatsapp?connect=1" className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong p-3.5 text-[13px] font-medium text-muted hover:border-primary hover:text-primary">
                <Plus className="size-4" /> Connect another
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader icon={<Gauge />} title="Pace" description="Random gaps between messages and regular breaks make sending look human." />
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {PACE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setS(p.values)}
                className={cn('rounded-xl border p-3.5 text-left transition-colors', preset === p.id ? 'border-primary bg-primary-soft ring-1 ring-primary/30' : 'border-border hover:border-border-strong')}
              >
                <div className="flex items-center gap-2 text-[13.5px] font-semibold">
                  {p.label} {p.id === 'balanced' && <span className="rounded bg-success-soft px-1.5 text-[10px] font-semibold uppercase text-success">Recommended</span>}
                </div>
                <div className="mt-0.5 text-xs text-muted">{p.hint}</div>
                <div className="mt-2 text-[11.5px] text-subtle tabular">
                  {p.values.min_delay_sec}–{p.values.max_delay_sec}s apart · break {p.values.batch_pause_min} min every {p.values.batch_size}
                </div>
              </button>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-5">
            <Field label="Min gap (sec)">
              <Input type="number" min={10} value={s.min_delay_sec} onChange={(e) => setS({ min_delay_sec: Number(e.target.value) })} />
            </Field>
            <Field label="Max gap (sec)">
              <Input type="number" min={10} value={s.max_delay_sec} onChange={(e) => setS({ max_delay_sec: Number(e.target.value) })} />
            </Field>
            <Field label="Break every">
              <Input type="number" min={1} value={s.batch_size} onChange={(e) => setS({ batch_size: Number(e.target.value) })} />
            </Field>
            <Field label="Break (min)">
              <Input type="number" min={0} value={s.batch_pause_min} onChange={(e) => setS({ batch_pause_min: Number(e.target.value) })} />
            </Field>
            <Field label="Max / number / day" hint="Empty = number’s limit">
              <Input type="number" min={1} value={s.daily_limit ?? ''} placeholder="—" onChange={(e) => setS({ daily_limit: e.target.value ? Number(e.target.value) : null })} />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader icon={<Timer />} title="Sending hours" description={`Messages only go out inside this window (${s.window.timezone.replace(/_/g, ' ')}). Outside it, the campaign waits and resumes automatically.`} />
        <CardContent className="flex flex-wrap items-end gap-4">
          <Field label="From">
            <Input type="time" value={s.window.start} onChange={(e) => setS({ window: { ...s.window, start: e.target.value } })} className="w-32" />
          </Field>
          <Field label="To">
            <Input type="time" value={s.window.end} onChange={(e) => setS({ window: { ...s.window, end: e.target.value } })} className="w-32" />
          </Field>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((d, i) => {
              const day = i + 1;
              const on = s.window.days.includes(day);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => setS({ window: { ...s.window, days: on ? s.window.days.filter((x) => x !== day) : [...s.window.days, day].sort() } })}
                  className={cn('h-9 w-12 rounded-lg border text-[13px] font-medium transition-colors', on ? 'border-primary bg-primary text-white' : 'border-border text-muted hover:text-foreground')}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader icon={<ShieldCheck />} title="Safety & personalisation" />
        <CardContent className="divide-y divide-border">
          <SwitchRow label="Show “typing…” before each message" description="The recipient sees you typing for a few seconds, like a real person." checked={s.typing} onCheckedChange={(v) => setS({ typing: v })} />
          <SwitchRow label="Check the number is on WhatsApp before sending" description="Unknown numbers are looked up first and skipped if not registered." checked={s.verify_whatsapp} onCheckedChange={(v) => setS({ verify_whatsapp: v })} />
          <SwitchRow label="Stop the sequence when they reply" description="No more follow-ups once a lead answers. They appear in the inbox." checked={s.stop_on_reply} onCheckedChange={(v) => setS({ stop_on_reply: v })} />
          <SwitchRow label="Skip landline numbers" description="Landlines rarely have WhatsApp." checked={s.skip_landlines} onCheckedChange={(v) => setS({ skip_landlines: v })} />
          <div className="grid gap-4 py-3 sm:grid-cols-2">
            <Field label="Your name in messages" hint="{{sender_name}} — defaults to the number owner’s name">
              <Input value={s.sender_name} onChange={(e) => setS({ sender_name: e.target.value })} placeholder="Sara" />
            </Field>
            <Field label="Company name in messages" hint="{{company_name}}">
              <Input value={s.company_name} onChange={(e) => setS({ company_name: e.target.value })} placeholder="BatSols" />
            </Field>
          </div>
        </CardContent>
      </Card>
      {state.account_ids.length === 0 && accounts.length > 0 && (
        <Callout tone="warning">
          Select at least one number above. <Button variant="link" className="h-auto px-0 text-[13px]" onClick={() => set((st) => ({ ...st, account_ids: accounts.filter((a) => a.status === 'connected').map((a) => a.id) }))}>Use all connected numbers</Button>
        </Callout>
      )}
    </div>
  );
}
