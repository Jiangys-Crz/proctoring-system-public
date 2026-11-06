import type { Exam, PairingSession, Prisma } from '@prisma/client';
import { prisma } from './db';
import { createClientSessionToken } from './client-auth';
import { LoginFlowError, requireRoomLoginMethod, type LoginMethod } from './room-login-policy';
import { issueApprovedSessionOjTicket } from './login-approval';
import { isPublicTestExam } from './public-test';
import { candidateLoginError } from './contest-rules';
import { validatedLoginMaterials } from './upload-security';
import { getStorageSettings } from './settings';
import { assertLoginIp, bindCandidateLoginIp } from './login-ip';

export async function candidateLoginTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, options: {
  signal?: AbortSignal; deadlineAt?: number;
} = {}): Promise<T> {
  const deadlineAt = options.deadlineAt ?? Date.now() + 30_000;
  for (let attempt = 0; ; attempt++) {
    const remaining = deadlineAt - Date.now();
    const assertCurrent = () => {
      if (options.signal?.aborted || Date.now() >= deadlineAt) throw new LoginFlowError('登录请求已取消或等待超时，请重新提交', 503);
    };
    assertCurrent();
    try {
      return await prisma.$transaction(async tx => {
        assertCurrent();
        const result = await operation(tx);
        // Every mutation here is transactional. A cancellation observed before
        // this callback finishes rolls back the takeover and old revocation.
        assertCurrent();
        return result;
      }, { isolationLevel: 'ReadCommitted', maxWait: Math.min(10_000, remaining), timeout: Math.min(15_000, remaining) });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['P2024', 'P2028'].includes(String(error.code))) throw new LoginFlowError('登录服务繁忙，请稍后重试', 503);
      // Heartbeat/revocation also touch a candidate and its sessions. Retry the
      // entire rolled-back login when MySQL resolves a competing lock order.
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2034') throw error;
      if (attempt >= 2) throw new LoginFlowError('登录请求竞争繁忙，请稍后重试', 503);
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export async function createCandidateLoginRequest({ exam, pairing, candidateId, memberIdentity, materials, method, now = new Date(), signal }: {
  exam: Exam; pairing: PairingSession; candidateId: string;
  memberIdentity: { memberStudentId: string | null; memberName: string | null } | null;
  materials: { uploadTicket?: string; miniProgramDeviceId?: string; identityPhotoPath?: string; roomVideoPath?: string };
  method: LoginMethod; now?: Date; signal?: AbortSignal;
}) {
  const deadlineAt = Date.now() + 30_000;
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
  if (requireFrontCamera && !pairing.desktopCameraOk) throw new LoginFlowError('所在考室要求电脑摄像头，请在客户端重新完成摄像头实测后登录', 400);
  if (requireSecondCamera && (!materials.identityPhotoPath || !materials.roomVideoPath)) throw new LoginFlowError('所在考室要求第二机位，请提交身份照片和 3–15 秒环境视频', 400);

  const miniProgramToken = createClientSessionToken();
  const storage = requireSecondCamera ? await getStorageSettings() : undefined;
  const preparedMaterials = requireSecondCamera
    ? await validatedLoginMaterials(prisma, materials, exam.id, candidateId, pairing.id, new Date(), memberIdentity, storage) : null;
  const loginRequest = await candidateLoginTransaction(async (tx) => {
    // Match heartbeat/revocation lock order: sessions, then candidate. Recheck
    // sessions below after the candidate lock to serialize first-time logins.
    await tx.$queryRaw`SELECT id FROM ClientSession WHERE candidateId = ${candidateId}
      AND status IN ('WAITING_REVIEW', 'APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE') ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${candidateId} FOR UPDATE`;
    const current = await tx.candidate.findUnique({ where: { id: candidateId } });
    if (!current || current.examId !== exam.id) throw new LoginFlowError('考生不存在', 404);
    if (current.status === 'FINISHED') throw new LoginFlowError('该考生的考试已经结束，不能再次登录', 403);
    const currentExam = await tx.exam.findUnique({ where: { id: exam.id } });
    if (!currentExam) throw new LoginFlowError('考试不存在', 404);
    const currentRoom = await tx.examRoom.findFirst({ where: { examId: exam.id, candidates: { some: { candidateId } } } });
    requireRoomLoginMethod(currentRoom, method);
    if (currentRoom!.id !== room!.id || currentRoom!.requireFrontCamera !== requireFrontCamera
      || currentRoom!.requireSecondCamera !== requireSecondCamera || currentRoom!.loginReviewMode !== room!.loginReviewMode) {
      throw new LoginFlowError('考室设置已更新，请重新提交登录', 409);
    }
    const loginNow = new Date();
    assertLoginIp(currentExam.ipLoginRestrictionEnabled, current.loginIp, pairing.desktopLoginIp);
    const teacherReleased = Boolean(current.loginIpReleasedAt && !current.loginIp);
    const firstStartedAt = current.startedAt;
    const currentTimingError = candidateLoginError(currentExam, firstStartedAt, loginNow, false, current.lateStartAllowedAt);
    if (currentTimingError) throw new LoginFlowError(currentTimingError, 403);
    const checkedMaterials = requireSecondCamera ? await validatedLoginMaterials(tx, materials, exam.id, candidateId, pairing.id, loginNow, memberIdentity, storage, preparedMaterials?.verifiedFiles) : null;
    // Re-read after acquiring the candidate lock: a concurrent initial login
    // may have committed a session since the first session lookup.
    await tx.$queryRaw`SELECT id FROM ClientSession WHERE candidateId = ${candidateId}
      AND status IN ('WAITING_REVIEW', 'APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE') ORDER BY id FOR UPDATE`;
    const activeSessions = await tx.clientSession.findMany({
      where: {
        candidateId: candidateId,
        status: { in: ['WAITING_REVIEW', 'APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE'] }
      },
      orderBy: { createdAt: 'desc' }
    });
    // Reinstalling or logging in again cannot erase a proctor's active lock.
    const inheritedLock = activeSessions.find(session => session.lockdown);
    const claimed = await tx.pairingSession.updateMany({
      where: { id: pairing.id, purpose: 'INITIAL', pollTokenHash: pairing.pollTokenHash, claimedAt: null, expiresAt: { gt: loginNow } }, data: { claimedAt: loginNow }
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
        data: { status: 'FINISHED', revokedAt: loginNow, endedAt: loginNow, desktopTokenHash: null, miniProgramTokenHash: null, lockdown: false, lockdownReason: null }
      });
      await tx.pairingSession.updateMany({
        where: { OR: [{ recoverySessionId: { in: activeSessionIds } }, ...(activeLoginRequestIds.length ? [{ loginRequestId: { in: activeLoginRequestIds } }] : [])] },
        data: { pollTokenHash: null, recoveryTokenHash: null, expiresAt: loginNow },
      });
      if (activeLoginRequestIds.length) {
        await tx.loginRequest.updateMany({
          where: { id: { in: activeLoginRequestIds }, status: 'REQUESTING' },
          data: { status: 'REJECTED', rejectReason: teacherReleased
            ? '监考已解除一次登录 IP 限制，考生更换电脑重新登录，旧会话已注销'
            : '同一账号已重新登录，旧会话已注销，原考试计时保持不变' }
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
        reviewedAt: autoApprove ? loginNow : undefined
      },
    });
    await tx.pairingSession.update({
      where: { id: pairing.id },
      data: {
        loginRequestId: created.id,
        claimedAt: loginNow
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
        status: inheritedLock ? 'LOCKED' : autoApprove ? (firstStartedAt ? 'IN_EXAM' : 'APPROVED') : 'WAITING_REVIEW',
        lockdown: Boolean(inheritedLock),
        lockdownReason: inheritedLock?.lockdownReason,
        approvedAt: autoApprove ? loginNow : undefined,
        startedAt: autoApprove ? firstStartedAt : undefined,
        peripheralsBaselineFingerprint: pairing.peripheralsFingerprint,
        lastPeripheralsFingerprint: pairing.peripheralsFingerprint
      }
    });
    const updatedCandidate = await tx.candidate.update({
      where: { id: candidateId },
      data: { status: inheritedLock ? 'ONLINE_ABNORMAL' : autoApprove ? (firstStartedAt ? 'ONLINE_NORMAL' : 'APPROVED') : 'REQUESTING',
        ...(inheritedLock ? { abnormal: true } : {}) }
    });
    if (checkedMaterials) {
      const consumed = await tx.materialUploadGrant.updateMany({
        where: { id: checkedMaterials.grant.id, consumedAt: null, expiresAt: { gt: loginNow } },
        data: { consumedAt: loginNow, loginRequestId: created.id }
      });
      if (!consumed.count) throw new LoginFlowError('材料上传凭据已被使用，请重新提交', 409);
      const bound = await tx.mediaSegment.updateMany({
        where: { id: { in: checkedMaterials.ids }, uploadGrantId: checkedMaterials.grant.id, candidateId, sessionId: null },
        data: { sessionId: session.id }
      });
      if (bound.count !== 2) throw new LoginFlowError('材料已被其他会话使用，请重新提交', 409);
    }
    return { loginRequest: { ...created, sessionId: session.id }, candidate: updatedCandidate, exam: currentExam };
  }, { signal, deadlineAt });

  if (autoApprove) {
    void issueApprovedSessionOjTicket({
      exam: loginRequest.exam,
      candidate: loginRequest.candidate,
      sessionId: loginRequest.loginRequest.sessionId
    }).catch((error) => console.error('Failed to issue OJ login ticket after candidate login', error));
  }

  return {
    ...loginRequest.loginRequest,
    miniProgramSessionToken: miniProgramToken.token,
    requirements: {
      saveFullRecording: loginRequest.exam.saveFullRecording, saveIncidentRecording: loginRequest.exam.saveIncidentRecording,
      reactionEnabled: loginRequest.exam.reactionEnabled,
      requireFrontCamera,
      requireSecondCamera,
      loginMode: room!.loginMode, isPublicTest: false
    }
  };
}
