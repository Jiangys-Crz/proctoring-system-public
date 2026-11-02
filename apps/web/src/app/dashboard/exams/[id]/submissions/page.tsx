import { redirect } from 'next/navigation';
import { ExamOverviewClient } from '@/components/ExamOverviewClient';
import { getCurrentUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';

export default async function ExamSubmissionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const canManage = await canManageExam(user, id);
  if (!canManage) redirect(`/dashboard/exams/${id}`);
  return <ExamOverviewClient examId={id} initialCanManage initialView="submissions" fullScreen />;
}
