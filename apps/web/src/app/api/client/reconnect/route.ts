import { resumedSessionStatus } from '@/lib/session-resume';
import { admittedLogin } from '@/lib/request-admission';
import { mobileRecoveryToken } from '@/lib/mobile-recovery-token';
import { ClientReconnectSchema } from '@cwnupaa/proctor-shared';
import { LoginFlowError } from '@/lib/room-login-policy';
import { prisma } from '@/lib/db';
import { isPublicTestExam } from '@/lib/public-test';
import { publicClientSession, verifyClientTokenValueForSession } from '@/lib/client-auth';
import { verifyPairSecret } from '@/lib/pairing-security';
import { withSessionWrite, SessionWriteQueueError } from '@/lib/session-write';
import { revokedClientSessionResponse } from '@/lib/client-session-response';
import { reconnectDesktop } from '@/lib/desktop-reconnect';
import { effectiveEnd } from '@/lib/contest-rules';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

export async function POST(request: Request) {
  return admittedLogin(request, () => handlePost(request));
}

async function handlePost(request: Request) {
  try {
    const input = await parseBody(request, ClientReconnectSchema, 16 * 1024);
    const pairing = await prisma.pairingSession.findUnique({ where: { pairCode: input.pairCode } });
    if (input.side === 'DESKTOP') {
      if (!pairing || !['INITIAL', 'DESKTOP_RECOVERY'].includes(pairing.purpose) || !pairing.pollTokenHash || !verifyPairSecret('RECOVERY', input.recoverySecret, pairing.recoveryTokenHash)) return fail('请扫描客户端新生成的完整登录二维码', 403);
      return await reconnectDesktop(request, input, pairing);
    }
    if (!pairing || !['RECOVERY', 'TEST_DESKTOP_RECOVERY'].includes(pairing.purpose) || !pairing.recoverySessionId
      || !verifyPairSecret('RECOVERY', input.recoverySecret, pairing.recoveryTokenHash)) return fail('恢复二维码无效，请在已登录的电脑端重新生成', 403);
    if (pairing.purpose === 'TEST_DESKTOP_RECOVERY' && !await isPublicTestExam((await prisma.clientSession.findUnique({ where: { id: pairing.recoverySessionId } }))?.examId || '')) return fail('恢复二维码无效', 403);
    if (input.sessionId && input.sessionId !== pairing.recoverySessionId) return fail('恢复二维码不属于该考试会话', 403);
    const token = mobileRecoveryToken(pairing.id, pairing.recoverySessionId, input.deviceId, input.recoverySecret);
    const result = await withSessionWrite(pairing.recoverySessionId, async (tx) => {
      const session = await tx.clientSession.findUnique({ where: { id: pairing.recoverySessionId! }, include: { exam: true, candidate: { select: { startedAt: true, status: true } } } });
      if (!session || session.revokedAt) return { error: 'REVOKED' as const };
      const now = new Date();
      const firstStartedAt = session.candidate.startedAt || session.startedAt;
      if (session.status === 'FINISHED' || session.candidate.status === 'FINISHED' || effectiveEnd(session.exam, firstStartedAt) <= now) return { error: 'FINISHED' as const };
      if (session.desktopDeviceId !== pairing.desktopDeviceId) return { error: 'INVALID' as const };
      const currentPair = await tx.pairingSession.findUnique({ where: { id: pairing.id } });
      if (!currentPair || currentPair.purpose !== pairing.purpose || currentPair.recoverySessionId !== session.id
        || currentPair.desktopDeviceId !== session.desktopDeviceId || currentPair.expiresAt <= now
        || !verifyPairSecret('RECOVERY', input.recoverySecret, currentPair.recoveryTokenHash)) return { error: 'EXPIRED' as const };
      // A lost HTTP response or server restart after commit must not strand the
      // phone. Replaying the same claim cannot rotate a later phone's token.
      if (currentPair.claimedAt && (session.miniProgramDeviceId !== input.deviceId
        || !verifyClientTokenValueForSession(token.token, session, 'MINIPROGRAM'))) return { error: 'EXPIRED' as const };
      const room = await tx.examRoom.findFirst({ where: { examId: session.examId, candidates: { some: { candidateId: session.candidateId } } }, select: { requireFrontCamera: true, requireSecondCamera: true, loginMode: true } });
      const requireSecondCamera = room?.requireSecondCamera ?? session.exam.requireMiniProgram;
      if (!currentPair.claimedAt) {
        const claimed = await tx.pairingSession.updateMany({
          where: { id: pairing.id, purpose: pairing.purpose, recoverySessionId: session.id,
            recoveryTokenHash: pairing.recoveryTokenHash, claimedAt: null, expiresAt: { gt: now } },
          data: { claimedAt: now },
        });
        if (!claimed.count) return { error: 'EXPIRED' as const };
      }
      const { exam: _exam, candidate: _candidate, ...sessionRow } = session;
      const refreshed = currentPair.claimedAt ? sessionRow : await tx.clientSession.update({ where: { id: session.id }, data: {
        miniProgramDeviceId: input.deviceId, miniProgramTokenHash: token.tokenHash,
        ...(pairing.purpose === 'TEST_DESKTOP_RECOVERY' ? { status: resumedSessionStatus(session, firstStartedAt), desktopOfflineAt: null, lastDesktopSeenAt: now } : {}),
        lastMiniProgramSeenAt: now, miniProgramOfflineAt: null,
      } });
      return { session: refreshed, requirements: {
        saveFullRecording: session.exam.saveFullRecording, saveIncidentRecording: session.exam.saveIncidentRecording, reactionEnabled: session.exam.reactionEnabled,
        requireFrontCamera: room?.requireFrontCamera ?? session.exam.requireFrontCamera,
        requireSecondCamera, loginMode: room?.loginMode ?? 'CREDENTIALS', isPublicTest: await isPublicTestExam(session.examId, tx),
      } };
    }, { signal: request.signal });
    if ('error' in result) {
      if (result.error === 'REVOKED') return revokedClientSessionResponse();
      return fail(result.error === 'EXPIRED' ? '恢复二维码已使用或过期，请在电脑端刷新' : '原考试会话不可恢复，请重新登录', result.error === 'EXPIRED' ? 410 : 409);
    }
    return ok({ sessionId: result.session.id, session: publicClientSession(result.session),
      requirements: result.requirements, miniProgramSessionToken: token.token,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof SessionWriteQueueError) return fail(error.message, error.status);
    if (error instanceof LoginFlowError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}
export const OPTIONS = options;
