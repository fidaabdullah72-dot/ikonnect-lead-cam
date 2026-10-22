'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, Input, PasswordInput } from '@/components/ui/input';
import { Callout } from '@/components/ui/feedback';
import { CenteredCard } from '@/components/centered-card';
import { getSupabase } from '@/lib/supabase/client';
import { errorMessage } from '@/lib/utils';

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError('The passwords don’t match.');
      return;
    }
    setLoading(true);
    const { error } = await getSupabase().auth.updateUser({ password });
    setLoading(false);
    if (error) {
      setError(errorMessage(error));
      return;
    }
    toast.success('Password updated');
    router.replace('/dashboard');
  }

  return (
    <CenteredCard>
      <h1 className="text-xl font-semibold tracking-[-0.02em]">Choose a new password</h1>
      <p className="mt-1 text-[13.5px] text-muted">You’ll use it the next time you sign in.</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label="New password" htmlFor="pw" hint="At least 8 characters.">
          <PasswordInput id="pw" minLength={8} required leading={<Lock />} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Confirm password" htmlFor="pw2">
          <PasswordInput id="pw2" minLength={8} required leading={<Lock />} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </Field>
        <Button type="submit" variant="primary" className="w-full" size="lg" loading={loading}>
          Update password
        </Button>
      </form>
    </CenteredCard>
  );
}
