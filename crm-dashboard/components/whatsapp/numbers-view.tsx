'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Flame,
  Link2Off,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Share2,
  ShieldCheck,
  Smartphone,
  Trash2,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatPhone, warmupLimit, type AccountHealth, type WhatsappAccount } from '@batsols/shared';
import { WhatsAppIcon } from '@/components/brand';
import { Page } from '@/components/shell/app-shell';
import { ShareDialog } from '@/components/access/share-dialog';
import { Avatar } from '@/components/ui/avatar';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress, SwitchRow } from '@/components/ui/controls';
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState, Skeleton, useConfirm, Callout } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/layout';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from '@/components/ui/menu';
import { ConnectDialog } from './connect-dialog';
import { getSupabase } from '@/lib/supabase/client';
import { qk, useAccounts, useEngineStatus, useMembers, useNow } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, errorMessage, formatPercent, timeAgo } from '@/lib/utils';

function statusOf(a: WhatsappAccount, engineOnline: boolean): { label: string; tone: BadgeTone; pulse?: boolean } {
  if (a.status === 'connected') return engineOnline ? { label: 'Connected', tone: 'whatsapp', pulse: true } : { label: 'Engine offline', tone: 'warning' };
  if (a.status === 'qr' || a.status === 'pairing') return { label: 'Waiting for scan', tone: 'info', pulse: true };
  if (a.status === 'connecting') return { label: a.connected_at ? 'Reconnecting' : 'Connecting', tone: 'warning', pulse: true };
  if (a.status === 'logged_out') return { label: 'Logged out', tone: 'danger' };
  if (a.status === 'error') return { label: 'Needs attention', tone: 'danger' };
  return { label: 'Disconnected', tone: 'neutral' };
}

export function NumbersView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { workspace, userId, can } = useWorkspace();
  const { accounts, isLoading } = useAccounts();
  const engine = useEngineStatus();
  const health = useQuery({
    queryKey: ['account-health', workspace.id],
    queryFn: async () => {
      const { data, error } = await getSupabase().rpc('account_health', { p_workspace: workspace.id, p_days: 7 });
      if (error) throw error;
      return new Map((data as AccountHealth[]).map((h) => [h.account_id, h]));
    },
    refetchInterval: 30_000,
  });
  const [connect, setConnect] = React.useState<{ open: boolean; account: WhatsappAccount | null }>({ open: false, account: null });

  React.useEffect(() => {
    if (params.get('connect') === '1') {
      setConnect({ open: true, account: null });
      router.replace(pathname, { scroll: false });
    }
  }, [params, pathname, router]);

  const mine = accounts.filter((a) => a.owner_id === userId);
  const others = accounts.filter((a) => a.owner_id !== userId);

  return (
    <Page>
      <PageHeader
        icon={<Smartphone />}
        title="WhatsApp numbers"
        description="Each teammate links their own WhatsApp. BatWos keeps every number connected and sending safely."
        actions={
          can.write && (
            <Button variant="whatsapp" onClick={() => setConnect({ open: true, account: null })}>
              <Plus /> Connect number
            </Button>
          )
        }
      />

      {!engine.online && !engine.isLoading && (
        <Callout tone="warning" title="The BatWos engine is offline" className="mb-6">
          Numbers can’t connect or send until the engine is running. Messages and campaigns wait safely in the queue.
        </Callout>
      )}

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
        </div>
      ) : accounts.length === 0 ? (
        <Card>
          <EmptyState
            icon={<WhatsAppIcon />}
            title="Connect your first WhatsApp number"
            description="Scan a QR code with your phone, just like WhatsApp Web. It takes about 20 seconds."
            action={
              can.write && (
                <Button variant="whatsapp" onClick={() => setConnect({ open: true, account: null })}>
                  <WhatsAppIcon /> Connect number
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="space-y-8">
          <NumberGrid title={others.length ? 'Your numbers' : undefined} accounts={mine} health={health.data} onConnect={(a) => setConnect({ open: true, account: a })} engineOnline={engine.online} emptyText="You haven’t connected a number yet." />
          {others.length > 0 && (
            <NumberGrid title="Team numbers" accounts={others} health={health.data} onConnect={(a) => setConnect({ open: true, account: a })} engineOnline={engine.online} />
          )}
        </div>
      )}

      <SafetyTips />
      <ConnectDialog open={connect.open} onOpenChange={(o) => setConnect((c) => ({ ...c, open: o }))} account={connect.account} />
    </Page>
  );
}

function NumberGrid({
  title,
  accounts,
  health,
  onConnect,
  engineOnline,
  emptyText,
}: {
  title?: string;
  accounts: WhatsappAccount[];
  health?: Map<string, AccountHealth>;
  onConnect: (a: WhatsappAccount) => void;
  engineOnline: boolean;
  emptyText?: string;
}) {
  return (
    <section>
      {title && <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-subtle">{title}</h2>}
      {accounts.length === 0 && emptyText ? (
        <p className="text-[13px] text-muted">{emptyText}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {accounts.map((a) => (
            <NumberCard key={a.id} account={a} health={health?.get(a.id)} onConnect={() => onConnect(a)} engineOnline={engineOnline} />
          ))}
        </div>
      )}
    </section>
  );
}

function NumberCard({ account: a, health, onConnect, engineOnline }: { account: WhatsappAccount; health?: AccountHealth; onConnect: () => void; engineOnline: boolean }) {
  const { workspace, userId, can } = useWorkspace();
  const { byId } = useMembers();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const now = useNow(60_000);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  const owner = a.owner_id ? byId.get(a.owner_id) : undefined;
  const editable = can.admin || (a.owner_id === userId && can.write);
  const st = statusOf(a, engineOnline);
  const limit = warmupLimit(a.daily_limit, a.warmup_started_at, new Date(now));
  const sentToday = health?.sent_today ?? 0;
  const warmDay = a.warmup_started_at ? Math.min(14, Math.floor((now - new Date(a.warmup_started_at).getTime()) / 86400000) + 1) : null;
  const paused = a.paused_until && new Date(a.paused_until).getTime() > now;

  const patch = async (p: Partial<WhatsappAccount>, msg?: string): Promise<void> => {
    const { error } = await getSupabase().from('whatsapp_accounts').update(p).eq('id', a.id);
    if (error) {
      toast.error(errorMessage(error));
      return;
    }
    if (msg) toast.success(msg);
    qc.invalidateQueries({ queryKey: qk.accounts(workspace.id) });
  };

  async function remove() {
    if (!(await confirm({ title: `Remove “${a.label}”?`, description: 'The device is unlinked from the phone. Chat history stays in BatWos.', confirmLabel: 'Remove number', danger: true })))
      return;
    if (a.status === 'connected') {
      await patch({ desired_state: 'logged_out' });
      await new Promise((r) => setTimeout(r, 4000));
    }
    const { error } = await getSupabase().from('whatsapp_accounts').delete().eq('id', a.id);
    if (error) return toast.error(errorMessage(error));
    toast.success('Number removed');
    qc.invalidateQueries({ queryKey: qk.accounts(workspace.id) });
  }

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex items-start gap-3 p-4">
        <div className={cn('relative flex size-11 shrink-0 items-center justify-center rounded-xl', a.status === 'connected' ? 'bg-whatsapp-soft text-whatsapp' : 'bg-surface-2 text-subtle')}>
          <WhatsAppIcon className="size-5" />
          {a.status === 'connected' && <span className="absolute -right-0.5 -top-0.5 size-3 rounded-full border-2 border-surface bg-whatsapp-bright" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold">{a.label}</span>
            {a.shared && (
              <Tooltip content="Shared with the whole team">
                <Users className="size-3.5 shrink-0 text-subtle" />
              </Tooltip>
            )}
          </div>
          <div className="truncate font-mono text-[12.5px] text-muted tabular">{a.phone ? formatPhone(a.phone) : 'Not linked yet'}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={st.tone} dot pulse={st.pulse}>
              {st.label}
            </Badge>
            {warmDay && (
              <Badge tone="warning">
                <Flame /> Warm-up day {warmDay}/14
              </Badge>
            )}
          </div>
        </div>
        {editable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Number actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
                <Pencil /> Settings & limits
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setShareOpen(true)}>
                <Share2 /> Share with teammates
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {a.desired_state === 'connected' ? (
                <DropdownMenuItem onSelect={() => patch({ desired_state: 'disconnected' }, 'Disconnecting… the device stays linked')}>
                  <WifiOff /> Pause connection
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={onConnect}>
                  <Wifi /> Connect
                </DropdownMenuItem>
              )}
              {a.phone && (
                <DropdownMenuItem onSelect={() => patch({ desired_state: 'logged_out' }, 'Unlinking device from the phone…')}>
                  <LogOut /> Log out (unlink device)
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem danger onSelect={remove}>
                <Trash2 /> Remove number
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="space-y-3 border-t border-border px-4 py-3">
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="text-muted">Sent today</span>
            <span className="font-medium tabular">
              {sentToday} / {limit}
            </span>
          </div>
          <Progress value={(sentToday / Math.max(1, limit)) * 100} tone={sentToday >= limit ? 'warning' : 'whatsapp'} />
        </div>
        <div className="grid grid-cols-4 gap-2 text-center">
          {[
            { label: 'Sent 7d', value: String(health?.sent ?? 0) },
            { label: 'Delivered', value: formatPercent(health?.delivered ?? 0, health?.sent ?? 0) },
            { label: 'Read', value: formatPercent(health?.read ?? 0, health?.sent ?? 0) },
            { label: 'Replies', value: String(health?.replies ?? 0) },
          ].map((s) => (
            <div key={s.label} className="rounded-lg bg-surface-2/60 px-1 py-2">
              <div className="text-[13px] font-semibold tabular">{s.value}</div>
              <div className="text-[10.5px] uppercase tracking-wide text-subtle">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {(paused || a.last_error || (health?.failed ?? 0) > 3) && (
        <div className="space-y-1.5 border-t border-border px-4 py-3 text-xs">
          {paused && (
            <div className="flex gap-2 text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              Sending paused until {new Date(a.paused_until!).toLocaleString()} to protect this number.
            </div>
          )}
          {a.last_error && (
            <div className="flex gap-2 text-danger">
              <Link2Off className="mt-0.5 size-3.5 shrink-0" />
              {a.last_error}
            </div>
          )}
          {(health?.failed ?? 0) > 3 && (
            <div className="flex gap-2 text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {health?.failed} failed sends this week — slow down or check the number.
            </div>
          )}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border bg-surface-2/40 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
          {owner && <Avatar name={owner.profile.full_name || owner.profile.email} src={owner.profile.avatar_url} size="xs" />}
          <span className="truncate">{owner ? owner.profile.full_name || owner.profile.email : 'No owner'}</span>
          {a.last_seen_at && a.status === 'connected' && <span className="text-subtle">· active {timeAgo(a.last_seen_at)}</span>}
        </div>
        {editable && a.status !== 'connected' && (
          <Button size="xs" variant={a.status === 'qr' || a.status === 'pairing' ? 'primary' : 'secondary'} onClick={onConnect}>
            {a.status === 'qr' || a.status === 'pairing' ? 'Show code' : a.phone ? (
              <>
                <RefreshCw /> Reconnect
              </>
            ) : (
              'Connect'
            )}
          </Button>
        )}
      </div>

      <NumberSettings open={settingsOpen} onOpenChange={setSettingsOpen} account={a} onSave={patch} />
      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} type="whatsapp_account" resourceId={a.id} resourceName={a.label} />
    </Card>
  );
}

function NumberSettings({
  open,
  onOpenChange,
  account,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  account: WhatsappAccount;
  onSave: (p: Partial<WhatsappAccount>, msg?: string) => Promise<void>;
}) {
  const [label, setLabel] = React.useState(account.label);
  const [limit, setLimit] = React.useState(account.daily_limit);
  const [warmup, setWarmup] = React.useState(!!account.warmup_started_at);
  const [shared, setShared] = React.useState(account.shared);
  React.useEffect(() => {
    if (open) {
      setLabel(account.label);
      setLimit(account.daily_limit);
      setWarmup(!!account.warmup_started_at);
      setShared(account.shared);
    }
  }, [open, account]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" title="Number settings" description={account.label}>
        <DialogBody className="space-y-4">
          <Field label="Name">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="Daily message limit" hint="Across all campaigns and replies. 30–60 is a safe range for numbers in regular use.">
            <Input type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
          </Field>
          <div className="divide-y divide-border rounded-xl border border-border px-4">
            <SwitchRow
              label="Warm-up mode"
              description="Starts at 20% of the limit and ramps to 100% over 14 days. Strongly recommended for new or rarely used numbers."
              checked={warmup}
              onCheckedChange={setWarmup}
            />
            <SwitchRow label="Share with the whole team" description="Teammates can pick this number for their campaigns and see its chats." checked={shared} onCheckedChange={setShared} />
          </div>
          <Callout tone="primary" icon={<ShieldCheck />}>
            BatWos also adds random delays, typing indicators and breaks between batches automatically.
          </Callout>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              await onSave(
                {
                  label: label.trim() || account.label,
                  daily_limit: Math.max(1, Math.min(1000, Math.round(limit))),
                  warmup_started_at: warmup ? (account.warmup_started_at ?? new Date().toISOString()) : null,
                  shared,
                },
                'Number updated',
              );
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SafetyTips() {
  const tips = [
    { title: 'Warm up new numbers', text: 'Start with 10–20 messages a day and let warm-up mode raise it over two weeks.' },
    { title: 'Personalise every message', text: 'Use {{business_name}} and spintax like {Hi|Hello} so no two messages are identical.' },
    { title: 'Avoid links in first messages', text: 'Introduce yourself first; send links once they reply.' },
    { title: 'Respect opt-outs', text: 'Replies like “stop” are honoured automatically and stop every campaign.' },
  ];
  return (
    <div className="mt-10">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-subtle">Keeping numbers healthy</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tips.map((t) => (
          <div key={t.title} className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <ShieldCheck className="size-4 text-success" /> {t.title}
            </div>
            <p className="mt-1 text-[12.5px] text-muted">{t.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
