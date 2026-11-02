import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { ExamEditor } from '@/components/ExamEditor';
export default async function ExamSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!await canManageExam(user, id)) redirect('/dashboard/exams');
  return <ExamEditor examId={id} />;
}
