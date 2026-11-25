import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { LiveManagementNav } from '@/components/LiveManagementNav';

export default async function LiveManagementLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return <div className="grid">
    <LiveManagementNav canManageRelay={user.role === 'SUPER_ADMIN'} />
    {children}
  </div>;
}
