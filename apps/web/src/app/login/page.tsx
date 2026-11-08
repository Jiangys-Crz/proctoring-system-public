import { redirect } from 'next/navigation';
import { LoginPageClient } from '@/components/LoginPageClient';
import { getCurrentUser } from '@/lib/auth';

export default async function LoginPage() {
  if (await getCurrentUser()) redirect('/dashboard/exams');
  return <LoginPageClient />;
}
