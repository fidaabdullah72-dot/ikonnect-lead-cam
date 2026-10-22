'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { KeyRound, Monitor, Moon, Sun } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Segmented } from '@/components/ui/controls';
import { Field, Input, PasswordInput } from '@/components/ui/input';
import { getSupabase } from '@/lib/supabase/client';
import { useWorkspace } from '@/lib/workspace';
import { errorMessage } from '@/lib/utils';

export default function ProfilePage() {
  const { profile, email, setProfile } = useWorkspace();
  const { theme, setTheme } = useTheme();
  const [name, setName] = React.useState(profile.full_name);
  const [pw, setPw] = React.useState('');
  const [pw2, setPw2] = React.useState('');

  async function saveName() {
    const { data, error } = await getSupabase().from('profiles').update({ full_name: name.trim() }).eq('id', profile.id).select('*').single();
    if (error) return toast.error(errorMessage(error));
    setProfile(data);
    toast.success('Profile saved');
  }
  async function savePw() {
    if (pw.length < 8) return toast.error('Use at least 8 characters');
    if (pw !== pw2) return toast.error('Passwords don’t match');
    const { error } = await getSupabase().auth.updateUser({ password: pw });
    if (error) return toast.error(errorMessage(error));
    setPw('');
    setPw2('');
    toast.success('Password changed');
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Your profile" />
        <CardContent className="flex flex-wrap items-end gap-4">
          <Avatar name={name || email} size="xl" />
          <Field label="Full name" className="min-w-[240px] flex-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email" className="min-w-[240px] flex-1">
            <Input value={email} disabled />
          </Field>
        </CardContent>
        <CardFooter>
          <Button variant="primary" onClick={saveName} disabled={!name.trim() || name === profile.full_name}>
            Save
          </Button>
        </CardFooter>
      </Card>
      <Card>
        <CardHeader title="Appearance" />
        <CardContent>
          <Segmented
            value={theme ?? 'dark'}
            onChange={setTheme}
            options={[
              { value: 'dark', label: 'Dark', icon: <Moon /> },
              { value: 'light', label: 'Light', icon: <Sun /> },
              { value: 'system', label: 'System', icon: <Monitor /> },
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader icon={<KeyRound />} title="Change password" />
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="New password">
            <PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Confirm">
            <PasswordInput value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
          </Field>
        </CardContent>
        <CardFooter>
          <Button variant="primary" onClick={savePw} disabled={!pw}>
            Update password
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
