import { getCurrentUser } from '@/lib/auth';
import { ProblemRecordPageClient } from '@/components/ProblemRecordPageClient';
import { canAccessHydroProblem } from '@/lib/permissions';
import { redirect } from 'next/navigation';

export default async function ProblemRecordPage({ params, searchParams }: { params: Promise<{ id: string; recordId: string }>; searchParams: Promise<{ examId?: string }> }) {
  const [{ id, recordId }, query] = await Promise.all([params, searchParams]);
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!await canAccessHydroProblem(user, id)) redirect('/dashboard/exams');
  return <ProblemRecordPageClient problemId={id} recordId={recordId} examId={query.examId} />;
}
