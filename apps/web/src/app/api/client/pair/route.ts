import { DesktopPairRequestSchema } from '@cwnupaa/proctor-shared';
import { prisma } from '@/lib/db';
import { isPublicTestExam } from '@/lib/public-test';
import { publicClientSession, verifyClientTokenForSession, verifyClientTokenValueForSession } from '@/lib/client-auth';
import { desktopPairToken } from '@/lib/desktop-pair-token';
import { createPairSecret, verifyPairSecret } from '@/lib/pairing-security';
import { createPairingSession } from '@/lib/pairing-create';
import { consumeInitialPairingAttempt } from '@/lib/pairing-limits';
import { UploadSecurityError } from '@/lib/upload-security';
import { withSessionWrite, SessionWriteQueueError } from '@/lib/session-write';
import { revokeFullyOfflineSession } from '@/lib/session-revocation';
import { revokedClientSessionResponse } from '@/lib/client-session-response';
import { isPublishedDesktopVersion } from '@/lib/desktop-releases';
import { publicDto } from '@/lib/public-dto';
import { assertLoginIp, desktopRequestIp } from '@/lib/login-ip';
import { LoginFlowError } from '@/lib/room-login-policy';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

export async function POST(request: Request) {
  try {
    const input = await parseBody(request, DesktopPairRequestSchema, 16 * 1024);
    if (input.publicTest && input.sessionId) return fail('测试登录二维码不能用于恢复已有会话', 400);
    if (input.publicTest && (!input.screenOk || !input.desktopCameraOk)) return fail('请先完成屏幕和摄像头检测', 400);
    if (!input.sessionId) await consumeInitialPairingAttempt(input.deviceId);
    if (!input.sessionId && !await isPublishedDesktopVersion(request.headers.get('host'), input.os, input.clientVersion)) {
      return fail('请从监考后台主页下载最新版客户端，在原安装位置替换旧版本后重新登录', 426);
    }
    const poll = createPairSecret('POLL');
    const recovery = input.sessionId || input.publicTest ? createPairSecret('RECOVERY') : null;
    const qrLogin = !input.sessionId && !input.publicTest ? createPairSecret('RECOVERY') : null;
    const now = new Date();
    const data = {
      purpose: input.sessionId ? 'RECOVERY' : input.publicTest ? 'TEST_INITIAL' : 'INITIAL',
      pollTokenHash: poll.hash, recoveryTokenHash: recovery?.hash ?? qrLogin?.hash,
      recoverySessionId: input.sessionId,
      desktopDeviceId: input.deviceId, hostname: input.hostname, os: input.os,
      desktopLoginIp: desktopRequestIp(request),
      clientVersion: input.clientVersion, screenOk: input.screenOk,
      desktopCameraOk: input.desktopCameraOk, peripheralsFingerprint: input.peripheralsFingerprint,
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    };
    let pairing;
    if (input.sessionId) {
      const result = await withSessionWrite(input.sessionId, async (tx) => {
        const session = await tx.clientSession.findUnique({ where: { id: input.sessionId }, include: { exam: true } });
        if (session?.revokedAt) return { error: 'REVOKED' as const };
        if (!session || session.desktopDeviceId !== input.deviceId || !verifyClientTokenForSession(request, session, 'DESKTOP')) return { error: 'UNAUTHORIZED' as const };
        if (session.status === 'FINISHED' || session.exam.endAt <= now) return { error: 'FINISHED' as const };
        const room = await tx.examRoom.findFirst({ where: { examId: session.examId, candidates: { some: { candidateId: session.candidateId } } }, select: { requireSecondCamera: true } });
        if (await revokeFullyOfflineSession(tx, session, room?.requireSecondCamera ?? session.exam.requireMiniProgram, now)) return { error: 'REVOKED' as const };
        return { pairing: await createPairingSession(tx, { ...data,
          loginRequestId: session.loginRequestId, desktopTokenIssuedAt: now,
        }) };
      });
      if ('error' in result) {
        if (result.error === 'REVOKED') return revokedClientSessionResponse();
        return fail(result.error === 'FINISHED' ? '考试会话已经结束' : '桌面客户端会话令牌无效或已过期', result.error === 'FINISHED' ? 409 : 401);
      }
      pairing = result.pairing;
    } else {
      // Device IDs are labels, never proof of ownership of an existing session.
      pairing = await createPairingSession(prisma, data);
    }
    return ok({ pairCode: pairing.pairCode, purpose: pairing.purpose,
      expiresAt: pairing.expiresAt, serverNow: now, pollToken: poll.secret,
      ...(qrLogin ? { qrLoginSecret: qrLogin.secret } : {}),
      ...(recovery ? input.publicTest ? { testSecret: recovery.secret } : { recoverySecret: recovery.secret } : {}),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof UploadSecurityError) return fail(error.message, error.status);
    if (error instanceof SessionWriteQueueError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const deviceId = searchParams.get('deviceId');
    const pairCode = searchParams.get('pairCode');
    if (!deviceId || !pairCode) return fail('缺少 deviceId 或 pairCode', 400);
    const current = await prisma.pairingSession.findUnique({
      where: { pairCode }, include: { loginRequest: { include: {
        candidate: true, exam: true, clientSessions: { orderBy: { createdAt: 'desc' }, take: 1 },
      } } },
    });
    if (!current || current.desktopDeviceId !== deviceId) return fail('配对不存在', 404);
    if (!verifyPairSecret('POLL', request.headers.get('x-proctor-pair-poll-token'), current.pollTokenHash)) return fail('桌面配对查询凭证无效，请重新生成二维码', 401);
    if (!current.loginRequest && !current.claimedAt && current.expiresAt <= new Date()) return fail('配对二维码已过期', 410);
    const directSession = current.recoverySessionId && ['RECOVERY', 'DESKTOP_RECOVERY', 'TEST_DESKTOP_RECOVERY', 'TEST_INITIAL', 'INITIAL'].includes(current.purpose)
      ? await prisma.clientSession.findUnique({ where: { id: current.recoverySessionId }, include: { exam: true, candidate: true } })
      : null;
    const session = directSession || current.loginRequest?.clientSessions[0] || null;
    if (session?.revokedAt) return fail('原配对会话已注销，请重新登录', 410);
    const testContext = directSession && await isPublicTestExam(directSession.examId) ? directSession : null;
    const context = current.loginRequest || testContext;
    const room = context ? await prisma.examRoom.findFirst({
      where: { examId: context.examId, candidates: { some: { candidateId: context.candidateId } } },
      select: { name: true, requireFrontCamera: true, requireSecondCamera: true, loginMode: true },
    }) : null;
    let desktopSessionToken: string | null = null;
    let safeSession = publicDto(publicClientSession(session));
    if (session && (current.purpose === 'INITIAL' || (['DESKTOP_RECOVERY', 'TEST_DESKTOP_RECOVERY', 'TEST_INITIAL'].includes(current.purpose) && current.claimedAt))) {
      const publicTest = await isPublicTestExam(session.examId);
      const incomingIp = desktopRequestIp(request);
      if (!publicTest) {
        const [ipExam, ipCandidate] = await Promise.all([
          prisma.exam.findUnique({ where: { id: session.examId }, select: { ipLoginRestrictionEnabled: true } }),
          prisma.candidate.findUnique({ where: { id: session.candidateId }, select: { loginIp: true } })
        ]);
        if (!ipExam || !ipCandidate) return fail('考试或考生不存在', 404);
        assertLoginIp(ipExam.ipLoginRestrictionEnabled, ipCandidate.loginIp, incomingIp);
      }
      const token = desktopPairToken(current.id, session.id, request.headers.get('x-proctor-pair-poll-token')!);
      // Waiting-review clients poll every 2.5 seconds as well as heartbeating.
      // A recently seen, correctly bound token needs neither reissuing nor
      // another write lock. Expired/rebound sessions still take the locked path.
      const alreadyLive = current.desktopTokenIssuedAt && session.status !== 'FINISHED'
        && session.desktopDeviceId === deviceId && session.lastDesktopSeenAt
        && session.lastDesktopSeenAt.getTime() > Date.now() - 5_000
        && verifyClientTokenValueForSession(token.token, session, 'DESKTOP');
      const issued = alreadyLive ? session : await withSessionWrite(session.id, async (tx) => {
        const latest = await tx.clientSession.findUnique({ where: { id: session.id } });
        if (!latest || latest.status === 'FINISHED' || latest.revokedAt || latest.desktopDeviceId !== deviceId) return null;
        if (await revokeFullyOfflineSession(tx, latest, room?.requireSecondCamera ?? context?.exam.requireMiniProgram ?? false)) return null;
        const latestPair = await tx.pairingSession.findUnique({ where: { id: current.id } });
        if (!latestPair || latestPair.pollTokenHash !== current.pollTokenHash || latestPair.purpose !== current.purpose) return null;
        if (latestPair.desktopTokenIssuedAt) {
          // A stale pairing cannot replace a token installed by a later login.
          if (!verifyClientTokenValueForSession(token.token, latest, 'DESKTOP')) return null;
          return tx.clientSession.update({ where: { id: session.id }, data: { lastDesktopSeenAt: new Date(), desktopOfflineAt: null } });
        }
        const claimed = await tx.pairingSession.updateMany({
          where: { id: current.id, purpose: current.purpose, desktopTokenIssuedAt: null, pollTokenHash: current.pollTokenHash },
          data: { desktopTokenIssuedAt: new Date() },
        });
        if (!claimed.count) return null;
        return tx.clientSession.update({ where: { id: session.id }, data: { desktopTokenHash: token.tokenHash, lastDesktopSeenAt: new Date(), desktopOfflineAt: null } });
      });
      if (issued) {
        if (!verifyClientTokenForSession(request, issued, 'DESKTOP')) desktopSessionToken = token.token;
        safeSession = publicDto(publicClientSession(issued));
      }
    }
    return ok({ pairCode: current.pairCode, serverNow: new Date(), claimedAt: current.claimedAt, desktopSessionToken,
      testLogin: testContext && current.claimedAt ? { status: 'APPROVED', candidate: publicDto(testContext.candidate), exam: publicDto(testContext.exam),
        requirements: { roomName: room?.name, requireFrontCamera: true, requireSecondCamera: true, loginMode: 'SECOND_CAMERA_QR', isPublicTest: true }, session: safeSession } : null,
      loginRequest: current.loginRequest && !(current.purpose === 'TEST_DESKTOP_RECOVERY' && !current.claimedAt) ? {
        id: current.loginRequest.id, status: current.loginRequest.status, rejectReason: current.loginRequest.rejectReason,
        candidate: publicDto(current.loginRequest.candidate), exam: publicDto(current.loginRequest.exam),
        requirements: room ? { roomName: room.name, requireFrontCamera: room.requireFrontCamera,
          requireSecondCamera: room.requireSecondCamera, loginMode: room.loginMode, isPublicTest: await isPublicTestExam(current.loginRequest.examId), saveFullRecording: current.loginRequest.exam.saveFullRecording, saveIncidentRecording: current.loginRequest.exam.saveIncidentRecording } : {
          roomName: null, requireFrontCamera: current.loginRequest.exam.requireFrontCamera,
          saveFullRecording: current.loginRequest.exam.saveFullRecording, saveIncidentRecording: current.loginRequest.exam.saveIncidentRecording,
          requireSecondCamera: current.loginRequest.exam.requireMiniProgram, loginMode: 'CREDENTIALS' as const,
        }, session: safeSession || null,
      } : null,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof SessionWriteQueueError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), error instanceof LoginFlowError ? error.status : 500);
  }
}

export const OPTIONS = options;
