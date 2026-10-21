import { Suspense } from 'react';
import { CampaignBuilder } from '@/components/campaigns/builder/builder';
import { PageSpinner } from '@/components/ui/spinner';

export const metadata = { title: 'New campaign' };

export default function NewCampaignPage() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <CampaignBuilder />
    </Suspense>
  );
}
