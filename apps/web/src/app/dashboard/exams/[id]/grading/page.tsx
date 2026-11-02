import { redirect } from 'next/navigation';
import { ExamGradingClient } from '@/components/ExamGradingClient';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { canManageExam } from '@/lib/permissions';

export default async function ExamGradingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!await canManageExam(user, id)) redirect(`/dashboard/exams/${id}`);
  const exam = await prisma.exam.findUnique({ where: { id }, select: { contestRule: true } });
  if (!exam || exam.contestRule !== 'KS') redirect(`/dashboard/exams/${id}`);
  return <ExamGradingClient examId={id} />;
}
