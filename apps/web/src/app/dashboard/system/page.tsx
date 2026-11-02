import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { SystemPageClient } from '@/components/SystemPageClient';

export default async function SystemPage() {
  const user = await getCurrentUser();
  if (user?.role !== 'SUPER_ADMIN') redirect('/dashboard/exams');
  return <SystemPageClient />;
}
