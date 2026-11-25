import { ZodError } from 'zod';
import { AuthError, requireUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { assertReleaseRequestOrigin } from '@/lib/desktop-releases';
import { fail, RequestParseError } from '@/lib/http';
import { canManageExam } from '@/lib/permissions';
import { UploadSecurityError } from '@/lib/upload-security';
import { supportsReaction } from '@/lib/reaction-source';

export async function requireReactionAdmin(examId: string, request?: Request) {
  const user = await requireUser(request);
  if (request) assertReleaseRequestOrigin(request);
  if (!await canManageExam(user, examId)) throw new AuthError('无权管理该考试的 Reaction', 403);
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true, platform: true } });
  if (!exam) throw new AuthError('考试不存在', 404);
  if (!supportsReaction(exam.platform)) throw new AuthError('该考试平台不支持自动 Reaction', 400);
  return user;
}

export function reactionRouteError(error: unknown) {
  if (error instanceof AuthError || error instanceof UploadSecurityError) return fail(error.message, error.status);
  if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
  if (error instanceof ZodError) return fail('Reaction 配置不正确', 400, error.flatten());
  // Do not log upstream exceptions: a transport error may contain a credential URL.
  if (error instanceof Error && error.message === 'REACTION_HYDRO_CONFIGURATION') return fail('请检查系统设置中的 Hydro 评测地址和 API-Key；使用其他站点时，请在本场考试填写该站点监考插件 API-Key', 400);
  const safeMessages = ['该考试平台不支持自动 Reaction', '本场录像已删除，不能开启 Reaction'];
  if (error instanceof Error && safeMessages.includes(error.message)) return fail(error.message, 400);
  return fail('Reaction 操作失败，请检查服务端配置和运行状态', 500);
}
