import { notFound, redirect } from 'next/navigation';
import { ExamHistoryFrame } from '@/components/ExamHistoryFrame';
import { RecordingsPageClient } from '@/components/RecordingsPageClient';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { canAccessExam } from '@/lib/permissions';

export default async function ExamRecordingsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const { id } = await params;
  if (!await canAccessExam(user, id)) redirect('/dashboard/exams');
  const exam = await prisma.exam.findUnique({ where: { id }, select: { name: true } });
  if (!exam) notFound();
  return <ExamHistoryFrame examId={id} current="recordings" canViewProctorRecords={user.role === 'SUPER_ADMIN'}>
    <RecordingsPageClient key={id} examId={id} />
  </ExamHistoryFrame>;
}
