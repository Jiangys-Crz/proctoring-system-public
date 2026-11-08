import { redirect } from 'next/navigation';

export default async function LegacyProctorRecordsPage({ searchParams }: { searchParams: Promise<{ examId?: string | string[] }> }) {
  const { examId } = await searchParams;
  redirect(typeof examId === 'string' && examId ? `/dashboard/exams/${encodeURIComponent(examId)}/proctor-records` : '/dashboard/exams');
}
