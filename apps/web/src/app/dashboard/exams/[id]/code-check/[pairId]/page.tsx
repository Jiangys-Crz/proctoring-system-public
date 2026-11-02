import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { ExamCodeCheckDetailClient } from '@/components/ExamCodeCheckDetailClient';

export default async function ExamCodeCheckDetailPage({ params }: { params: Promise<{ id: string; pairId: string }> }) {
  const { id, pairId } = await params; const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!await canManageExam(user, id)) redirect(`/dashboard/exams/${id}`);
  return <ExamCodeCheckDetailClient examId={id} pairId={pairId} />;
}
