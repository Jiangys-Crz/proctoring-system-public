import { getCurrentUser } from '@/lib/auth';
import { ProblemSubmitPageClient } from '@/components/ProblemSubmitPageClient';
import { canAccessHydroProblem } from '@/lib/permissions';
import { redirect } from 'next/navigation';

export default async function ProblemSubmitPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ examId?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!await canAccessHydroProblem(user, id)) redirect('/dashboard/exams');
  return <ProblemSubmitPageClient problemId={id} examId={query.examId} />;
}
