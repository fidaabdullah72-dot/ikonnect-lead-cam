'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Building2 } from 'lucide-react';
import { COUNTRIES } from '@batsols/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Callout } from '@/components/ui/feedback';
import { CenteredCard } from '@/components/centered-card';
import { getSupabase } from '@/lib/supabase/client';
import { guessTimezone } from '@/lib/auth-client';
import { errorMessage } from '@/lib/utils';
import { switchWorkspace } from '@/app/(app)/actions';

export default function OnboardingPage() {
  const router = useRouter();
  const [name, setName] = React.useState('');
  const [country, setCountry] = React.useState('PK');
  React.useEffect(() => {
    const match = COUNTRIES.find((c) => c.timezone === guessTimezone());
    if (match) setCountry(match.code);
  }, []);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const c = COUNTRIES.find((x) => x.code === country);
    const { data, error } = await getSupabase().rpc('create_workspace', {
      p_name: name.trim(),
      p_timezone: c?.timezone ?? guessTimezone(),
      p_country: country,
    });
    if (error) {
      setError(errorMessage(error));
      setLoading(false);
      return;
    }
    await switchWorkspace(data);
    router.replace('/dashboard?welcome=1');
    router.refresh();
  }

  return (
    <CenteredCard>
      <h1 className="text-xl font-semibold tracking-[-0.02em]">Create a workspace</h1>
      <p className="mt-1 text-[13.5px] text-muted">
        A workspace holds your team’s leads, numbers and campaigns. Waiting for an invite instead? Open the link your admin sent you.
      </p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label="Company / team name" htmlFor="ws">
          <Input id="ws" required leading={<Building2 />} value={name} onChange={(e) => setName(e.target.value)} placeholder="Pixel Agency" />
        </Field>
        <Field label="Country" htmlFor="country" hint="Used to read local phone numbers and set your time zone.">
          <NativeSelect id="country" value={country} onChange={(e) => setCountry(e.target.value)}>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
          Create workspace <ArrowRight />
        </Button>
      </form>
    </CenteredCard>
  );
}
