import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { UsersPageClient } from '@/components/UsersPageClient';

export default async function UsersPage() {
  const user = await getCurrentUser();
  if (user?.role !== 'SUPER_ADMIN') redirect('/dashboard/exams');
  return <UsersPageClient />;
}
