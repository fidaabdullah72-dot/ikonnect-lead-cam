'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, Lock, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input, PasswordInput } from '@/components/ui/input';
import { Callout } from '@/components/ui/feedback';
import { getSupabase } from '@/lib/supabase/client';

function safeNext(next: string | null) {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await getSupabase().auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setError(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message);
      setLoading(false);
      return;
    }
    router.replace(safeNext(params.get('next')));
    router.refresh();
  }

  return (
    <>
      <h2 className="text-2xl font-semibold tracking-[-0.025em]">Welcome back</h2>
      <p className="mt-1.5 text-[13.5px] text-muted">Sign in to your BatSols workspace.</p>
      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required inputSize="lg" leading={<Mail />} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        </Field>
        <Field
          label={
            <span className="flex w-full items-center justify-between">
              Password
              <Link href="/forgot-password" className="text-xs font-normal text-muted hover:text-foreground">
                Forgot password?
              </Link>
            </span>
          }
          htmlFor="password"
        >
          <PasswordInput id="password" autoComplete="current-password" required inputSize="lg" leading={<Lock />} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
          Sign in <ArrowRight />
        </Button>
      </form>
      <p className="mt-8 text-center text-[13px] text-muted">
        New to BatSols?{' '}
        <Link href="/signup" className="font-medium text-foreground hover:text-primary">
          Create a workspace
        </Link>
      </p>
    </>
  );
}

export default function LoginPage() {
  return (
    <React.Suspense>
      <LoginForm />
    </React.Suspense>
  );
}
