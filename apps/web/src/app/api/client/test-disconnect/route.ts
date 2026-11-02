import { z } from 'zod';
import { prisma } from '@/lib/db';
import { verifyClientTokenForSession } from '@/lib/client-auth';
import { createPairSecret } from '@/lib/pairing-security';
import { createPairingSession } from '@/lib/pairing-create';
import { isPublicTestExam } from '@/lib/public-test';
import { effectiveEnd } from '@/lib/contest-rules';
import { consumeRateLimit, UploadSecurityError } from '@/lib/upload-security';
import { withSessionWrite, SessionWriteQueueError } from '@/lib/session-write';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const Input = z.object({ sessionId: z.string().min(1).max(128), deviceId: z.string().min(1).max(128), side: z.enum(['DESKTOP', 'MINIPROGRAM']) }).strict();
export async function POST(request: Request) {
  try {
    const input = await parseBody(request, Input);
    const selected = await prisma.clientSession.findUnique({ where: { id: input.sessionId } });
    if (!selected || !verifyClientTokenForSession(request, selected, input.side)) return fail('当前连接已失效，请重新登录', 401);
    if (!await isPublicTestExam(selected.examId)) return fail('断网重连测试仅对系统测试考试开放', 403);
    await consumeRateLimit(`test-disconnect:${selected.id}`, 10);
    const result = await withSessionWrite(selected.id, async tx => {
      const session = await tx.clientSession.findUniqueOrThrow({ where: { id: selected.id }, include: { exam: true, candidate: true } });
      if (!verifyClientTokenForSession(request, session, input.side)
        || (input.side === 'DESKTOP' ? session.desktopDeviceId : session.miniProgramDeviceId) !== input.deviceId) return { error: true };
      const now = new Date();
      if (!session.desktopDeviceId || session.status === 'FINISHED' || session.lockdown || effectiveEnd(session.exam, session.candidate.startedAt) <= now) return { error: true };
      if (input.side === 'MINIPROGRAM') {
        await tx.clientSession.update({ where: { id: session.id }, data: {
          miniProgramTokenHash: null, lastMiniProgramSeenAt: now, miniProgramOfflineAt: now,
        } });
        return { disconnected: true, side: input.side };
      }
      // The authenticated desktop authorizes a one-use scan before its old token is removed.
      const poll = createPairSecret('POLL'), recovery = createPairSecret('RECOVERY');
      const pairing = await createPairingSession(tx, {
        purpose: 'TEST_DESKTOP_RECOVERY',
        recoverySessionId: session.id, loginRequestId: session.loginRequestId, desktopDeviceId: session.desktopDeviceId,
        pollTokenHash: poll.hash, recoveryTokenHash: recovery.hash, screenOk: true,
        expiresAt: new Date(now.getTime() + 120_000),
      });
      await tx.clientSession.update({ where: { id: session.id }, data: {
        desktopTokenHash: null, lastDesktopSeenAt: now, desktopOfflineAt: now, status: 'OFFLINE',
      } });
      return { disconnected: true, side: input.side, pairCode: pairing.pairCode, pollToken: poll.secret,
        recoverySecret: recovery.secret, expiresAt: pairing.expiresAt, serverNow: now };
    });
    if ('error' in result) return fail('当前状态无法进行重连测试', 409);
    return ok(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof SessionWriteQueueError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail('重连测试参数不正确', 400);
    return fail(toErrorMessage(error), error instanceof UploadSecurityError ? error.status : 500);
  }
}
export const OPTIONS = options;
