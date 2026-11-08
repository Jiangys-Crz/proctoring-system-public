import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { NewExamClient } from '@/components/NewExamClient';
export default async function NewExamPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.role !== 'SUPER_ADMIN') redirect('/dashboard/exams');
  return <NewExamClient />;
}
