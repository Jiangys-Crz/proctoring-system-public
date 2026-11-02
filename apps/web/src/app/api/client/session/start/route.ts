import { z } from 'zod';
import { isPublicTestExam } from '@/lib/public-test';
import { testMediaState } from '@/lib/test-media-state';
import { publicClientSession } from '@/lib/client-auth';
import { requireContestSession } from '@/lib/client-contest';
import { withSessionWrite, SessionWriteQueueError } from '@/lib/session-write';
import { LoginFlowError } from '@/lib/room-login-policy';
import { candidateStartDeadline, effectiveEnd } from '@/lib/contest-rules';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
const StartSchema = z.object({ sessionId: z.string().min(1), confirm: z.literal(true) });
export async function POST(request: Request) {
  try {
    const input = await parseBody(request, StartSchema);
    const auth = await requireContestSession(request, input.sessionId, false, true);
    if (!auth.ok) return fail(auth.message, auth.status);
    const { session } = auth;
    if (!['APPROVED', 'IN_EXAM'].includes(session.status) || session.lockdown) return fail('当前状态不能开始考试', 409);
    if (!session.startedAt && await isPublicTestExam(session.examId)) {
      if (!session.miniProgramDeviceId || !session.miniProgramTokenHash || !session.lastMiniProgramSeenAt
        || session.lastMiniProgramSeenAt.getTime() < Date.now() - 20_000) return fail('测试考试必须连接手机第二机位，请先扫码并保持手机页面开启', 409);
      const channels = await testMediaState(session.id);
      if (!channels.every(channel => channel.ready)) return fail('请等待屏幕、电脑摄像头和手机第二机位全部通过推流检测后再开始', 409);
    }
    const now = new Date();
    const existingStart = session.startedAt;
    if (!existingStart && (now < session.exam.startAt || now > candidateStartDeadline(session.exam, session.candidate.lateStartAllowedAt) || now >= session.exam.endAt)) return fail('当前不在允许开始考试的时间窗口内', 400);
    if (now >= effectiveEnd(session.exam, existingStart)) return fail('考试已经结束', 400);
    const updated = await withSessionWrite(session.id, async tx => {
      await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${session.candidateId} FOR UPDATE`;
      const current = await tx.clientSession.findUniqueOrThrow({ where: { id: session.id }, include: { candidate: true, exam: true } });
      if (current.revokedAt || current.candidate.status === 'FINISHED' || !['APPROVED', 'IN_EXAM'].includes(current.status) || current.lockdown) throw new LoginFlowError('当前状态不能开始考试', 409);
      const firstStart = current.candidate.startedAt || current.startedAt;
      const startedNow = new Date();
      if (!firstStart && (startedNow < current.exam.startAt || startedNow > candidateStartDeadline(current.exam, current.candidate.lateStartAllowedAt))) throw new LoginFlowError('当前不在允许开始考试的时间窗口内', 400);
      if (startedNow >= effectiveEnd(current.exam, firstStart)) throw new LoginFlowError('考试已经结束', 400);
      // Compare-and-set preserves the first clock across concurrent clicks and new sessions.
      await tx.candidate.updateMany({ where: { id: session.candidateId, startedAt: null }, data: { startedAt: firstStart || startedNow } });
      const candidate = await tx.candidate.findUniqueOrThrow({ where: { id: session.candidateId } });
      const changed = await tx.clientSession.updateMany({ where: { id: session.id, status: { in: ['APPROVED', 'IN_EXAM'] }, lockdown: false }, data: { status: 'IN_EXAM', startedAt: candidate.startedAt } });
      if (!changed.count) throw new Error('会话状态已改变，请刷新');
      await tx.candidate.update({ where: { id: candidate.id }, data: { status: 'ONLINE_NORMAL' } });
      return tx.clientSession.findUniqueOrThrow({ where: { id: session.id } });
    });
    return ok({ ...publicClientSession(updated), effectiveEndAt: effectiveEnd(session.exam, updated.startedAt).toISOString() });
  } catch (error) {
    if (error instanceof SessionWriteQueueError) return fail(error.message, error.status);
    if (error instanceof LoginFlowError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}
export const OPTIONS = options;
