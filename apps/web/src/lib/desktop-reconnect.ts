import { resumedSessionStatus } from './session-resume';
import type { PairingSession } from '@prisma/client';
import { publicClientSession, verifyClientTokenForSession } from './client-auth';
import { withSessionWrite } from './session-write';
import { revokedClientSessionResponse } from './client-session-response';
import { isPublicTestExam } from './public-test';
import { effectiveEnd } from './contest-rules';
import { fail, ok } from './http';
import { bindCandidateLoginIp } from './login-ip';
import { retireDesktopCredential } from './retired-desktop-credential';

/** The still-authenticated phone authorizes a new desktop, keeping its own token and exam clock. */
export async function reconnectDesktop(request: Request, input: { sessionId?: string; deviceId: string }, pairing: PairingSession) {
  if (!input.sessionId) return fail('请使用仍在监考中的第二机位扫描客户端登录二维码', 400);
  const result = await withSessionWrite(input.sessionId, async tx => {
    const session = await tx.clientSession.findUnique({ where: { id: input.sessionId }, include: { exam: true, candidate: { select: { startedAt: true, status: true } } } });
    if (!session || session.revokedAt) return { error: 'REVOKED' as const };
    if (!verifyClientTokenForSession(request, session, 'MINIPROGRAM') || session.miniProgramDeviceId !== input.deviceId) return { error: 'UNAUTHORIZED' as const };
    const room = await tx.examRoom.findFirst({ where: { examId: session.examId, candidates: { some: { candidateId: session.candidateId } } }, select: { requireSecondCamera: true, requireFrontCamera: true, loginMode: true } });
    const now = new Date();
    const firstStartedAt = session.candidate.startedAt || session.startedAt;
    const requireSecondCamera = room?.requireSecondCamera ?? session.exam.requireMiniProgram;
    if (session.status === 'FINISHED' || session.candidate.status === 'FINISHED' || effectiveEnd(session.exam, firstStartedAt) <= now) return { error: 'FINISHED' as const };
    if (!requireSecondCamera || !pairing.screenOk || ((room?.requireFrontCamera ?? session.exam.requireFrontCamera) && !pairing.desktopCameraOk)) return { error: 'CAPTURE' as const };
    const currentPair = await tx.pairingSession.findUnique({ where: { id: pairing.id } });
    if (!currentPair || currentPair.expiresAt <= now || !currentPair.pollTokenHash || !currentPair.recoveryTokenHash
      || currentPair.pollTokenHash !== pairing.pollTokenHash || currentPair.recoveryTokenHash !== pairing.recoveryTokenHash) return { error: 'EXPIRED' as const };
    const publicTest = await isPublicTestExam(session.examId, tx);
    const requirements = { saveFullRecording: session.exam.saveFullRecording, saveIncidentRecording: session.exam.saveIncidentRecording,
      reactionEnabled: !publicTest && session.exam.reactionEnabled,
      requireSecondCamera, requireFrontCamera: room?.requireFrontCamera ?? session.exam.requireFrontCamera,
      loginMode: room?.loginMode ?? 'CREDENTIALS', isPublicTest: publicTest };
    if (currentPair.claimedAt) {
      // A retry after a lost response confirms the existing binding only. It
      // cannot retire another credential or rebind a later desktop recovery.
      if (currentPair.purpose !== 'DESKTOP_RECOVERY' || currentPair.recoverySessionId !== session.id
        || currentPair.desktopDeviceId !== session.desktopDeviceId) return { error: 'EXPIRED' as const };
      const { exam: _exam, candidate: _candidate, ...sessionRow } = session;
      return { session: sessionRow, requirements };
    }
    if (currentPair.purpose !== 'INITIAL') return { error: 'EXPIRED' as const };
    if (session.desktopTokenHash && (session.lastDesktopSeenAt || session.createdAt).getTime() > now.getTime() - 20_000) return { error: 'ONLINE' as const };
    const claimed = await tx.pairingSession.updateMany({
      where: { id: pairing.id, purpose: 'INITIAL', recoveryTokenHash: pairing.recoveryTokenHash, pollTokenHash: pairing.pollTokenHash, claimedAt: null, expiresAt: { gt: now } },
      data: { purpose: 'DESKTOP_RECOVERY', recoverySessionId: session.id, loginRequestId: session.loginRequestId, claimedAt: now, desktopTokenIssuedAt: null },
    });
    if (!claimed.count) return { error: 'EXPIRED' as const };
    if (!publicTest) await bindCandidateLoginIp(tx, session.examId, session.candidateId, pairing.desktopLoginIp);
    // Retire prior recovery proofs even when a later desktop uses the same
    // device ID. No older retry/poll may undo this binding or claim success.
    await tx.pairingSession.updateMany({ where: { id: { not: pairing.id }, recoverySessionId: session.id,
      purpose: { in: ['DESKTOP_RECOVERY', 'TEST_DESKTOP_RECOVERY'] } },
      data: { pollTokenHash: null, recoveryTokenHash: null, expiresAt: now } });
    await retireDesktopCredential(tx, session);
    const refreshed = await tx.clientSession.update({ where: { id: session.id }, data: {
      desktopDeviceId: pairing.desktopDeviceId, desktopTokenHash: null, desktopOfflineAt: null,
      lastMiniProgramSeenAt: now, miniProgramOfflineAt: null,
      peripheralsBaselineFingerprint: pairing.peripheralsFingerprint, lastPeripheralsFingerprint: pairing.peripheralsFingerprint,
      status: resumedSessionStatus(session, firstStartedAt),
      startedAt: firstStartedAt,
    } });
    return { session: refreshed, requirements };
  }, { signal: request.signal });
  if ('error' in result) {
    if (result.error === 'REVOKED') return revokedClientSessionResponse();
    if (result.error === 'UNAUTHORIZED') return fail('第二机位连接已失效，请扫描在线客户端的重连二维码或重新登录', 401);
    if (result.error === 'ONLINE') return fail('电脑客户端仍在线，无需重新登录；第二机位掉线请扫描左下角的重连二维码', 409);
    if (result.error === 'CAPTURE') return fail('请先完成客户端屏幕和摄像头检测后重新生成登录二维码', 409);
    return fail(result.error === 'EXPIRED' ? '客户端登录二维码已使用或过期，请重新生成' : '原考试会话已结束，请重新登录', result.error === 'EXPIRED' ? 410 : 409);
  }
  return ok({ side: 'DESKTOP', sessionId: result.session.id, session: publicClientSession(result.session), requirements: result.requirements }, { headers: { 'Cache-Control': 'no-store' } });
}
