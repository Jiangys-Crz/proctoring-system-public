import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { ExamCodeCheckClient } from '@/components/ExamCodeCheckClient';

export default async function ExamCodeCheckPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!await canManageExam(user, id)) redirect(`/dashboard/exams/${id}`);
  return <ExamCodeCheckClient examId={id} />;
}
