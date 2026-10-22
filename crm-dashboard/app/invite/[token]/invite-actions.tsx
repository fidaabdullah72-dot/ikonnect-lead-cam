'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Lock, Mail, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input, PasswordInput } from '@/components/ui/input';
import { Callout } from '@/components/ui/feedback';
import { getSupabase } from '@/lib/supabase/client';
import { createAccount } from '@/lib/auth-client';
import { errorMessage } from '@/lib/utils';
import { switchWorkspace } from '@/app/(app)/actions';

export function InviteActions({ token, inviteEmail, signedInEmail }: { token: string; inviteEmail: string | null; signedInEmail: string | null }) {
  const router = useRouter();
  const [form, setForm] = React.useState({ full_name: '', email: inviteEmail ?? '', password: '' });
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function accept() {
    const { data, error } = await getSupabase().rpc('accept_invite', { p_token: token });
    if (error) throw error;
    await switchWorkspace(data);
    router.replace('/dashboard?welcome=1');
    router.refresh();
  }

  async function run(fn: () => Promise<void>) {
    setLoading(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }

  if (signedInEmail) {
    return (
      <div className="space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}
        <p className="text-[13px] text-muted">
          Signed in as <span className="font-medium text-foreground">{signedInEmail}</span>.
        </p>
        <Button variant="primary" size="lg" className="w-full" loading={loading} onClick={() => run(accept)}>
          Join workspace <ArrowRight />
        </Button>
        <button
          type="button"
          className="w-full text-center text-xs text-muted hover:text-foreground"
          onClick={async () => {
            await getSupabase().auth.signOut();
            router.refresh();
          }}
        >
          Not you? Sign out
        </button>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const result = await createAccount({ ...form, email: form.email.trim(), full_name: form.full_name.trim(), invite_token: token });
          if (result === 'confirm_email') {
            setError('Confirm your email from the message we sent, then open this invite link again.');
            setLoading(false);
            return;
          }
          await accept();
        });
      }}
    >
      {error && <Callout tone="danger">{error}</Callout>}
      <Field label="Your name" htmlFor="name">
        <Input id="name" required leading={<User />} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
      </Field>
      <Field label="Email" htmlFor="email">
        <Input id="email" type="email" required readOnly={!!inviteEmail} leading={<Mail />} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </Field>
      <Field label="Choose a password" htmlFor="password" hint="At least 8 characters.">
        <PasswordInput id="password" required minLength={8} leading={<Lock />} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
      </Field>
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
        Create account & join <ArrowRight />
      </Button>
      <p className="text-center text-[13px] text-muted">
        Already have an account?{' '}
        <Link href={`/login?next=/invite/${token}`} className="font-medium text-foreground hover:text-primary">
          Sign in
        </Link>
      </p>
    </form>
  );
}
