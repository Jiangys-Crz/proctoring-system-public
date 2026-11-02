import type { Exam, PairingSession, Prisma } from '@prisma/client';
import { prisma } from './db';
import { createClientSessionToken } from './client-auth';
import { LoginFlowError, requireRoomLoginMethod, type LoginMethod } from './room-login-policy';
import { issueApprovedSessionOjTicket } from './login-approval';
import { isPublicTestExam } from './public-test';
import { candidateLoginError } from './contest-rules';
import { allSessionsFullyOfflineForRelogin } from './client-session-policy';
import { validatedLoginMaterials } from './upload-security';
import { getStorageSettings } from './settings';
import { assertLoginIp, bindCandidateLoginIp } from './login-ip';

async function loginTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 15_000 });
    } catch (error) {
      // Heartbeat/revocation also touch a candidate and its sessions. Retry the
      // entire rolled-back login when MySQL resolves a competing lock order.
      if (attempt >= 2 || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2034') throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export async function createCandidateLoginRequest({ exam, pairing, candidateId, memberIdentity, materials, method, now = new Date() }: {
  exam: Exam; pairing: PairingSession; candidateId: string;
  memberIdentity: { memberStudentId: string | null; memberName: string | null } | null;
  materials: { uploadTicket?: string; miniProgramDeviceId?: string; identityPhotoPath?: string; roomVideoPath?: string };
  method: LoginMethod; now?: Date;
}) {
  if (await isPublicTestExam(exam.id)) throw new LoginFlowError('请在浏览器填写测试账号，通过扫码或配对码登录', 403);
  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate || candidate.examId !== exam.id) throw new LoginFlowError('考生不存在', 404);
  if (candidate.status === 'FINISHED') throw new LoginFlowError('该考生的考试已经结束，不能再次登录', 403);
  const timingError = candidateLoginError(exam, candidate.startedAt, now, false, candidate.lateStartAllowedAt);
  if (timingError) throw new LoginFlowError(timingError, 403);
  if (pairing.expiresAt < now || pairing.claimedAt) throw new LoginFlowError('登录配对已使用或过期，请返回客户端重新登录');
  if (pairing.purpose !== 'INITIAL' || !pairing.pollTokenHash) throw new LoginFlowError('请使用电脑端新生成的登录二维码，恢复二维码不能用于首次登录', 403);
  if (!pairing.screenOk) throw new LoginFlowError('电脑端屏幕采集未通过，请先完成屏幕检测');
  const room = await prisma.examRoom.findFirst({ where: { examId: exam.id, candidates: { some: { candidateId: candidateId } } } });
  requireRoomLoginMethod(room, method);
  const requireFrontCamera = room?.requireFrontCamera ?? exam.requireFrontCamera;
  const requireSecondCamera = room?.requireSecondCamera ?? exam.requireMiniProgram;
  const autoApprove = room!.loginReviewMode === 'AUTO';
  if (requireSecondCamera && (!materials.identityPhotoPath || !materials.roomVideoPath)) throw new LoginFlowError('所在考室要求第二机位，请提交身份照片和 3–15 秒环境视频', 400);

  const miniProgramToken = createClientSessionToken();
  const storage = requireSecondCamera ? await getStorageSettings() : undefined;
  const loginRequest = await loginTransaction(async (tx) => {
    // Lock only this candidate. Serializable range reads on active sessions can
    // block unrelated candidates during a simultaneous login burst.
    await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${candidateId} FOR UPDATE`;
    const current = await tx.candidate.findUnique({ where: { id: candidateId } });
    if (!current || current.examId !== exam.id) throw new LoginFlowError('考生不存在', 404);
    if (current.status === 'FINISHED') throw new LoginFlowError('该考生的考试已经结束，不能再次登录', 403);
    const currentIpPolicy = await tx.exam.findUnique({ where: { id: exam.id }, select: { ipLoginRestrictionEnabled: true } });
    assertLoginIp(currentIpPolicy?.ipLoginRestrictionEnabled !== false, current.loginIp, pairing.desktopLoginIp);
    const teacherReleased = Boolean(current.loginIpReleasedAt && !current.loginIp);
    const firstStartedAt = current.startedAt;
    const currentTimingError = candidateLoginError(exam, firstStartedAt, new Date(), false, current.lateStartAllowedAt);
    if (currentTimingError) throw new LoginFlowError(currentTimingError, 403);
    const checkedMaterials = requireSecondCamera ? await validatedLoginMaterials(tx, materials, exam.id, candidateId, pairing.id, now, memberIdentity, storage) : null;
    // A heartbeat can refresh its session without rewriting Candidate. Lock
    // the old sessions before checking their clocks, so a concurrent recovery
    // cannot be revoked using a snapshot read before that heartbeat commits.
    await tx.$queryRaw`SELECT id FROM ClientSession WHERE candidateId = ${candidateId}
      AND status IN ('WAITING_REVIEW', 'APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE') ORDER BY id FOR UPDATE`;
    const activeSessions = await tx.clientSession.findMany({
      where: {
        candidateId: candidateId,
        status: { in: ['WAITING_REVIEW', 'APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE'] }
      },
      orderBy: { createdAt: 'desc' }
    });
    if (activeSessions.length && !teacherReleased && !allSessionsFullyOfflineForRelogin(activeSessions, now, requireSecondCamera)) {
      throw new LoginFlowError('该考生已有未结束的登录或考试会话；所需客户端均离线满 2 分钟后自动注销并可重新登录，单端掉线请通过原电脑端恢复二维码重连', 409);
    }
    const claimed = await tx.pairingSession.updateMany({
      where: { id: pairing.id, purpose: 'INITIAL', pollTokenHash: pairing.pollTokenHash, claimedAt: null, expiresAt: { gt: now } }, data: { claimedAt: now }
    });
    if (!claimed.count) throw new LoginFlowError('登录配对已使用或过期，请返回客户端重新登录', 409);
    await bindCandidateLoginIp(tx, exam.id, candidateId, pairing.desktopLoginIp);
    if (activeSessions.length) {
      const activeSessionIds = activeSessions.map((session) => session.id);
      const activeLoginRequestIds = activeSessions
        .map((session) => session.loginRequestId)
        .filter((id): id is string => Boolean(id));
      await tx.clientSession.updateMany({
        where: { id: { in: activeSessionIds }, status: { in: ['WAITING_REVIEW', 'APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE'] } },
        data: { status: 'FINISHED', revokedAt: now, endedAt: now, desktopTokenHash: null, miniProgramTokenHash: null, lockdown: false, lockdownReason: null }
      });
      await tx.pairingSession.updateMany({
        where: { OR: [{ recoverySessionId: { in: activeSessionIds } }, ...(activeLoginRequestIds.length ? [{ loginRequestId: { in: activeLoginRequestIds } }] : [])] },
        data: { pollTokenHash: null, recoveryTokenHash: null, expiresAt: now },
      });
      if (activeLoginRequestIds.length) {
        await tx.loginRequest.updateMany({
          where: { id: { in: activeLoginRequestIds }, status: 'REQUESTING' },
          data: { status: 'REJECTED', rejectReason: teacherReleased
            ? '监考已解除一次登录 IP 限制，考生更换电脑重新登录，旧会话已注销'
            : '客户端所需端均离线满 2 分钟，旧会话已注销，考生已重新发起登录请求' }
        });
      }
    }
    const created = await tx.loginRequest.create({
      data: {
        examId: exam.id,
        candidateId: candidateId,
        memberStudentId: memberIdentity?.memberStudentId,
        memberName: memberIdentity?.memberName,
        identityPhotoPath: materials.identityPhotoPath,
        roomVideoPath: materials.roomVideoPath,
        miniProgramDeviceId: materials.miniProgramDeviceId,
        status: autoApprove ? 'APPROVED' : 'REQUESTING',
        reviewedAt: autoApprove ? now : undefined
      },
    });
    await tx.pairingSession.update({
      where: { id: pairing.id },
      data: {
        loginRequestId: created.id,
        claimedAt: now
      }
    });
    const session = await tx.clientSession.create({
      data: {
        examId: exam.id,
        candidateId: candidateId,
        memberStudentId: memberIdentity?.memberStudentId,
        memberName: memberIdentity?.memberName,
        loginRequestId: created.id,
        desktopDeviceId: pairing.desktopDeviceId,
        miniProgramDeviceId: materials.miniProgramDeviceId,
        miniProgramTokenHash: miniProgramToken.tokenHash,
        status: autoApprove ? (firstStartedAt ? 'IN_EXAM' : 'APPROVED') : 'WAITING_REVIEW',
        approvedAt: autoApprove ? now : undefined,
        startedAt: autoApprove ? firstStartedAt : undefined,
        peripheralsBaselineFingerprint: pairing.peripheralsFingerprint,
        lastPeripheralsFingerprint: pairing.peripheralsFingerprint
      }
    });
    const updatedCandidate = await tx.candidate.update({
      where: { id: candidateId },
      data: { status: autoApprove ? (firstStartedAt ? 'ONLINE_NORMAL' : 'APPROVED') : 'REQUESTING' }
    });
    if (checkedMaterials) {
      const consumed = await tx.materialUploadGrant.updateMany({
        where: { id: checkedMaterials.grant.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now, loginRequestId: created.id }
      });
      if (!consumed.count) throw new LoginFlowError('材料上传凭据已被使用，请重新提交', 409);
      const bound = await tx.mediaSegment.updateMany({
        where: { id: { in: checkedMaterials.ids }, uploadGrantId: checkedMaterials.grant.id, candidateId, sessionId: null },
        data: { sessionId: session.id }
      });
      if (bound.count !== 2) throw new LoginFlowError('材料已被其他会话使用，请重新提交', 409);
    }
    return { loginRequest: { ...created, sessionId: session.id }, candidate: updatedCandidate };
  });

  if (autoApprove) {
    void issueApprovedSessionOjTicket({
      exam,
      candidate: loginRequest.candidate,
      sessionId: loginRequest.loginRequest.sessionId
    }).catch((error) => console.error('Failed to issue OJ login ticket after candidate login', error));
  }

  return {
    ...loginRequest.loginRequest,
    miniProgramSessionToken: miniProgramToken.token,
    requirements: {
      saveFullRecording: exam.saveFullRecording, saveIncidentRecording: exam.saveIncidentRecording,
      requireFrontCamera,
      requireSecondCamera,
      loginMode: room!.loginMode, isPublicTest: false
    }
  };
}
