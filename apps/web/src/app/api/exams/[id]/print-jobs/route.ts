import { z } from 'zod';
import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessExam, canAccessCandidate, canManageExam } from '@/lib/permissions';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const ActionSchema = z.object({ id: z.string().min(1), action: z.enum(['PRINTED', 'REJECTED']), reason: z.string().trim().max(1000).optional() });

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await context.params;
    if (!(await canAccessExam(user, id))) return fail('无权查看打印记录', 403);
    const scope = await canManageExam(user, id) ? {} : { candidate: { rooms: { some: { room: { proctors: { some: { userId: user.id } } } } } } };
    return ok(await prisma.printJob.findMany({ where: { examId: id, ...scope }, orderBy: { createdAt: 'desc' } }));
  } catch (error) { if (error instanceof AuthError) return fail(error.message, error.status); return fail(toErrorMessage(error), 500); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request); const { id: examId } = await context.params;
    if (!(await canAccessExam(user, examId))) return fail('无权处理打印记录', 403);
    const input = await parseBody(request, ActionSchema);
    if (input.action === 'REJECTED' && !input.reason) return fail('请输入驳回理由', 400);
    const existing = await prisma.printJob.findFirst({ where: { id: input.id, examId } });
    if (!existing) return fail('打印任务不存在', 404);
    if (!(await canAccessCandidate(user, existing.candidateId))) return fail('无权处理其他考室考生的打印任务', 403);
    const scope = await canManageExam(user, examId) ? {} : { candidate: { rooms: { some: { room: { proctors: { some: { userId: user.id } } } } } } };
    const updated = await prisma.printJob.updateMany({ where: { id: input.id, examId, ...scope }, data: {
      status: input.action, rejectedReason: input.action === 'REJECTED' ? input.reason : null,
      reviewedById: user.id, reviewedAt: new Date(), printedAt: input.action === 'PRINTED' ? new Date() : null,
    } });
    if (!updated.count) return fail('打印任务权限已变化，请刷新', 403);
    const job = await prisma.printJob.findFirst({ where: { id: input.id, examId, ...scope } });
    return ok(job);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}
export const OPTIONS = options;
