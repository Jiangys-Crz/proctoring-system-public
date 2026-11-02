import { prisma } from '@/lib/db';
import { ok, options } from '@/lib/http';
import { requireScreenControlAdmin, screenControlRouteError } from '@/lib/screen-control-route';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await requireScreenControlAdmin(id, request);
    const q = (new URL(request.url).searchParams.get('q') || '').trim().slice(0, 100);
    const [exam, candidates] = await Promise.all([
      prisma.exam.findUniqueOrThrow({ where: { id }, select: { contestType: true } }),
      prisma.candidate.findMany({
        where: { examId: id, ...(q ? { OR: [
          { name: { contains: q } }, { teamName: { contains: q } }, { examNumber: { contains: q } },
        ] } : {}) },
        select: { id: true, name: true, teamName: true, examNumber: true },
        orderBy: [{ seatNo: 'asc' }, { examNumber: 'asc' }, { id: 'asc' }], take: 50,
      }),
    ]);
    return ok({ contestType: exam.contestType, candidates }, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) { return screenControlRouteError(error); }
}

export const OPTIONS = options;
