import { ExamDetailClient } from '@/components/ExamDetailClient';
import { getCurrentUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { redirect } from 'next/navigation';

type DetailRoute = 'status' | 'login' | 'login-restrictions' | 'qa' | 'print' | 'monitor' | 'screen' | 'settings';
type SettingsRoute = 'base' | 'problems' | 'candidates' | 'rooms' | 'external-board' | 'federation';

export async function ExamDetailRoute({
  id,
  tab,
  settingsTab = 'base'
}: {
  id: string;
  tab: DetailRoute;
  settingsTab?: SettingsRoute;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const canManage = await canManageExam(user, id);
  if ((tab === 'settings' || tab === 'screen') && !canManage) redirect(`/dashboard/exams/${id}`);
  return <ExamDetailClient examId={id} canManage={canManage} initialTab={tab} initialSettingsTab={settingsTab} />;
}
