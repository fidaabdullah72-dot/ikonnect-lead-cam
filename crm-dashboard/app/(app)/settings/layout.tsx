import { Settings } from 'lucide-react';
import { Page } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/ui/layout';
import { SettingsNav } from '@/components/settings/settings-nav';

export const metadata = { title: 'Settings' };

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Page>
      <PageHeader icon={<Settings />} title="Settings" description="Workspace, team, pipeline and integrations." />
      <div className="grid gap-8 lg:grid-cols-[200px_1fr]">
        <SettingsNav />
        <div className="min-w-0">{children}</div>
      </div>
    </Page>
  );
}
