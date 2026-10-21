'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { normalizePhone, type Lead } from '@batsols/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { TagInput } from '@/components/ui/multi-select';
import { getSupabase } from '@/lib/supabase/client';
import { useLeadFacets, useMembers, useStages } from '@/lib/queries';
import { leadInputToRow, useInvalidateLeads, type LeadInput } from '@/lib/leads';
import { useWorkspace } from '@/lib/workspace';
import { errorMessage } from '@/lib/utils';

export function LeadFormDialog({
  open,
  onOpenChange,
  lead,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  lead?: Lead | null;
  onSaved?: (lead: Lead) => void;
}) {
  const { workspace, userId, can } = useWorkspace();
  const { stages } = useStages();
  const { members } = useMembers();
  const facets = useLeadFacets();
  const invalidate = useInvalidateLeads();

  const initial = React.useMemo<LeadInput>(
    () => ({
      business_name: lead?.business_name ?? '',
      contact_name: lead?.contact_name ?? '',
      phone: lead?.phone ? `+${lead.phone}` : '',
      email: lead?.email ?? '',
      website: lead?.website ?? '',
      address: lead?.address ?? '',
      city: lead?.city ?? '',
      category: lead?.category ?? '',
      tags: lead?.tags ?? [],
      stage_id: lead?.stage_id ?? null,
      owner_id: lead ? lead.owner_id : userId,
      deal_value: lead?.deal_value ?? 0,
    }),
    [lead, userId],
  );
  const [form, setForm] = React.useState<LeadInput>(initial);
  React.useEffect(() => {
    if (open) setForm(initial);
  }, [open, initial]);

  const set = <K extends keyof LeadInput>(k: K, v: LeadInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const phonePreview = form.phone?.trim() ? normalizePhone(form.phone, workspace.default_country) : null;

  const save = useMutation({
    mutationFn: async () => {
      const row = leadInputToRow(form, workspace.default_country);
      const sb = getSupabase();
      if (lead) {
        const { data, error } = await sb.from('leads').update(row).eq('id', lead.id).select('*').single();
        if (error) throw error;
        return data as Lead;
      }
      const { data, error } = await sb
        .from('leads')
        .insert({ ...row, business_name: row.business_name!, workspace_id: workspace.id, source: 'manual' })
        .select('*')
        .single();
      if (error) throw error;
      return data as Lead;
    },
    onSuccess: (saved) => {
      invalidate(saved.id);
      toast.success(lead ? 'Lead updated' : 'Lead added');
      onOpenChange(false);
      onSaved?.(saved);
    },
    onError: (e) => {
      const msg = (e as { code?: string }).code === '23505' ? 'A lead with this phone number already exists.' : errorMessage(e);
      toast.error(msg);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" title={lead ? 'Edit lead' : 'Add a lead'} description={lead ? undefined : can.scrape ? 'Add a business by hand. Use the Lead finder to pull them from Google Maps in bulk.' : 'Add a business by hand.'}>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Business name" htmlFor="bn" className="sm:col-span-2">
              <Input id="bn" required autoFocus value={form.business_name} onChange={(e) => set('business_name', e.target.value)} placeholder="Smile Dental Clinic" />
            </Field>
            <Field
              label="Phone"
              htmlFor="ph"
              hint={
                phonePreview ? (
                  <span className={phonePreview.valid ? 'text-success' : 'text-warning'}>
                    {phonePreview.display} · {phonePreview.type === 'unknown' ? (phonePreview.valid ? 'valid' : 'unverified format') : phonePreview.type}
                  </span>
                ) : (
                  `Local numbers are read as ${workspace.default_country}.`
                )
              }
            >
              <Input id="ph" value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="0300 1234567" />
            </Field>
            <Field label="Contact person" htmlFor="cn" optional>
              <Input id="cn" value={form.contact_name} onChange={(e) => set('contact_name', e.target.value)} placeholder="Dr. Ahmed" />
            </Field>
            <Field label="Email" htmlFor="em" optional>
              <Input id="em" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="hello@business.com" />
            </Field>
            <Field label="Website" htmlFor="ws" optional>
              <Input id="ws" value={form.website} onChange={(e) => set('website', e.target.value)} placeholder="business.com" />
            </Field>
            <Field label="Category" htmlFor="cat" optional>
              <Input id="cat" list="bs-categories" value={form.category} onChange={(e) => set('category', e.target.value)} placeholder="Dentists" />
              <datalist id="bs-categories">{facets.data?.categories.map((c) => <option key={c.value} value={c.value} />)}</datalist>
            </Field>
            <Field label="City" htmlFor="city" optional>
              <Input id="city" list="bs-cities" value={form.city} onChange={(e) => set('city', e.target.value)} placeholder="Lahore" />
              <datalist id="bs-cities">{facets.data?.cities.map((c) => <option key={c.value} value={c.value} />)}</datalist>
            </Field>
            <Field label="Address" htmlFor="addr" optional className="sm:col-span-2">
              <Input id="addr" value={form.address} onChange={(e) => set('address', e.target.value)} />
            </Field>
            <Field label="Stage" htmlFor="stage">
              <NativeSelect id="stage" value={form.stage_id ?? ''} onChange={(e) => set('stage_id', e.target.value || null)}>
                <option value="">Default (first stage)</option>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Owner" htmlFor="owner">
              <NativeSelect id="owner" value={form.owner_id ?? ''} onChange={(e) => set('owner_id', e.target.value || null)}>
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.profile.full_name || m.profile.email}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Tags" className="sm:col-span-2" optional>
              <TagInput value={form.tags ?? []} onChange={(v) => set('tags', v)} suggestions={facets.data?.tags.map((t) => t.value)} />
            </Field>
            <Field label="Deal value" htmlFor="dv" optional hint="Expected value if you win this lead.">
              <Input id="dv" type="number" min={0} step="1" value={form.deal_value ?? 0} onChange={(e) => set('deal_value', Number(e.target.value))} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending}>
              {lead ? 'Save changes' : 'Add lead'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
