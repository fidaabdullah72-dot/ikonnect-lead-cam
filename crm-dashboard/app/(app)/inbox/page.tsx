import { Suspense } from 'react';
import { InboxView } from '@/components/inbox/inbox-view';
import { PageSpinner } from '@/components/ui/spinner';

export const metadata = { title: 'Inbox' };

export default function InboxPage() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <InboxView />
    </Suspense>
  );
}
