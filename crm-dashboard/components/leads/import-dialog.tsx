'use client';

import * as React from 'react';
import Papa from 'papaparse';
import { ArrowRight, CheckCircle2, FileSpreadsheet, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { normalizePhone, type Lead } from '@batsols/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field, NativeSelect } from '@/components/ui/input';
import { TagInput } from '@/components/ui/multi-select';
import { Callout } from '@/components/ui/feedback';
import { Progress } from '@/components/ui/controls';
import { getSupabase } from '@/lib/supabase/client';
import { useMembers, useStages } from '@/lib/queries';
import { normalizeWebsite, useInvalidateLeads } from '@/lib/leads';
import { useWorkspace } from '@/lib/workspace';
import { cn, errorMessage, formatNumber } from '@/lib/utils';

const TARGETS = [
  { key: 'business_name', label: 'Business name', required: true, guess: ['business', 'name', 'company', 'title', 'business_name'] },
  { key: 'phone', label: 'Phone', guess: ['phone', 'mobile', 'whatsapp', 'number', 'contact', 'tel'] },
  { key: 'contact_name', label: 'Contact person', guess: ['contact name', 'person', 'owner', 'first name', 'full name'] },
  { key: 'email', label: 'Email', guess: ['email', 'e-mail', 'mail'] },
  { key: 'website', label: 'Website', guess: ['website', 'site', 'url', 'web'] },
  { key: 'address', label: 'Address', guess: ['address', 'street', 'location'] },
  { key: 'city', label: 'City', guess: ['city', 'town'] },
  { key: 'category', label: 'Category', guess: ['category', 'industry', 'type', 'niche'] },
  { key: 'rating', label: 'Rating', guess: ['rating', 'stars'] },
  { key: 'reviews_count', label: 'Reviews', guess: ['reviews', 'review count', 'reviews_count'] },
  { key: 'tags', label: 'Tags', guess: ['tags', 'labels'] },
] as const;

type TargetKey = (typeof TARGETS)[number]['key'];

function guessMapping(headers: string[]): Partial<Record<TargetKey, string>> {
  const map: Partial<Record<TargetKey, string>> = {};
  const used = new Set<string>();
  for (const t of TARGETS) {
    const hit =
      headers.find((h) => !used.has(h) && t.guess.some((g) => h.toLowerCase().trim() === g)) ??
      headers.find((h) => !used.has(h) && t.guess.some((g) => h.toLowerCase().includes(g)));
    if (hit) {
      map[t.key] = hit;
      used.add(hit);
    }
  }
  return map;
}

export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { workspace, userId } = useWorkspace();
  const { stages } = useStages();
  const { members } = useMembers();
  const invalidate = useInvalidateLeads();
  const [step, setStep] = React.useState<'upload' | 'map' | 'importing' | 'done'>('upload');
  const [fileName, setFileName] = React.useState('');
  const [rows, setRows] = React.useState<Record<string, string>[]>([]);
  const [headers, setHeaders] = React.useState<string[]>([]);
  const [mapping, setMapping] = React.useState<Partial<Record<TargetKey, string>>>({});
  const [tags, setTags] = React.useState<string[]>([]);
  const [stageId, setStageId] = React.useState('');
  const [ownerId, setOwnerId] = React.useState(userId);
  const [progress, setProgress] = React.useState(0);
  const [result, setResult] = React.useState({ inserted: 0, duplicates: 0, invalid: 0 });
  const [drag, setDrag] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setStep('upload');
      setRows([]);
      setHeaders([]);
      setMapping({});
      setProgress(0);
      setTags([]);
    }
  }, [open]);

  function onFile(file: File) {
    setFileName(file.name);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const hs = (res.meta.fields ?? []).filter(Boolean);
        if (!hs.length || !res.data.length) {
          toast.error('That file has no rows we can read.');
          return;
        }
        setHeaders(hs);
        setRows(res.data);
        setMapping(guessMapping(hs));
        setTags([`import-${new Date().toISOString().slice(0, 10)}`]);
        setStep('map');
      },
      error: (err) => toast.error(err.message),
    });
  }

  async function runImport() {
    setStep('importing');
    const seen = new Set<string>();
    let invalid = 0;
    let fileDupes = 0;
    const prepared: Array<Partial<Lead> & { workspace_id: string; business_name: string }> = [];
    for (const r of rows) {
      const get = (k: TargetKey) => (mapping[k] ? (r[mapping[k]!] ?? '').toString().trim() : '');
      const name = get('business_name');
      if (!name) {
        invalid++;
        continue;
      }
      const phone = normalizePhone(get('phone'), workspace.default_country);
      if (phone) {
        if (seen.has(phone.digits)) {
          fileDupes++;
          continue;
        }
        seen.add(phone.digits);
      }
      const rating = parseFloat(get('rating'));
      const reviews = parseInt(get('reviews_count').replace(/\D/g, ''), 10);
      const rowTags = get('tags')
        .split(/[,;|]/)
        .map((t) => t.trim())
        .filter(Boolean);
      prepared.push({
        workspace_id: workspace.id,
        business_name: name.slice(0, 300),
        contact_name: get('contact_name') || null,
        phone: phone?.digits ?? null,
        phone_raw: get('phone') || null,
        phone_type: phone?.type ?? 'unknown',
        email: get('email').toLowerCase() || null,
        website: normalizeWebsite(get('website')),
        address: get('address') || null,
        city: get('city') || null,
        country: phone?.country ?? null,
        category: get('category') || null,
        rating: Number.isFinite(rating) && rating >= 0 && rating <= 5 ? Math.round(rating * 10) / 10 : null,
        reviews_count: Number.isFinite(reviews) ? reviews : null,
        tags: [...new Set([...tags, ...rowTags])],
        source: 'import',
        stage_id: stageId || null,
        owner_id: ownerId || null,
      });
    }

    let inserted = 0;
    const sb = getSupabase();
    const chunk = 400;
    try {
      for (let i = 0; i < prepared.length; i += chunk) {
        const batch = prepared.slice(i, i + chunk);
        const withPhone = batch.filter((b) => b.phone);
        const noPhone = batch.filter((b) => !b.phone);
        if (withPhone.length) {
          const { data, error } = await sb.from('leads').upsert(withPhone, { onConflict: 'workspace_id,phone', ignoreDuplicates: true }).select('id');
          if (error) throw error;
          inserted += data?.length ?? 0;
        }
        if (noPhone.length) {
          const { data, error } = await sb.from('leads').insert(noPhone).select('id');
          if (error) throw error;
          inserted += data?.length ?? 0;
        }
        setProgress(Math.round(((i + batch.length) / prepared.length) * 100));
      }
    } catch (err) {
      toast.error(`Import stopped: ${errorMessage(err)}`);
    }
    setResult({ inserted, duplicates: prepared.length - inserted + fileDupes, invalid });
    setStep('done');
    invalidate();
  }

  const preview = rows.slice(0, 3);

  return (
    <Dialog open={open} onOpenChange={(o) => step !== 'importing' && onOpenChange(o)}>
      <DialogContent size="lg" title="Import leads from CSV" description="Works with exports from Google Sheets, Excel, Apollo, other CRMs, or our own export.">
        {step === 'upload' && (
          <DialogBody>
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                const f = e.dataTransfer.files[0];
                if (f) onFile(f);
              }}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors',
                drag ? 'border-primary bg-primary-soft' : 'border-border-strong hover:border-primary/60 hover:bg-surface-2/50',
              )}
            >
              <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-primary-soft text-primary">
                <Upload className="size-5" />
              </div>
              <div className="text-[14px] font-medium">Drop a CSV file here, or click to browse</div>
              <div className="mt-1 text-[13px] text-muted">The first row should contain column names.</div>
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            </label>
          </DialogBody>
        )}

        {step === 'map' && (
          <>
            <DialogBody className="space-y-5">
              <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-2/50 px-3 py-2.5 text-[13px]">
                <FileSpreadsheet className="size-4 text-success" />
                <span className="font-medium">{fileName}</span>
                <span className="text-muted">· {formatNumber(rows.length)} rows</span>
              </div>
              <div>
                <h4 className="mb-2 text-[13px] font-semibold">Match your columns</h4>
                <div className="grid gap-x-4 gap-y-2.5 sm:grid-cols-2">
                  {TARGETS.map((t) => (
                    <div key={t.key} className="flex items-center gap-3">
                      <span className="w-32 shrink-0 text-[13px] text-muted">
                        {t.label}
                        {'required' in t && <span className="text-danger"> *</span>}
                      </span>
                      <NativeSelect inputSize="sm" value={mapping[t.key] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [t.key]: e.target.value || undefined }))}>
                        <option value="">— Skip —</option>
                        {headers.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                  ))}
                </div>
              </div>
              {preview.length > 0 && mapping.business_name && (
                <div>
                  <h4 className="mb-2 text-[13px] font-semibold">Preview</h4>
                  <div className="divide-y divide-border rounded-lg border border-border text-[12.5px]">
                    {preview.map((r, i) => {
                      const p = normalizePhone(mapping.phone ? r[mapping.phone] : '', workspace.default_country);
                      return (
                        <div key={i} className="flex items-center gap-3 px-3 py-2">
                          <span className="min-w-0 flex-1 truncate font-medium">{r[mapping.business_name!]}</span>
                          <span className={cn('font-mono', p ? 'text-foreground' : 'text-subtle')}>{p ? p.display : 'no phone'}</span>
                          {mapping.city && <span className="w-24 truncate text-muted">{r[mapping.city]}</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Add tags" className="sm:col-span-3">
                  <TagInput value={tags} onChange={setTags} />
                </Field>
                <Field label="Stage">
                  <NativeSelect inputSize="sm" value={stageId} onChange={(e) => setStageId(e.target.value)}>
                    <option value="">Default</option>
                    {stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Owner">
                  <NativeSelect inputSize="sm" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                    <option value="">Unassigned</option>
                    {members.map((m) => (
                      <option key={m.user_id} value={m.user_id}>
                        {m.profile.full_name || m.profile.email}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
              <Callout tone="info">Leads whose phone number already exists in this workspace are skipped, so re-importing the same file is safe.</Callout>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setStep('upload')}>
                Back
              </Button>
              <Button variant="primary" disabled={!mapping.business_name} onClick={runImport}>
                Import {formatNumber(rows.length)} rows <ArrowRight />
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'importing' && (
          <DialogBody className="py-12 text-center">
            <div className="text-[14px] font-medium">Importing leads…</div>
            <Progress value={progress} className="mx-auto mt-4 max-w-sm" />
            <div className="mt-2 text-xs text-subtle">{progress}%</div>
          </DialogBody>
        )}

        {step === 'done' && (
          <>
            <DialogBody className="py-10 text-center">
              <CheckCircle2 className="mx-auto size-10 text-success" />
              <div className="mt-3 text-[16px] font-semibold">{formatNumber(result.inserted)} leads imported</div>
              <div className="mt-1 text-[13px] text-muted">
                {formatNumber(result.duplicates)} duplicates skipped · {formatNumber(result.invalid)} rows without a business name
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="primary" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
