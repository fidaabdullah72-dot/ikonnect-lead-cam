import { Suspense } from 'react';
import { NumbersView } from '@/components/whatsapp/numbers-view';
import { PageSpinner } from '@/components/ui/spinner';

export const metadata = { title: 'WhatsApp numbers' };

export default function WhatsAppPage() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <NumbersView />
    </Suspense>
  );
}
