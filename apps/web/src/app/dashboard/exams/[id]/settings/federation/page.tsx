import { ExamDetailRoute } from '../../ExamDetailRoute';

export default async function FederationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <div className="exam-workspace-page exam-management-workspace"><ExamDetailRoute id={id} tab="settings" settingsTab="federation" /></div>;
}
