import { getCurrentUser } from '@/lib/auth';
import { ProblemDetailPageClient } from '@/components/ProblemDetailPageClient';
import { getHydroSettings } from '@/lib/settings';
import { canAccessHydroProblem } from '@/lib/permissions';
import { redirect } from 'next/navigation';
export default async function ProblemDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ examId?: string }> }) { const [{ id }, query, hydro, user] = await Promise.all([params, searchParams, getHydroSettings(), getCurrentUser()]); if (!user) redirect('/login'); if (!await canAccessHydroProblem(user, id)) redirect('/dashboard/exams'); return <ProblemDetailPageClient problemId={id} hydroBaseUrl={hydro.baseUrl} problemDomainId={hydro.problemDomainId} canManage={user.role === 'SUPER_ADMIN'} examId={query.examId} />; }
