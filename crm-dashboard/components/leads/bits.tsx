'use client';

import * as React from 'react';
import { Check, ChevronDown, Copy, Phone, Star, UserRound, X } from 'lucide-react';
import { toast } from 'sonner';
import { formatPhone, type Lead, type PipelineStage } from '@batsols/shared';
import { WhatsAppIcon } from '@/components/brand';
import { Avatar } from '@/components/ui/avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from '@/components/ui/menu';
import { useMembers, useStages } from '@/lib/queries';
import { cn, formatCompact } from '@/lib/utils';

export function StageDot({ color, className }: { color: string; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', className)} style={{ background: color }} />;
}

/** Inline stage picker. Renders a static badge when `disabled`. */
export function StageSelect({
  value,
  onChange,
  disabled,
  size = 'sm',
  className,
}: {
  value: string | null;
  onChange: (stageId: string) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const { stages, byId } = useStages();
  const current: PipelineStage | undefined = value ? byId.get(value) : undefined;
  const label = (
    <>
      <StageDot color={current?.color ?? '#64748b'} />
      <span className="truncate">{current?.name ?? 'No stage'}</span>
    </>
  );
  const cls = cn(
    'inline-flex max-w-[170px] items-center gap-1.5 rounded-md border border-border bg-surface px-2 font-medium text-foreground',
    size === 'sm' ? 'h-[26px] text-xs' : 'h-8 text-[13px]',
    className,
  );
  if (disabled) return <span className={cls}>{label}</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" onClick={(e) => e.stopPropagation()} className={cn(cls, 'transition-colors hover:border-border-strong hover:bg-surface-2')}>
          {label}
          <ChevronDown className="size-3 shrink-0 text-subtle" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel>Move to stage</DropdownMenuLabel>
        {stages.map((s) => (
          <DropdownMenuItem key={s.id} onSelect={() => s.id !== value && onChange(s.id)}>
            <StageDot color={s.color} />
            {s.name}
            {s.id === value && <Check className="ml-auto !text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function OwnerSelect({
  value,
  onChange,
  disabled,
  compact,
}: {
  value: string | null;
  onChange: (userId: string | null) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { members, byId } = useMembers();
  const owner = value ? byId.get(value) : undefined;
  const name = owner?.profile.full_name || owner?.profile.email;
  const trigger = (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'inline-flex h-[26px] max-w-[160px] items-center gap-1.5 rounded-md px-1.5 text-xs font-medium transition-colors',
        !disabled && 'hover:bg-surface-2',
        owner ? 'text-foreground' : 'text-subtle',
      )}
    >
      {owner ? <Avatar name={name} src={owner.profile.avatar_url} size="xs" /> : <UserRound className="size-3.5" />}
      {!compact && <span className="truncate">{owner ? name : 'Unassigned'}</span>}
    </button>
  );
  if (disabled) return trigger;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel>Assign to</DropdownMenuLabel>
        {members.map((m) => (
          <DropdownMenuItem key={m.user_id} onSelect={() => m.user_id !== value && onChange(m.user_id)}>
            <Avatar name={m.profile.full_name || m.profile.email} src={m.profile.avatar_url} size="xs" />
            <span className="truncate">{m.profile.full_name || m.profile.email}</span>
            {m.user_id === value && <Check className="ml-auto !text-primary" />}
          </DropdownMenuItem>
        ))}
        {value && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange(null)}>
              <X /> Unassign
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WaStatus({ lead, showLabel }: { lead: Pick<Lead, 'wa_status' | 'phone_type' | 'phone'>; showLabel?: boolean }) {
  if (!lead.phone) return null;
  const map = {
    valid: { cls: 'text-whatsapp', label: 'On WhatsApp' },
    invalid: { cls: 'text-danger/80', label: 'Not on WhatsApp' },
    unknown: { cls: 'text-subtle/70', label: lead.phone_type === 'landline' ? 'Landline — probably not on WhatsApp' : 'WhatsApp not checked yet' },
  }[lead.wa_status];
  return (
    <Tooltip content={map.label}>
      <span className={cn('inline-flex items-center gap-1 text-xs', map.cls)}>
        <WhatsAppIcon className={cn('size-3.5', lead.wa_status === 'invalid' && 'opacity-60')} />
        {showLabel && map.label}
      </span>
    </Tooltip>
  );
}

export function PhoneText({ phone, className, copy }: { phone: string | null; className?: string; copy?: boolean }) {
  if (!phone) return <span className="text-subtle">—</span>;
  const pretty = formatPhone(phone);
  return (
    <span className={cn('group/phone inline-flex items-center gap-1.5 font-mono text-[12.5px] tabular', className)}>
      {pretty}
      {copy && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard.writeText(`+${phone}`);
            toast.success('Phone copied');
          }}
          className="text-subtle opacity-0 transition-opacity hover:text-foreground group-hover/phone:opacity-100"
          aria-label="Copy phone"
        >
          <Copy className="size-3" />
        </button>
      )}
    </span>
  );
}

export function Rating({ rating, reviews }: { rating: number | null; reviews: number | null }) {
  if (!rating) return <span className="text-subtle">—</span>;
  return (
    <span className="inline-flex items-center gap-1 text-[12.5px] tabular">
      <Star className="size-3 fill-[#f5b301] text-[#f5b301]" />
      <span className="font-medium">{rating.toFixed(1)}</span>
      {reviews ? <span className="text-subtle">({formatCompact(reviews)})</span> : null}
    </span>
  );
}

export function LandlineBadge() {
  return (
    <Tooltip content="Landline number — usually not on WhatsApp">
      <span className="inline-flex items-center gap-0.5 rounded bg-surface-2 px-1 text-[10.5px] font-medium text-subtle">
        <Phone className="size-2.5" /> LL
      </span>
    </Tooltip>
  );
}

export function ScoreBadge({ score, tier }: { score: number; tier: 'hot' | 'warm' | 'cold' }) {
  const cls = tier === 'hot' ? 'bg-danger-soft text-danger' : tier === 'warm' ? 'bg-warning-soft text-warning' : 'bg-surface-2 text-subtle';
  return (
    <Tooltip content={`Lead score ${score}/100 · ${tier === 'hot' ? 'Hot' : tier === 'warm' ? 'Warm' : 'Cold'}`}>
      <span className={cn('inline-flex h-[18px] min-w-[26px] shrink-0 items-center justify-center rounded px-1 text-[10.5px] font-semibold tabular', cls)}>{score}</span>
    </Tooltip>
  );
}
