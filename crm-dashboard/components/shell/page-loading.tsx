import { Skeleton } from '@/components/ui/feedback';
import { Page } from './app-shell';

/** Shown the instant a page is opened, while the server prepares it (the loading.tsx files under app/(app)). */
export function PageLoading() {
  return (
    <Page>
      <div className="animate-fade-in" role="status" aria-label="Loading">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
          <Skeleton className="h-9 w-32 rounded-lg" />
        </div>
        <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <div className="space-y-2 rounded-xl border border-border bg-surface p-4">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </div>
    </Page>
  );
}

/** The same, for a section inside a page that already has its own header (settings). */
export function SectionLoading() {
  return (
    <div className="animate-fade-in space-y-4" role="status" aria-label="Loading">
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
