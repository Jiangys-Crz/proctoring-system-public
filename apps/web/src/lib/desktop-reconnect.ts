import type { PairingSession } from '@prisma/client';
import { publicClientSession, verifyClientTokenForSession } from './client-auth';
import { withSessionWrite } from './session-write';
import { revokeFullyOfflineSession } from './session-revocation';
import { revokedClientSessionResponse } from './client-session-response';
import { isPublicTestExam } from './public-test';
import { effectiveEnd } from './contest-rules';
import { fail, ok } from './http';
import { bindCandidateLoginIp } from './login-ip';

/** The still-authenticated phone authorizes a new desktop, keeping its own token and exam clock. */
export async function reconnectDesktop(request: Request, input: { sessionId?: string; deviceId: string }, pairing: PairingSession) {
  if (!input.sessionId) return fail('请使用仍在监考中的第二机位扫描客户端登录二维码', 400);
  const now = new Date();
  const result = await withSessionWrite(input.sessionId, async tx => {
    const session = await tx.clientSession.findUnique({ where: { id: input.sessionId }, include: { exam: true } });
    if (!session || session.revokedAt) return { error: 'REVOKED' as const };
    if (!verifyClientTokenForSession(request, session, 'MINIPROGRAM') || session.miniProgramDeviceId !== input.deviceId) return { error: 'UNAUTHORIZED' as const };
    const room = await tx.examRoom.findFirst({ where: { examId: session.examId, candidates: { some: { candidateId: session.candidateId } } }, select: { requireSecondCamera: true, requireFrontCamera: true, loginMode: true } });
    const requireSecondCamera = room?.requireSecondCamera ?? session.exam.requireMiniProgram;
    if (await revokeFullyOfflineSession(tx, session, requireSecondCamera, now)) return { error: 'REVOKED' as const };
    if (session.status === 'FINISHED' || effectiveEnd(session.exam, session.startedAt) <= now) return { error: 'FINISHED' as const };
    if (!requireSecondCamera || !pairing.screenOk || ((room?.requireFrontCamera ?? session.exam.requireFrontCamera) && !pairing.desktopCameraOk)) return { error: 'CAPTURE' as const };
    if (session.desktopTokenHash && (session.lastDesktopSeenAt || session.createdAt).getTime() > now.getTime() - 20_000) return { error: 'ONLINE' as const };
    const claimed = await tx.pairingSession.updateMany({
      where: { id: pairing.id, purpose: 'INITIAL', recoveryTokenHash: pairing.recoveryTokenHash, pollTokenHash: pairing.pollTokenHash, claimedAt: null, expiresAt: { gt: now } },
      data: { purpose: 'DESKTOP_RECOVERY', recoverySessionId: session.id, loginRequestId: session.loginRequestId, claimedAt: now, recoveryTokenHash: null, desktopTokenIssuedAt: null },
    });
    if (!claimed.count) return { error: 'EXPIRED' as const };
    if (!await isPublicTestExam(session.examId, tx)) await bindCandidateLoginIp(tx, session.examId, session.candidateId, pairing.desktopLoginIp);
    const refreshed = await tx.clientSession.update({ where: { id: session.id }, data: {
      desktopDeviceId: pairing.desktopDeviceId, desktopTokenHash: null, desktopOfflineAt: null,
      lastMiniProgramSeenAt: now, miniProgramOfflineAt: null,
      peripheralsBaselineFingerprint: pairing.peripheralsFingerprint, lastPeripheralsFingerprint: pairing.peripheralsFingerprint,
      status: session.lockdown ? 'LOCKED' : session.startedAt ? 'IN_EXAM' : session.approvedAt ? 'APPROVED' : 'WAITING_REVIEW',
    } });
    return { session: refreshed, requirements: { saveFullRecording: session.exam.saveFullRecording, saveIncidentRecording: session.exam.saveIncidentRecording,
      requireSecondCamera, requireFrontCamera: room?.requireFrontCamera ?? session.exam.requireFrontCamera,
      loginMode: room?.loginMode ?? 'CREDENTIALS', isPublicTest: await isPublicTestExam(session.examId, tx) } };
  });
  if ('error' in result) {
    if (result.error === 'REVOKED') return revokedClientSessionResponse();
    if (result.error === 'UNAUTHORIZED') return fail('第二机位连接已失效，请扫描在线客户端的重连二维码或重新登录', 401);
    if (result.error === 'ONLINE') return fail('电脑客户端仍在线，无需重新登录；第二机位掉线请扫描左下角的重连二维码', 409);
    if (result.error === 'CAPTURE') return fail('请先完成客户端屏幕和摄像头检测后重新生成登录二维码', 409);
    return fail(result.error === 'EXPIRED' ? '客户端登录二维码已使用或过期，请重新生成' : '原考试会话已结束，请重新登录', result.error === 'EXPIRED' ? 410 : 409);
  }
  return ok({ side: 'DESKTOP', sessionId: result.session.id, session: publicClientSession(result.session), requirements: result.requirements }, { headers: { 'Cache-Control': 'no-store' } });
}
