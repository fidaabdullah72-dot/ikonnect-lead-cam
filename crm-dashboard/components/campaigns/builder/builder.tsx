'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, MessageSquareText, Rocket, Send, Users } from 'lucide-react';
import { toast } from 'sonner';
import { normalizeCampaignSettings, type Campaign, type CampaignStep } from '@batsols/shared';
import { Button } from '@/components/ui/button';
import { PageSpinner } from '@/components/ui/spinner';
import { getSupabase } from '@/lib/supabase/client';
import { cleanFilters } from '@/lib/leads';
import { qk, useUsableAccounts } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, errorMessage } from '@/lib/utils';
import { AudienceStep, useAudienceCount } from './audience-step';
import { MessagesStep } from './messages-step';
import { ReviewStep, useChecks } from './review-step';
import { SendingStep } from './sending-step';
import { effectiveFilters, initialState, newKey, type BuilderState } from './state';

const STEPS = [
  { id: 'audience', label: 'Audience', icon: Users, hint: 'Who gets it' },
  { id: 'messages', label: 'Messages', icon: MessageSquareText, hint: 'What they get' },
  { id: 'sending', label: 'Sending', icon: Send, hint: 'How and when' },
  { id: 'review', label: 'Review', icon: Rocket, hint: 'Check and launch' },
] as const;

export function CampaignBuilder({ campaignId }: { campaignId?: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const { workspace, userId } = useWorkspace();
  const { accounts } = useUsableAccounts();
  const [state, setState] = React.useState<BuilderState>(() => {
    const s = initialState(workspace.timezone);
    // A list handed over from the Lead lists page (/campaigns/new?list=…).
    const list = campaignId ? null : params.get('list');
    return list ? { ...s, audience: { ...s.audience, mode: 'lists', list_ids: [list] } } : s;
  });
  const [step, setStep] = React.useState(0);
  const [loaded, setLoaded] = React.useState(!campaignId);
  const [existing, setExisting] = React.useState<Campaign | null>(null);
  const [saving, setSaving] = React.useState(false);
  const set = React.useCallback((fn: (s: BuilderState) => BuilderState) => setState(fn), []);
  const count = useAudienceCount(state.audience, state.settings.skip_landlines, campaignId);
  const checks = useChecks(state, count.data?.eligible);
  const blocked = checks.some((c) => c.level === 'error');
  const isLive = existing && ['running', 'paused', 'scheduled'].includes(existing.status);

  // Selection handed over from the Leads page.
  React.useEffect(() => {
    if (campaignId || params.get('from') !== 'leads') return;
    try {
      const raw = sessionStorage.getItem('bs:campaign-audience');
      if (!raw) return;
      const sel = JSON.parse(raw) as { ids: string[] | null; filters: BuilderState['audience']['filters']; count: number };
      sessionStorage.removeItem('bs:campaign-audience');
      set((s) => ({ ...s, audience: { ...s.audience, ...(sel.ids ? { mode: 'selection', ids: sel.ids } : { mode: 'filters', filters: sel.filters }) } }));
    } catch {
      /* ignore */
    }
  }, [campaignId, params, set]);

  // Default sender: my connected numbers.
  React.useEffect(() => {
    if (campaignId) return;
    set((s) => (s.account_ids.length ? s : { ...s, account_ids: accounts.filter((a) => a.owner_id === userId && a.status === 'connected').map((a) => a.id) }));
  }, [accounts, campaignId, userId, set]);

  // Edit mode: load the campaign.
  React.useEffect(() => {
    if (!campaignId) return;
    void (async () => {
      const sb = getSupabase();
      const [{ data: c }, { data: steps }] = await Promise.all([
        sb.from('campaigns').select('*').eq('id', campaignId).maybeSingle(),
        sb.from('campaign_steps').select('*').eq('campaign_id', campaignId).order('position'),
      ]);
      if (!c) {
        toast.error('Campaign not found');
        router.replace('/campaigns');
        return;
      }
      setExisting(c);
      const aud = c.audience as {
        mode?: BuilderState['audience']['mode'];
        ids?: string[] | null;
        list_ids?: string[] | null;
        filters?: BuilderState['audience']['filters'];
        options?: Partial<BuilderState['audience']>;
      };
      setState({
        ...initialState(workspace.timezone),
        name: c.name,
        description: c.description ?? '',
        audience: {
          ...initialState(workspace.timezone).audience,
          ...(aud.options ?? {}),
          filters: aud.filters ?? {},
          ...(aud.mode === 'selection' && aud.ids
            ? { mode: 'selection', ids: aud.ids }
            : aud.mode === 'lists'
              ? { mode: 'lists', ids: null, list_ids: aud.list_ids ?? [] }
              : { mode: 'filters', ids: null }),
        },
        steps: (steps as CampaignStep[]).length
          ? (steps as CampaignStep[]).map((st) => ({ key: newKey(), delay_hours: st.delay_hours, variants: st.variants.length ? st.variants : [{ body: '' }] }))
          : initialState(workspace.timezone).steps,
        account_ids: c.account_ids,
        settings: normalizeCampaignSettings(c.settings, workspace.timezone),
        launch: c.status === 'draft' ? 'now' : 'draft',
        scheduled_at: c.scheduled_at ? c.scheduled_at.slice(0, 16) : '',
      });
      setStep(c.status === 'draft' ? 0 : 1);
      setLoaded(true);
    })();
  }, [campaignId, router, workspace.timezone]);

  async function save() {
    if (blocked) {
      toast.error(checks.find((c) => c.level === 'error')?.text ?? 'Fix the issues first');
      setStep(3);
      return;
    }
    if (state.launch === 'schedule' && !state.scheduled_at) return toast.error('Pick a start date and time');
    setSaving(true);
    const sb = getSupabase();
    try {
      const filters = cleanFilters(effectiveFilters(state.audience, state.settings.skip_landlines));
      const audience = {
        mode: state.audience.mode,
        filters: cleanFilters(state.audience.filters),
        ids: state.audience.mode === 'selection' ? (state.audience.ids ?? []) : null,
        // Lists picked here, or (other modes) lists whose leads were added to the campaign later.
        list_ids: state.audience.mode === 'lists' ? state.audience.list_ids : (existing?.audience?.list_ids ?? null),
        options: { skipActive: state.audience.skipActive, skipContactedDays: state.audience.skipContactedDays, onlyVerified: state.audience.onlyVerified },
        lead_count: count.data?.eligible ?? 0,
      };
      const row = {
        name: state.name.trim(),
        description: state.description.trim() || null,
        audience,
        account_ids: state.account_ids,
        settings: state.settings,
        scheduled_at: state.launch === 'schedule' ? new Date(state.scheduled_at).toISOString() : null,
      };

      let id = campaignId;
      if (id) {
        const { error } = await sb.from('campaigns').update(row).eq('id', id);
        if (error) throw error;
        await sb.from('campaign_steps').delete().eq('campaign_id', id);
      } else {
        const { data, error } = await sb.from('campaigns').insert({ ...row, workspace_id: workspace.id, created_by: userId, status: 'draft' }).select('id').single();
        if (error) throw error;
        id = data.id;
      }

      const { error: stepErr } = await sb.from('campaign_steps').insert(
        state.steps.map((st, i) => ({
          workspace_id: workspace.id,
          campaign_id: id!,
          position: i,
          delay_hours: i === 0 ? 0 : st.delay_hours,
          variants: st.variants.filter((v) => v.body.trim() || v.media_url),
        })),
      );
      if (stepErr) throw stepErr;

      // Audience: drafts are rebuilt from the filters; live campaigns keep theirs.
      if (!isLive) {
        if (campaignId) await sb.from('campaign_recipients').delete().eq('campaign_id', id!).eq('status', 'pending');
        const { error: recErr } = await sb.rpc('campaign_add_recipients', { p_campaign: id!, p_filters: { ...filters, exclude_campaign_id: id! } });
        if (recErr) throw recErr;
      }

      if (!isLive) {
        const status = state.launch === 'now' ? 'running' : state.launch === 'schedule' ? 'scheduled' : 'draft';
        const { error } = await sb.from('campaigns').update({ status, ...(status === 'running' ? { paused_reason: null } : {}) }).eq('id', id!);
        if (error) throw error;
        toast.success(status === 'running' ? 'Campaign launched' : status === 'scheduled' ? 'Campaign scheduled' : 'Draft saved');
      } else {
        toast.success('Campaign updated');
      }
      qc.invalidateQueries({ queryKey: qk.campaigns(workspace.id) });
      qc.invalidateQueries({ queryKey: qk.campaign(id!) });
      router.push(`/campaigns/${id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return <PageSpinner label="Loading campaign…" />;

  const last = step === STEPS.length - 1;

  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-20 border-b border-border bg-panel/90 px-4 py-4 backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href={campaignId ? `/campaigns/${campaignId}` : '/campaigns'} aria-label="Back">
              <ArrowLeft />
            </Link>
          </Button>
          <input
            value={state.name}
            onChange={(e) => set((s) => ({ ...s, name: e.target.value }))}
            placeholder="Name your campaign…"
            className="min-w-[200px] flex-1 bg-transparent text-xl font-semibold tracking-[-0.02em] outline-none placeholder:text-subtle"
            autoFocus={!campaignId}
          />
          <nav className="flex items-center gap-1">
            {STEPS.map((s, i) => {
              const done = i < step;
              return (
                <button
                  key={s.id}
                  onClick={() => setStep(i)}
                  className={cn(
                    'flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] font-medium transition-colors',
                    i === step ? 'bg-surface text-foreground shadow-sm ring-1 ring-border' : 'text-muted hover:text-foreground',
                  )}
                >
                  <span className={cn('flex size-5 items-center justify-center rounded-full text-[11px]', done ? 'bg-success text-white' : i === step ? 'bg-primary text-white' : 'bg-surface-3')}>
                    {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="hidden md:inline">{s.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      <div className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 sm:px-8">
        <div className="mb-5">
          <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{STEPS[step]!.label}</h2>
          <p className="text-[13px] text-muted">
            {step === 0 && 'Choose who receives this campaign. Opted-out leads and leads without a phone are always excluded.'}
            {step === 1 && 'Write the first message and optional follow-ups. Use variables and variations so every message is personal and unique.'}
            {step === 2 && 'Pick the numbers to send from and how fast. The defaults are tuned to keep numbers safe.'}
            {step === 3 && (isLive ? 'Changes apply to messages that haven’t been sent yet.' : 'Double-check and launch.')}
          </p>
        </div>
        {step === 0 &&
          (isLive ? (
            <div className="rounded-xl border border-border bg-surface p-5 text-[13.5px] text-muted">
              This campaign is already live. Add more leads from the campaign page with “Add leads”.
            </div>
          ) : (
            <AudienceStep state={state} set={set} campaignId={campaignId} />
          ))}
        {step === 1 && <MessagesStep state={state} set={set} />}
        {step === 2 && <SendingStep state={state} set={set} />}
        {step === 3 && <ReviewStep state={state} set={set} campaignId={campaignId} />}
      </div>

      <div className="sticky bottom-0 z-20 border-t border-border bg-panel/90 px-4 py-3 backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-3">
          <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
            <ArrowLeft /> Back
          </Button>
          <div className="hidden text-xs text-subtle sm:block">{STEPS[step]!.hint}</div>
          {last ? (
            <Button variant="primary" onClick={save} loading={saving} disabled={blocked && !isLive}>
              {isLive ? (
                'Save changes'
              ) : state.launch === 'now' ? (
                <>
                  <Rocket /> Launch campaign
                </>
              ) : state.launch === 'schedule' ? (
                'Schedule campaign'
              ) : (
                'Save draft'
              )}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setStep((s) => s + 1)}>
              Continue <ArrowRight />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
