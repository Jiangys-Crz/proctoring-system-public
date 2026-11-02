import { getCurrentUser } from '@/lib/auth';
import { ProblemRecordsPageClient } from '@/components/ProblemRecordsPageClient';
import { canAccessHydroProblem } from '@/lib/permissions';
import { redirect } from 'next/navigation';

export default async function ProblemRecordsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ examId?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!await canAccessHydroProblem(user, id)) redirect('/dashboard/exams');
  return <ProblemRecordsPageClient problemId={id} examId={query.examId} />;
}
