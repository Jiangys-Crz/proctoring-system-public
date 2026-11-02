import { ClientReconnectSchema } from '@cwnupaa/proctor-shared';
import { LoginFlowError } from '@/lib/room-login-policy';
import { prisma } from '@/lib/db';
import { isPublicTestExam } from '@/lib/public-test';
import { createClientSessionToken, publicClientSession } from '@/lib/client-auth';
import { verifyPairSecret } from '@/lib/pairing-security';
import { withSessionWrite, SessionWriteQueueError } from '@/lib/session-write';
import { revokeFullyOfflineSession } from '@/lib/session-revocation';
import { revokedClientSessionResponse } from '@/lib/client-session-response';
import { reconnectDesktop } from '@/lib/desktop-reconnect';
import { effectiveEnd } from '@/lib/contest-rules';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

export async function POST(request: Request) {
  try {
    const input = await parseBody(request, ClientReconnectSchema);
    const pairing = await prisma.pairingSession.findUnique({ where: { pairCode: input.pairCode } });
    if (input.side === 'DESKTOP') {
      if (!pairing || pairing.purpose !== 'INITIAL' || !pairing.pollTokenHash || !verifyPairSecret('RECOVERY', input.recoverySecret, pairing.recoveryTokenHash)) return fail('请扫描客户端新生成的完整登录二维码', 403);
      return await reconnectDesktop(request, input, pairing);
    }
    if (!pairing || !['RECOVERY', 'TEST_DESKTOP_RECOVERY'].includes(pairing.purpose) || !pairing.recoverySessionId
      || !verifyPairSecret('RECOVERY', input.recoverySecret, pairing.recoveryTokenHash)) return fail('恢复二维码无效，请在已登录的电脑端重新生成', 403);
    if (pairing.purpose === 'TEST_DESKTOP_RECOVERY' && !await isPublicTestExam((await prisma.clientSession.findUnique({ where: { id: pairing.recoverySessionId } }))?.examId || '')) return fail('恢复二维码无效', 403);
    if (input.sessionId && input.sessionId !== pairing.recoverySessionId) return fail('恢复二维码不属于该考试会话', 403);
    const token = createClientSessionToken();
    const now = new Date();
    const result = await withSessionWrite(pairing.recoverySessionId, async (tx) => {
      const session = await tx.clientSession.findUnique({ where: { id: pairing.recoverySessionId! }, include: { exam: true } });
      if (!session || session.revokedAt) return { error: 'REVOKED' as const };
      if (session.status === 'FINISHED' || effectiveEnd(session.exam, session.startedAt) <= now) return { error: 'FINISHED' as const };
      if (session.desktopDeviceId !== pairing.desktopDeviceId) return { error: 'INVALID' as const };
      const room = await tx.examRoom.findFirst({ where: { examId: session.examId, candidates: { some: { candidateId: session.candidateId } } }, select: { requireFrontCamera: true, requireSecondCamera: true, loginMode: true } });
      const requireSecondCamera = room?.requireSecondCamera ?? session.exam.requireMiniProgram;
      if (await revokeFullyOfflineSession(tx, session, requireSecondCamera, now)) return { error: 'REVOKED' as const };
      const claimed = await tx.pairingSession.updateMany({
        where: { id: pairing.id, purpose: pairing.purpose, recoverySessionId: session.id,
          recoveryTokenHash: pairing.recoveryTokenHash, claimedAt: null, expiresAt: { gt: now } },
        data: { claimedAt: now, recoveryTokenHash: null },
      });
      if (!claimed.count) return { error: 'EXPIRED' as const };
      const refreshed = await tx.clientSession.update({ where: { id: session.id }, data: {
        miniProgramDeviceId: input.deviceId, miniProgramTokenHash: token.tokenHash,
        ...(pairing.purpose === 'TEST_DESKTOP_RECOVERY' ? { status: session.candidateId && session.startedAt ? 'IN_EXAM' as const : 'APPROVED' as const, desktopOfflineAt: null, lastDesktopSeenAt: now } : {}),
        lastMiniProgramSeenAt: now, miniProgramOfflineAt: null,
      } });
      return { session: refreshed, requirements: {
        saveFullRecording: session.exam.saveFullRecording, saveIncidentRecording: session.exam.saveIncidentRecording,
        requireFrontCamera: room?.requireFrontCamera ?? session.exam.requireFrontCamera,
        requireSecondCamera, loginMode: room?.loginMode ?? 'CREDENTIALS', isPublicTest: await isPublicTestExam(session.examId, tx),
      } };
    });
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
