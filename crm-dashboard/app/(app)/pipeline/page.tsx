import { Suspense } from 'react';
import { PipelineView } from '@/components/pipeline/pipeline-view';
import { PageSpinner } from '@/components/ui/spinner';

export const metadata = { title: 'Pipeline' };

export default function PipelinePage() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <PipelineView />
    </Suspense>
  );
}
