import { redirect } from 'next/navigation';
import { ContestLiveExamList } from '@/components/ContestLiveExamList';
import { getCurrentUser } from '@/lib/auth';
import { isContestLiveSupported } from '@/lib/contest-live-contract';
import { prisma } from '@/lib/db';
import { compareExamStart } from '@/lib/exam-list-order';
import { publicTestExamId } from '@/lib/public-test';

export async function ExamPicker({ mode }: { mode: 'contests' | 'displays' }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const testId = await publicTestExamId();
  const exams = await prisma.exam.findMany({
    where: {
      id: { not: testId },
      ...(user.role === 'SUPER_ADMIN' ? {} : { OR: [{ createdById: user.id }, { administrators: { some: { userId: user.id } } }] }),
    },
    select: { id: true, name: true, examCode: true, platform: true, contestRule: true, startAt: true, endAt: true, _count: { select: { candidates: true } } },
  });
  const now = Date.now();
  const candidates = exams.filter(exam => isContestLiveSupported(exam.platform, exam.contestRule))
    .sort((a, b) => compareExamStart(a, b, now))
    .map(exam => ({ ...exam, startAt: exam.startAt.toISOString(), endAt: exam.endAt.toISOString() }));
  return <ContestLiveExamList exams={candidates} mode={mode} />;
}
