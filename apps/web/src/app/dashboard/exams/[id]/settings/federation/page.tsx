import { redirect } from 'next/navigation';

export default async function FederationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/dashboard/exams/${encodeURIComponent(id)}/settings#exam-settings`);
}
