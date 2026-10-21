'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Callout } from '@/components/ui/feedback';
import { getSupabase } from '@/lib/supabase/client';
import { errorMessage } from '@/lib/utils';

export default function ForgotPasswordPage() {
  const [email, setEmail] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await getSupabase().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });
    setLoading(false);
    if (error) setError(errorMessage(error));
    else setSent(true);
  }

  return (
    <>
      <Link href="/login" className="mb-8 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Back to sign in
      </Link>
      <h2 className="text-2xl font-semibold tracking-[-0.025em]">Reset your password</h2>
      <p className="mt-1.5 text-[13.5px] text-muted">We’ll email you a link to choose a new one.</p>
      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}
        {sent ? (
          <Callout tone="success" title="Check your inbox">
            If an account exists for {email}, a reset link is on its way. No email? Ask a workspace admin to help.
          </Callout>
        ) : (
          <>
            <Field label="Email" htmlFor="email">
              <Input id="email" type="email" required inputSize="lg" leading={<Mail />} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
            </Field>
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
              Send reset link
            </Button>
          </>
        )}
      </form>
    </>
  );
}
