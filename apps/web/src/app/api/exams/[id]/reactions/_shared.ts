import { ZodError } from 'zod';
import { AuthError, requireUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { assertReleaseRequestOrigin } from '@/lib/desktop-releases';
import { fail, RequestParseError } from '@/lib/http';
import { canManageExam } from '@/lib/permissions';
import { UploadSecurityError } from '@/lib/upload-security';

export async function requireReactionAdmin(examId: string, request?: Request) {
  const user = await requireUser(request);
  if (request) assertReleaseRequestOrigin(request);
  if (!await canManageExam(user, examId)) throw new AuthError('无权管理该考试的 Reaction', 403);
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true, platform: true } });
  if (!exam) throw new AuthError('考试不存在', 404);
  if (exam.platform !== 'NOVAJUDGE') throw new AuthError('仅 NovaJudge 考试支持自动 Reaction', 400);
  return user;
}

export function reactionRouteError(error: unknown) {
  if (error instanceof AuthError || error instanceof UploadSecurityError) return fail(error.message, error.status);
  if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
  if (error instanceof ZodError) return fail('Reaction 配置不正确', 400, error.flatten());
  // Do not log upstream exceptions: a transport error may contain a credential URL.
  const safeMessages = ['仅 NovaJudge 考试支持自动 Reaction', '本场录像已删除，不能开启 Reaction'];
  if (error instanceof Error && safeMessages.includes(error.message)) return fail(error.message, 400);
  return fail('Reaction 操作失败，请检查服务端配置和运行状态', 500);
}
