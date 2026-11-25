import type { Metadata } from 'next';
import { ContestLiveBrowser } from '@/contest-live-overlay/ContestLiveBrowser';

export const metadata: Metadata = {
  title: 'ICPC Live',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

type Query = Record<string, string | string[] | undefined>;

export default async function ContestLivePage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Query>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const scoreboardOnly = query.view === 'scoreboard';
  return <ContestLiveBrowser examId={id} accessKey={typeof query.key === 'string' ? query.key : undefined}
    preview={query.preview === '1'} scoreboardOnly={scoreboardOnly} noStatus={scoreboardOnly || query.noStatus !== undefined} />;
}
