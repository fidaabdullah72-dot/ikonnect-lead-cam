import { Suspense } from 'react';
import { CampaignBuilder } from '@/components/campaigns/builder/builder';
import { PageSpinner } from '@/components/ui/spinner';

export const metadata = { title: 'Edit campaign' };

export default async function EditCampaignPage({ params }: PageProps<'/campaigns/[id]/edit'>) {
  const { id } = await params;
  return (
    <Suspense fallback={<PageSpinner />}>
      <CampaignBuilder campaignId={id} />
    </Suspense>
  );
}
