'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, Braces, CheckCircle2, Dices, Shuffle, Sparkles, Variable } from 'lucide-react';
import {
  TEMPLATE_VARIABLES,
  TEMPLATE_VARIABLE_KEYS,
  buildTemplateVars,
  lintTemplate,
  renderTemplate,
  seededRng,
  spintaxVariantCount,
  type Lead,
  type LeadFilters,
} from '@batsols/shared';
import { WhatsAppIcon } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, Tooltip } from '@/components/ui/menu';
import { getSupabase } from '@/lib/supabase/client';
import { useWorkspace } from '@/lib/workspace';
import { cn, formatCompact } from '@/lib/utils';

const PREVIEW_COLUMNS = 'business_name, contact_name, city, category, website, address, rating, reviews_count';

/** A real lead for previews — from `filters` (e.g. a campaign's audience) when given; falls back to sample values. */
export function usePreviewLead(filters?: LeadFilters): Partial<Lead> {
  const { workspace } = useWorkspace();
  const { data } = useQuery({
    queryKey: ['preview-lead', workspace.id, filters ?? null],
    queryFn: async () => {
      const sb = getSupabase();
      if (filters) {
        const { data } = await sb.rpc('filtered_leads', { p_workspace: workspace.id, p_filters: filters }).select(`${PREVIEW_COLUMNS}, score`).order('score', { ascending: false }).limit(1).maybeSingle();
        if (data) return data as Partial<Lead>;
      }
      const { data } = await sb.from('leads').select(PREVIEW_COLUMNS).eq('workspace_id', workspace.id).not('city', 'is', null).order('score', { ascending: false }).limit(1).maybeSingle();
      return data as Partial<Lead> | null;
    },
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
  return (
    data ??
    Object.fromEntries(TEMPLATE_VARIABLES.map((v) => [v.key === 'reviews_count' ? 'reviews_count' : v.key, v.sample])) as Partial<Lead>
  );
}

export function MessageEditor({
  value,
  onChange,
  placeholder = 'Hi {{business_name}}, …',
  rows = 6,
  autoFocus,
  footer,
  showPreview = true,
  senderName,
  previewFilters,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  footer?: React.ReactNode;
  showPreview?: boolean;
  senderName?: string;
  /** Preview with a lead from this audience instead of any lead. */
  previewFilters?: LeadFilters;
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const { profile, workspace } = useWorkspace();
  const lead = usePreviewLead(previewFilters);
  const [seed, setSeed] = React.useState(1);

  const insert = (text: string, selectInner = false) => {
    const el = ref.current;
    if (!el) return onChange(value + text);
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const selected = value.slice(start, end);
    const snippet = selectInner && selected ? text.replace('…', selected) : text;
    const next = value.slice(0, start) + snippet + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + snippet.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const issues = value.trim() ? lintTemplate(value, TEMPLATE_VARIABLE_KEYS) : [];
  const variants = spintaxVariantCount(value);
  const vars = buildTemplateVars(lead as Lead, { sender_name: senderName ?? profile.full_name, company_name: workspace.settings.company_name ?? workspace.name });
  const preview = value.trim() ? renderTemplate(value, vars, seededRng(seed)) : '';

  return (
    <div className={cn('grid gap-4', showPreview && 'lg:grid-cols-[1fr_320px]')}>
      <div className="min-w-0">
        <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm focus-within:border-primary focus-within:ring-[3px] focus-within:ring-ring/30">
          <div className="flex flex-wrap items-center gap-1 border-b border-border bg-surface-2/50 px-2 py-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="xs" variant="ghost">
                  <Variable /> Insert variable
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>Personalise with</DropdownMenuLabel>
                {TEMPLATE_VARIABLES.map((v) => (
                  <DropdownMenuItem key={v.key} onSelect={() => insert(`{{${v.key}}}`)}>
                    <Braces />
                    <span className="flex-1">{v.label}</span>
                    <span className="max-w-[90px] truncate text-[11px] text-subtle">{v.sample}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip content="Wrap alternatives so each message is unique: {Hi|Hello|Salam}">
              <Button type="button" size="xs" variant="ghost" onClick={() => insert('{…|…}', true)}>
                <Shuffle /> Add variation
              </Button>
            </Tooltip>
            <div className="ml-auto flex items-center gap-3 pr-1 text-[11px] text-subtle">
              <span className="tabular">{value.length} chars</span>
              <Tooltip content="Distinct messages this text can produce">
                <span className={cn('inline-flex items-center gap-1 tabular', variants >= 3 ? 'text-success' : '')}>
                  <Dices className="size-3" />
                  {formatCompact(variants)} {variants === 1 ? 'version' : 'versions'}
                </span>
              </Tooltip>
            </div>
          </div>
          <textarea
            ref={ref}
            autoFocus={autoFocus}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={rows}
            placeholder={placeholder}
            className="block w-full resize-y bg-transparent px-3.5 py-3 font-mono text-[13px] leading-relaxed outline-none placeholder:font-sans placeholder:text-subtle"
          />
          {footer && <div className="border-t border-border px-3 py-2">{footer}</div>}
        </div>
        <ul className="mt-2 space-y-1">
          {issues.map((i) => (
            <li key={i.message} className={cn('flex items-start gap-1.5 text-xs', i.level === 'error' ? 'text-danger' : 'text-warning')}>
              {i.level === 'error' ? <AlertCircle className="mt-px size-3.5 shrink-0" /> : <AlertTriangle className="mt-px size-3.5 shrink-0" />}
              {i.message}
            </li>
          ))}
          {value.trim() && !issues.length && (
            <li className="flex items-center gap-1.5 text-xs text-success">
              <CheckCircle2 className="size-3.5" /> Looks great — personalised and varied.
            </li>
          )}
        </ul>
      </div>

      {showPreview && (
        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-subtle">Preview</span>
            <Button type="button" size="xs" variant="ghost" onClick={() => setSeed((s) => s + 1)} disabled={variants < 2}>
              <Sparkles /> Another version
            </Button>
          </div>
          <div className="rounded-xl border border-border bg-[#efeae2] p-3 dark:bg-[#0b141a]">
            <div className="mb-2 flex items-center gap-2 text-[11px] text-[#54656f] dark:text-[#8696a0]">
              <WhatsAppIcon className="size-3.5" />
              To {String(lead.business_name ?? 'Smile Dental Clinic')}
            </div>
            {preview ? (
              <div className="ml-auto max-w-[92%] whitespace-pre-wrap break-words rounded-xl rounded-tr-sm bg-[#d9fdd3] px-3 py-2 text-[13px] leading-relaxed text-[#111b21] shadow-sm dark:bg-[#144d37] dark:text-[#e9edef]">
                {preview}
              </div>
            ) : (
              <div className="py-6 text-center text-xs text-[#54656f] dark:text-[#8696a0]">Your message preview appears here</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
