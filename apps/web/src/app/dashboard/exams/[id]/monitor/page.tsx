import { ExamDetailRoute } from '../ExamDetailRoute';

export default async function ExamMonitorRoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ExamDetailRoute id={id} tab="monitor" />;
}
