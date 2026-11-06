import { redirect, notFound } from 'next/navigation';
import { ReactionAdminClient } from '@/components/ReactionAdminClient';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { canManageExam } from '@/lib/permissions';

export default async function ReactionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!await canManageExam(user, id)) redirect(`/dashboard/exams/${id}`);
  const exam = await prisma.exam.findUnique({ where: { id }, select: { platform: true } });
  if (!exam) notFound();
  if (exam.platform !== 'NOVAJUDGE') redirect(`/dashboard/exams/${id}`);
  return <ReactionAdminClient examId={id} />;
}
