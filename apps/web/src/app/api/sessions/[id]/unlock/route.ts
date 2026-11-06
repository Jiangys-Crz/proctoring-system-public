import { resumedSessionStatus } from '@/lib/session-resume';
import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { isPublicTestExam } from '@/lib/public-test';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessCandidate } from '@/lib/permissions';
import { publicClientSession } from '@/lib/client-auth';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { withSessionWrite, SessionWriteQueueError } from '@/lib/session-write';
import { effectiveEnd } from '@/lib/contest-rules';
import { UnlockSchema } from '@/lib/monitor-action-schemas';
import { refreshCandidateAlertStatus } from '@/lib/alert-acknowledgement';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const { reason } = await parseBody(request, UnlockSchema);
    const session = await prisma.clientSession.findUnique({ where: { id }, include: { candidate: true } });
    if (!session) return fail('客户端会话不存在', 404);
    if (!(await canAccessCandidate(user, session.candidateId))) return fail('无权解锁该考生', 403);
    const updated = await withSessionWrite(id, async (tx) => {
      const current = await tx.clientSession.findUniqueOrThrow({ where: { id }, include: { candidate: true, exam: true } });
      const firstStartedAt = current.candidate.startedAt || current.startedAt;
      if (current.status === 'FINISHED' || effectiveEnd(current.exam, firstStartedAt) <= new Date() || !current.lockdown) return null;
      const item = await tx.clientSession.update({
        where: { id },
        data: {
          status: resumedSessionStatus({ ...current, lockdown: false }, firstStartedAt),
          startedAt: firstStartedAt,
          lockdown: false,
          lockdownReason: null,
          unlockNonce: crypto.randomUUID(),
          peripheralsBaselineFingerprint: current.lastPeripheralsFingerprint || current.peripheralsBaselineFingerprint
        }
      });
      if (!await isPublicTestExam(current.examId, tx)) await tx.alert.create({
        data: {
          examId: current.examId,
          candidateId: current.candidateId,
          sessionId: current.id,
          type: 'MANUAL_NOTE',
          severity: 2,
          message: `监考老师 ${user.realName || user.username || user.numberId || user.id} 取消锁定，原因：${reason}；原锁定原因：${current.lockdownReason || '未记录'}`,
          acknowledgedAt: new Date()
        }
      });
      await refreshCandidateAlertStatus(tx, current.candidateId);
      return item;
    });
    if (!updated) return fail('考试会话已结束或当前未锁定，不能解锁', 409);
    return ok(publicClientSession(updated));
  } catch (error) {
    if (error instanceof SessionWriteQueueError) return fail(error.message, error.status);
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
