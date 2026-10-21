import { Suspense } from 'react';
import { ScraperView } from '@/components/scraper/scraper-view';
import { PageSpinner } from '@/components/ui/spinner';

export const metadata = { title: 'Lead finder' };

export default function ScraperPage() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <ScraperView />
    </Suspense>
  );
}
