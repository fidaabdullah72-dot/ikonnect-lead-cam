'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { CheckCircle2, KeyRound, Loader2, QrCode, RefreshCw, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { normalizePhone, type WhatsappAccount, type WhatsappLinkCode } from '@batsols/shared';
import { WhatsAppIcon } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Callout } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/controls';
import { getSupabase } from '@/lib/supabase/client';
import { qk, useAccounts, useEngineStatus, useRealtime } from '@/lib/queries';
import { useWorkspace } from '@/lib/workspace';
import { cn, errorMessage } from '@/lib/utils';

type Method = 'qr' | 'code';

/**
 * Connect flow. With `account` it reconnects that number; without, it first
 * creates a new one. The engine publishes the QR / pairing code to
 * whatsapp_link_codes, which we watch live.
 */
export function ConnectDialog({ open, onOpenChange, account }: { open: boolean; onOpenChange: (o: boolean) => void; account?: WhatsappAccount | null }) {
  const { workspace, userId } = useWorkspace();
  const engine = useEngineStatus();
  const { byId } = useAccounts();
  const qc = useQueryClient();
  const [step, setStep] = React.useState<'setup' | 'linking'>('setup');
  const [label, setLabel] = React.useState('');
  const [method, setMethod] = React.useState<Method>('qr');
  const [phone, setPhone] = React.useState('');
  const [accountId, setAccountId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setStep(account ? 'linking' : 'setup');
    setAccountId(account?.id ?? null);
    setLabel('');
    setPhone('');
    setMethod('qr');
  }, [open, account]);

  const live = accountId ? byId.get(accountId) : undefined;
  const codeKey = ['link-code', accountId];
  useRealtime('whatsapp_link_codes', accountId ? `account_id=eq.${accountId}` : null, [codeKey]);
  const code = useQuery({
    queryKey: codeKey,
    enabled: !!accountId && open,
    queryFn: async () => {
      const { data } = await getSupabase().from('whatsapp_link_codes').select('*').eq('account_id', accountId!).maybeSingle();
      return (data as WhatsappLinkCode | null) ?? null;
    },
    refetchInterval: 4000,
  });

  // Live updates are the fast path; polling covers a missed event so "Connected" always shows.
  React.useEffect(() => {
    if (!open || step !== 'linking') return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: qk.accounts(workspace.id) }), 4000);
    return () => clearInterval(t);
  }, [open, step, qc, workspace.id]);

  // A code on screen means WhatsApp is waiting for the phone, even if the account row hasn't refreshed yet.
  const waitingForPhone = live?.status === 'qr' || live?.status === 'pairing' || Boolean(code.data?.qr || code.data?.pairing_code);

  async function begin() {
    const pairing = method === 'code' ? normalizePhone(phone, workspace.default_country) : null;
    if (method === 'code' && !pairing?.valid) {
      toast.error('Enter the full WhatsApp number of the phone you are linking.');
      return;
    }
    setBusy(true);
    const sb = getSupabase();
    let id = accountId;
    if (!id) {
      const { data, error } = await sb
        .from('whatsapp_accounts')
        .insert({ workspace_id: workspace.id, owner_id: userId, label: label.trim() || 'My WhatsApp', desired_state: 'connected', pairing_phone: pairing?.digits ?? null })
        .select('*')
        .single();
      setBusy(false);
      if (error) return toast.error(errorMessage(error));
      id = data.id;
    } else {
      const { error } = await sb.from('whatsapp_accounts').update({ desired_state: 'connected', pairing_phone: pairing?.digits ?? null }).eq('id', id);
      setBusy(false);
      if (error) return toast.error(errorMessage(error));
    }
    setAccountId(id);
    setStep('linking');
    qc.invalidateQueries({ queryKey: qk.accounts(workspace.id) });
  }

  async function retry() {
    if (!accountId) return;
    await getSupabase().from('whatsapp_accounts').update({ desired_state: 'disconnected' }).eq('id', accountId);
    setTimeout(() => void getSupabase().from('whatsapp_accounts').update({ desired_state: 'connected' }).eq('id', accountId), 3500);
    toast('Getting a fresh code…');
  }

  async function switchToCode() {
    setStep('setup');
    setMethod('code');
  }

  const connected = live?.status === 'connected';
  const gaveUp = live && live.desired_state !== 'connected' && !connected;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" title={account ? `Reconnect “${account.label}”` : 'Connect a WhatsApp number'}>
        {step === 'setup' && (
          <>
            <DialogBody className="space-y-5">
              {!engine.online && (
                <Callout tone="warning" title="The engine is offline">
                  Codes come from the BatWos engine. Start it (or check your Render worker) before connecting.
                </Callout>
              )}
              {!account && (
                <Field label="Name this number" hint="Shown to your team, e.g. “Sales — Ali” or “Office line”.">
                  <Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Sales — Ali" />
                </Field>
              )}
              <Field label="How do you want to link it?">
                <Segmented<Method>
                  value={method}
                  onChange={setMethod}
                  options={[
                    { value: 'qr', label: 'Scan QR code', icon: <QrCode /> },
                    { value: 'code', label: 'Use phone number', icon: <KeyRound /> },
                  ]}
                />
              </Field>
              {method === 'code' && (
                <Field label="WhatsApp number on that phone" hint="We’ll show an 8-character code to type into WhatsApp. Handy when you can’t scan a screen.">
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+92 300 1234567" />
                </Field>
              )}
              <Callout tone="info" title="Good to know">
                The phone keeps working normally. BatWos is linked like WhatsApp Web, so messages you send show up on the phone too. Use numbers that have been active for a while: brand-new numbers get restricted faster.
              </Callout>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="whatsapp" onClick={begin} loading={busy}>
                <WhatsAppIcon /> {method === 'qr' ? 'Show QR code' : 'Get pairing code'}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'linking' && (
          <>
            <DialogBody>
              {connected ? (
                <div className="flex flex-col items-center py-8 text-center">
                  <div className="relative">
                    <div className="absolute inset-0 rounded-full bg-success/30 blur-xl" />
                    <CheckCircle2 className="relative size-14 text-success" />
                  </div>
                  <h3 className="mt-4 text-lg font-semibold">Connected</h3>
                  <p className="mt-1 text-[13.5px] text-muted">
                    {live?.label} {live?.phone ? `(+${live.phone})` : ''} is linked. BatWos keeps it connected — even across restarts.
                  </p>
                </div>
              ) : gaveUp ? (
                <div className="flex flex-col items-center py-8 text-center">
                  <h3 className="text-lg font-semibold">The code expired</h3>
                  <p className="mt-1 max-w-sm text-[13.5px] text-muted">{live?.last_error ?? 'It wasn’t scanned in time.'}</p>
                  <Button className="mt-5" variant="primary" onClick={() => void begin()}>
                    <RefreshCw /> Get a new code
                  </Button>
                </div>
              ) : (
                <div className="grid items-center gap-8 md:grid-cols-[1fr_300px]">
                  <ol className="space-y-4 text-[13.5px]">
                    {(code.data?.pairing_code
                      ? [
                          'Open WhatsApp on your phone',
                          'Tap Settings (iPhone) or ⋮ Menu (Android) → Linked devices',
                          'Tap Link a device → Link with phone number instead',
                          'Type the code shown here',
                        ]
                      : ['Open WhatsApp on your phone', 'Tap Settings (iPhone) or ⋮ Menu (Android) → Linked devices', 'Tap Link a device', 'Point your phone at this screen']
                    ).map((t, i) => (
                      <li key={t} className="flex gap-3">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-whatsapp-soft text-xs font-semibold text-whatsapp">{i + 1}</span>
                        <span className="pt-0.5">{t}</span>
                      </li>
                    ))}
                    <li className="pt-2 text-xs text-subtle">
                      {code.data?.pairing_code ? (
                        <>The code refreshes automatically. Prefer scanning? Close and choose “Scan QR code”.</>
                      ) : (
                        <>
                          The QR refreshes every ~20 seconds.{' '}
                          <button className="font-medium text-primary hover:underline" onClick={switchToCode}>
                            Link with a phone number instead
                          </button>
                        </>
                      )}
                    </li>
                  </ol>
                  <div className="flex flex-col items-center">
                    {code.data?.pairing_code ? (
                      <div className="flex h-[300px] w-full flex-col items-center justify-center rounded-2xl border border-border bg-surface-2/50">
                        <div className="text-xs font-medium uppercase tracking-wider text-subtle">Pairing code</div>
                        <div className="mt-3 font-mono text-[34px] font-semibold tracking-[0.18em]">{code.data.pairing_code}</div>
                        <Smartphone className="mt-4 size-5 text-subtle" />
                      </div>
                    ) : code.data?.qr ? (
                      <div className="rounded-2xl bg-white p-4 shadow-md ring-1 ring-black/5">
                        <QRCodeSVG value={code.data.qr} size={268} level="M" marginSize={0} />
                      </div>
                    ) : (
                      <div className="flex h-[300px] w-[300px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border-strong text-[13px] text-muted">
                        <Loader2 className="size-6 animate-spin text-primary" />
                        {engine.online ? 'Generating a secure code…' : 'Waiting for the engine…'}
                      </div>
                    )}
                    <div className={cn('mt-3 flex items-center gap-2 text-xs', waitingForPhone ? 'text-whatsapp' : 'text-subtle')}>
                      <span className="size-1.5 animate-pulse-ring rounded-full bg-current" />
                      {waitingForPhone ? 'Waiting for your phone…' : 'Connecting to WhatsApp…'}
                    </div>
                  </div>
                </div>
              )}
            </DialogBody>
            <DialogFooter>
              {!connected && !gaveUp && (
                <Button variant="ghost" onClick={retry}>
                  <RefreshCw /> New code
                </Button>
              )}
              <Button variant={connected ? 'primary' : 'secondary'} onClick={() => onOpenChange(false)}>
                {connected ? 'Done' : 'Close'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
