import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { LiveRelayManager } from '@/components/LiveRelayManager';

export default async function LivePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.role !== 'SUPER_ADMIN') redirect('/dashboard/exams');
  return <LiveRelayManager />;
}
