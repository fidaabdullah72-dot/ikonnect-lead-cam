import { Suspense } from 'react';
import { LeadsView } from '@/components/leads/leads-view';
import { PageSpinner } from '@/components/ui/spinner';

export const metadata = { title: 'Leads' };

export default function LeadsPage() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <LeadsView />
    </Suspense>
  );
}
