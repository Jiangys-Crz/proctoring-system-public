import { notFound, redirect } from 'next/navigation';
import { ContestLiveAdmin } from '@/components/ContestLiveAdmin';
import { getCurrentUser } from '@/lib/auth';
import { isContestLiveSupported } from '@/lib/contest-live-contract';
import { prisma } from '@/lib/db';
import { canManageExam } from '@/lib/permissions';

export default async function ContestLiveAdminPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!(await canManageExam(user, id))) redirect('/dashboard/live/contests');
  const exam = await prisma.exam.findUnique({ where: { id }, select: { id: true, name: true, platform: true, contestRule: true } });
  if (!exam) notFound();
  if (!isContestLiveSupported(exam.platform, exam.contestRule)) redirect('/dashboard/live/contests');
  return <ContestLiveAdmin examId={exam.id} examName={exam.name} />;
}
