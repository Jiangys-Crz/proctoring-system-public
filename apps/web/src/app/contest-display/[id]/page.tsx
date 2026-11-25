import type { Metadata } from 'next';
import { ContestDisplay } from '@/components/contest-display/ContestDisplay';

export const metadata: Metadata = {
  title: 'XCPC Presentation',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

type Query = Record<string, string | string[] | undefined>;

export default async function ContestDisplayPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Query>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const displayKey = typeof query.key === 'string' ? query.key : undefined;
  return <ContestDisplay key={JSON.stringify([id, displayKey])} examId={id} displayKey={displayKey} />;
}
