import { redirect } from 'next/navigation';
import { ExamOverviewClient } from '@/components/ExamOverviewClient';
import { getCurrentUser } from '@/lib/auth';
import { canAccessExam, canManageExam } from '@/lib/permissions';

export default async function ExamLeaderboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!await canAccessExam(user, id)) redirect('/dashboard/exams');
  return <ExamOverviewClient examId={id} initialCanManage={await canManageExam(user, id)} initialView="leaderboard" fullScreen />;
}
