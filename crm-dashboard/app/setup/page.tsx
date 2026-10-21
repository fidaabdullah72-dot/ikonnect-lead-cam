import { redirect } from 'next/navigation';
import { Database, KeyRound, Rocket } from 'lucide-react';
import { CenteredCard } from '@/components/centered-card';
import { isSupabaseConfigured } from '@/lib/env';

export const dynamic = 'force-dynamic';

const steps = [
  {
    icon: Database,
    title: 'Create a Supabase project',
    body: 'Free tier is fine to start. Then apply the SQL files in supabase/migrations (in order) from the SQL editor, or with `supabase db push`.',
  },
  {
    icon: KeyRound,
    title: 'Add the environment variables',
    body: 'Copy crm-dashboard/.env.example to .env.local and fill NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY. On Render, set them on the web service.',
  },
  {
    icon: Rocket,
    title: 'Start the engine',
    body: 'The engine (engine/) runs WhatsApp, campaigns and the scraper. It needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY too. Then restart and sign up.',
  },
];

export default function SetupPage() {
  if (isSupabaseConfigured()) redirect('/login');
  return (
    <CenteredCard wide>
      <h1 className="text-xl font-semibold tracking-[-0.02em]">Finish setting up CoreNexa</h1>
      <p className="mt-1 text-[13.5px] text-muted">The app isn’t connected to a database yet. Three steps:</p>
      <ol className="mt-6 space-y-5">
        {steps.map(({ icon: Icon, title, body }, i) => (
          <li key={title} className="flex gap-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
              <Icon className="size-4" />
            </span>
            <div>
              <div className="text-[14px] font-medium">
                {i + 1}. {title}
              </div>
              <p className="mt-0.5 text-[13px] text-muted">{body}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-8 border-t border-border pt-4 text-xs text-subtle">Full instructions are in README.md at the root of the project.</p>
    </CenteredCard>
  );
}
