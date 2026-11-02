import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { fail, ok, toErrorMessage } from '@/lib/http';

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const params = new URL(request.url).searchParams;
    const examId = params.get('examId');
    if (user.role !== 'SUPER_ADMIN' && (!examId || !await canManageExam(user, examId))) return fail('无权选择比赛管理员', 403);
    const query = (params.get('query') || '').trim().slice(0, 100);
    return ok(await prisma.user.findMany({
      where: query ? { OR: [{ username: { contains: query } }, { realName: { contains: query } }, { numberId: { contains: query } }] } : {},
      select: { id: true, username: true, realName: true, numberId: true },
      orderBy: { createdAt: 'desc' }, take: 30,
    }));
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}
