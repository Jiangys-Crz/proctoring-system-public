import { requireSuperAdmin } from '@/lib/auth';
import { ProblemsPageClient } from '@/components/ProblemsPageClient';
export default async function ProblemsPage() { await requireSuperAdmin(); return <ProblemsPageClient />; }
