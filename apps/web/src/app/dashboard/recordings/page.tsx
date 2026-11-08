import { redirect } from 'next/navigation';

export default async function LegacyRecordingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { examId, roomId, candidateId } = await searchParams;
  if (typeof examId !== 'string' || !examId) redirect('/dashboard/exams');
  const query = new URLSearchParams();
  if (typeof roomId === 'string' && roomId) query.set('roomId', roomId);
  if (typeof candidateId === 'string' && candidateId) query.set('candidateId', candidateId);
  redirect(`/dashboard/exams/${encodeURIComponent(examId)}/recordings${query.size ? `?${query}` : ''}`);
}
