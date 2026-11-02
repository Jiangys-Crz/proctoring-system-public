import { UploadSecurityError } from '@/lib/upload-security';
import { z } from 'zod';
import { AuthError, requireUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { assertReleaseRequestOrigin } from '@/lib/desktop-releases';
import { processFileDeletions } from '@/lib/file-deletion';
import { fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import type { Prisma, User } from '@prisma/client';

async function scope(user: User, kind: 'MEDIA' | 'INSTALLER'): Promise<Prisma.FileDeletionJobWhereInput> {
  if (kind === 'INSTALLER' && user.role !== 'SUPER_ADMIN') throw new AuthError('需要超级管理员权限', 403);
  if (user.role === 'SUPER_ADMIN') return { kind };
  const exams = await prisma.exam.findMany({ where: { OR: [{ createdById: user.id }, { administrators: { some: { userId: user.id } } }] }, select: { id: true } });
  return { kind, examId: { in: exams.map(e => e.id) } };
}
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const kind = z.enum(['MEDIA', 'INSTALLER']).parse(new URL(request.url).searchParams.get('kind'));
    const where = { AND: [await scope(user, kind), { completedAt: null }] };
    const [pending, failed] = await Promise.all([prisma.fileDeletionJob.count({ where }), prisma.fileDeletionJob.count({ where: { AND: [where, { lastError: { not: null } }] } })]);
    return ok({ pending, failed });
  } catch (error) {
    if (error instanceof AuthError || error instanceof UploadSecurityError) return fail(error.message, error.status);
    return fail('清理状态读取失败', 400);
  }
}
export async function POST(request: Request) {
  try {
    const user = await requireUser(request); assertReleaseRequestOrigin(request);
    const { kind } = await parseBody(request, z.object({ kind: z.enum(['MEDIA', 'INSTALLER']) }).strict());
    const filter = await scope(user, kind);
    await prisma.fileDeletionJob.updateMany({ where: { AND: [filter, { completedAt: null, OR: [{ claimUntil: null }, { claimUntil: { lt: new Date() } }] }] }, data: { nextAttemptAt: new Date() } });
    void processFileDeletions(filter, 5).catch(error => console.error('Manual file cleanup retry failed', error));
    return ok({ retryScheduled: true });
  } catch (error) {
    if (error instanceof AuthError || error instanceof UploadSecurityError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail('清理参数无效', 400);
    return fail(toErrorMessage(error), 500);
  }
}
