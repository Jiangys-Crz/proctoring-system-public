import { getCurrentUser } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { MonitorPageClient } from '@/components/MonitorPageClient';

export default async function MonitorPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return <MonitorPageClient />;
}
