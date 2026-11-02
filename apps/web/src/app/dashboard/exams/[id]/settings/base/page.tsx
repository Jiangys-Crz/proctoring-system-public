import { redirect } from 'next/navigation';
export default async function ExamBaseSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/dashboard/exams/${id}/settings`);
}
