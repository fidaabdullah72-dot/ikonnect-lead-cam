'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Building2, Lock, Mail, User } from 'lucide-react';
import { COUNTRIES } from '@batsols/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Callout } from '@/components/ui/feedback';
import { getSupabase } from '@/lib/supabase/client';
import { createAccount, guessTimezone } from '@/lib/auth-client';
import { errorMessage } from '@/lib/utils';

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = React.useState({ full_name: '', email: '', password: '', workspace: '', country: 'PK' });
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  React.useEffect(() => {
    const tz = guessTimezone();
    const match = COUNTRIES.find((c) => c.timezone === tz);
    if (match) setForm((f) => ({ ...f, country: match.code }));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await createAccount({ email: form.email.trim(), password: form.password, full_name: form.full_name.trim() });
      if (result === 'confirm_email') {
        setNotice('Check your inbox to confirm your email, then sign in to finish setting up your workspace.');
        setLoading(false);
        return;
      }
      const country = COUNTRIES.find((c) => c.code === form.country);
      const { error } = await getSupabase().rpc('create_workspace', {
        p_name: form.workspace.trim() || `${form.full_name.trim()}'s team`,
        p_timezone: country?.timezone ?? guessTimezone(),
        p_country: form.country,
      });
      if (error) throw error;
      router.replace('/dashboard?welcome=1');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }

  return (
    <>
      <h2 className="text-2xl font-semibold tracking-[-0.025em]">Create your workspace</h2>
      <p className="mt-1.5 text-[13.5px] text-muted">Set up BatSols for your team in under a minute.</p>
      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}
        {notice && <Callout tone="success">{notice}</Callout>}
        <Field label="Your name" htmlFor="name">
          <Input id="name" required autoComplete="name" leading={<User />} value={form.full_name} onChange={set('full_name')} placeholder="Sara Khan" />
        </Field>
        <Field label="Work email" htmlFor="email">
          <Input id="email" type="email" required autoComplete="email" leading={<Mail />} value={form.email} onChange={set('email')} placeholder="you@company.com" />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters.">
          <Input id="password" type="password" required minLength={8} autoComplete="new-password" leading={<Lock />} value={form.password} onChange={set('password')} placeholder="••••••••" />
        </Field>
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <Field label="Company / team" htmlFor="workspace">
            <Input id="workspace" leading={<Building2 />} value={form.workspace} onChange={set('workspace')} placeholder="Pixel Agency" />
          </Field>
          <Field label="Country" htmlFor="country">
            <NativeSelect id="country" value={form.country} onChange={set('country')}>
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
          Create workspace <ArrowRight />
        </Button>
        <p className="text-center text-xs text-subtle">The country sets how local phone numbers are read and your default time zone.</p>
      </form>
      <p className="mt-8 text-center text-[13px] text-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-foreground hover:text-primary">
          Sign in
        </Link>
      </p>
    </>
  );
}
