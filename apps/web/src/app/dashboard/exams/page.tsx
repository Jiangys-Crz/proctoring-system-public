import { ExamsPageClient } from '@/components/ExamsPageClient';
import { getCurrentUser } from '@/lib/auth';

export default async function ExamsPage() {
  const user = await getCurrentUser();
  return <ExamsPageClient role={user?.role || 'ADMIN'} />;
}
