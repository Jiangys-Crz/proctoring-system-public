import { notFound, redirect } from 'next/navigation';
import { ContestDisplayAdmin } from '@/components/ContestDisplayAdmin';
import { getCurrentUser } from '@/lib/auth';
import { isContestLiveSupported } from '@/lib/contest-live-contract';
import { contestDisplayHistoryOptions } from '@/lib/contest-display-history';
import { prisma } from '@/lib/db';
import { canManageExam } from '@/lib/permissions';
import { publicTestExamId } from '@/lib/public-test';

export default async function ContestDisplayAdminPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (id === await publicTestExamId() || !await canManageExam(user, id)) redirect('/dashboard/live/displays');
  const exam = await prisma.exam.findUnique({ where: { id }, select: { id: true, name: true, platform: true, contestRule: true } });
  if (!exam) notFound();
  if (!isContestLiveSupported(exam.platform, exam.contestRule)) redirect('/dashboard/live/displays');
  const historyOptions = await contestDisplayHistoryOptions(id, user);
  return <ContestDisplayAdmin examId={exam.id} examName={exam.name} historyOptions={historyOptions} />;
}
