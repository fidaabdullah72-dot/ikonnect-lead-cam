import { ScrapeJobView } from '@/components/scraper/scraper-view';

export const metadata = { title: 'Lead search' };

export default async function ScrapeJobPage({ params }: PageProps<'/scraper/[id]'>) {
  const { id } = await params;
  return <ScrapeJobView id={id} />;
}
