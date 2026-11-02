import { ExamDetailRoute } from '../../ExamDetailRoute';

export default async function ExamRoomsSettingsRoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <div className="exam-workspace-page exam-management-workspace"><ExamDetailRoute id={id} tab="settings" settingsTab="rooms" /></div>;
}
