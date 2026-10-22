'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { COUNTRIES, DEFAULT_OPT_OUT_KEYWORDS, allCountries, isValidTimezone, type WorkspaceSettings } from '@batsols/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { SwitchRow } from '@/components/ui/controls';
import { Callout, useConfirm } from '@/components/ui/feedback';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { TagInput } from '@/components/ui/multi-select';
import { getSupabase } from '@/lib/supabase/client';
import { useWorkspace } from '@/lib/workspace';
import { errorMessage } from '@/lib/utils';

const CURRENCIES = ['USD', 'PKR', 'AED', 'SAR', 'GBP', 'EUR', 'INR', 'CAD', 'AUD', 'BDT', 'QAR', 'KWD', 'OMR', 'BHD', 'TRY', 'EGP', 'NGN', 'ZAR', 'MYR', 'IDR'];

/** "PKR — Pakistani Rupee" */
function currencyLabel(code: string) {
  try {
    return `${code} — ${new Intl.DisplayNames(['en'], { type: 'currency' }).of(code) ?? code}`;
  } catch {
    return code;
  }
}

const TIMEZONES = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? COUNTRIES.map((c) => c.timezone);
  } catch {
    return COUNTRIES.map((c) => c.timezone);
  }
})();

export default function GeneralSettingsPage() {
  const { workspace, setWorkspace, can } = useWorkspace();
  const router = useRouter();
  const confirm = useConfirm();
  const [form, setForm] = React.useState({
    name: workspace.name,
    timezone: workspace.timezone,
    default_country: workspace.default_country,
    settings: {
      currency: 'USD',
      company_name: '',
      opt_out_keywords: DEFAULT_OPT_OUT_KEYWORDS,
      capture_unknown_inbound: false,
      auto_stage_on_send: true,
      auto_stage_on_reply: true,
      ...workspace.settings,
    } as Required<WorkspaceSettings>,
  });
  const [saving, setSaving] = React.useState(false);
  const setS = <K extends keyof WorkspaceSettings>(k: K, v: WorkspaceSettings[K]) => setForm((f) => ({ ...f, settings: { ...f.settings, [k]: v } }));
  const disabled = !can.admin;

  async function save() {
    if (!isValidTimezone(form.timezone)) return toast.error('Unknown time zone');
    setSaving(true);
    const { data, error } = await getSupabase()
      .from('workspaces')
      .update({ name: form.name.trim(), timezone: form.timezone, default_country: form.default_country, settings: form.settings })
      .eq('id', workspace.id)
      .select('*')
      .single();
    setSaving(false);
    if (error) return toast.error(errorMessage(error));
    setWorkspace(data);
    toast.success('Workspace saved');
    router.refresh();
  }

  async function deleteWorkspace() {
    const ok = await confirm({
      title: `Delete “${workspace.name}”?`,
      description: 'Every lead, campaign, conversation and connected WhatsApp number in this workspace is permanently deleted. Your teammates lose access immediately.',
      confirmLabel: 'Delete workspace',
      danger: true,
    });
    if (!ok) return;
    const { error } = await getSupabase().from('workspaces').delete().eq('id', workspace.id);
    if (error) return toast.error(errorMessage(error));
    toast.success('Workspace deleted');
    router.replace('/dashboard');
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {disabled && <Callout tone="info">Only owners and admins can change workspace settings.</Callout>}
      <Card>
        <CardHeader title="Workspace" description="Name, region and defaults used across BatSols." />
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Workspace name" htmlFor="name">
            <Input id="name" value={form.name} disabled={disabled} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Company name in messages" htmlFor="company" hint="Fills {{company_name}} in templates.">
            <Input id="company" value={form.settings.company_name} disabled={disabled} placeholder={workspace.name} onChange={(e) => setS('company_name', e.target.value)} />
          </Field>
          <Field label="Default country" hint="How local phone numbers (e.g. 0300…) are read.">
            <NativeSelect value={form.default_country} disabled={disabled} onChange={(e) => setForm({ ...form, default_country: e.target.value })}>
              {allCountries().map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Time zone" hint="Used for sending windows and daily limits.">
            <NativeSelect value={form.timezone} disabled={disabled} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, ' ')}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Currency" hint="For deal values.">
            <NativeSelect value={form.settings.currency} disabled={disabled} onChange={(e) => setS('currency', e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {currencyLabel(c)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="Automation & compliance" description="How BatSols reacts to sends and replies." />
        <CardContent className="divide-y divide-border">
          <SwitchRow
            label="Move leads to “Contacted” after the first message"
            description="Only leads still in your first stage are moved."
            checked={form.settings.auto_stage_on_send}
            onCheckedChange={(v) => setS('auto_stage_on_send', v)}
            disabled={disabled}
          />
          <SwitchRow
            label="Move leads to “Replied” when they answer"
            description="Only from the New or Contacted stage, so manual progress is never undone."
            checked={form.settings.auto_stage_on_reply}
            onCheckedChange={(v) => setS('auto_stage_on_reply', v)}
            disabled={disabled}
          />
          <SwitchRow
            label="Shared lead bank"
            description="On (default): the whole team works one lead inventory — everyone sees every lead and what teammates already found, so nobody scrapes the same businesses twice. Off: each member only sees their own leads plus lists, campaigns and numbers shared with them."
            checked={(form.settings as { members_see_all_leads?: boolean }).members_see_all_leads !== false}
            onCheckedChange={(v) => setForm((f) => ({ ...f, settings: { ...f.settings, members_see_all_leads: v } as typeof f.settings }))}
            disabled={disabled}
          />
          <SwitchRow
            label="Capture chats from unknown numbers"
            description="Off: only replies from existing leads appear in the inbox, so teammates’ personal chats stay private. On: every incoming chat becomes a lead."
            checked={form.settings.capture_unknown_inbound}
            onCheckedChange={(v) => setS('capture_unknown_inbound', v)}
            disabled={disabled}
          />
          <div className="py-3">
            <div className="text-[13.5px] font-medium">Opt-out keywords</div>
            <div className="mb-2 mt-0.5 text-[12.5px] text-muted">A reply matching one of these marks the lead as opted out and stops every campaign for them.</div>
            <TagInput value={form.settings.opt_out_keywords} onChange={(v) => setS('opt_out_keywords', v)} placeholder="Add keyword" />
          </div>
        </CardContent>
        {!disabled && (
          <CardFooter>
            <Button variant="primary" onClick={save} loading={saving}>
              Save changes
            </Button>
          </CardFooter>
        )}
      </Card>

      {can.owner && (
        <Card className="border-danger/30">
          <CardHeader title="Danger zone" description="Deleting a workspace can’t be undone." />
          <CardContent>
            <Button variant="danger" onClick={deleteWorkspace}>
              <Trash2 /> Delete workspace
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
