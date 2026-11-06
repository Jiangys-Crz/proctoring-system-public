import { admittedLogin } from '@/lib/request-admission';
import { candidateLoginTransaction } from '@/lib/candidate-login';
import { LoginFlowError } from '@/lib/room-login-policy';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getPublicTestExam, PublicTestError, resetPublicTestCandidate } from '@/lib/public-test';
import { canCandidateLogin } from '@/lib/contest-rules';
import { revokeSupersededSession } from '@/lib/session-revocation';
import { PUBLIC_TEST_ROOMS } from '@/lib/public-test-template';
import { verifyPairSecret } from '@/lib/pairing-security';
import { createClientSessionToken, publicClientSession } from '@/lib/client-auth';
import { consumeRateLimit, UploadSecurityError, boundedUploadForm, acquireUploadSlot } from '@/lib/upload-security';
import { validateMedia } from '@/lib/media-validation';
import { fail, ok, options, RequestParseError, toErrorMessage } from '@/lib/http';

const Input = z.object({ pairCode: z.string().regex(/^\d{6}$/),
  testSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(), examCode: z.string().regex(/^\d{10}$/), name: z.string().trim().min(1).max(200), examNumber: z.string().min(1).max(200), password: z.string().min(1).max(200), deviceId: z.string().min(8).max(200) }).strict();
export async function POST(request: Request) {
  return admittedLogin(request, () => handlePost(request));
}

async function handlePost(request: Request) {
  let release: (() => void) | undefined;
  try {
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) return fail('请完成手持身份证明照片和环境视频采集后登录', 400);
    await consumeRateLimit('public-test-materials:global', 300);
    release = acquireUploadSlot();
    const materials = await boundedUploadForm(request, 30 * 1024 * 1024);
    const parsed = Input.safeParse(Object.fromEntries([...materials.entries()].filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
    if (!parsed.success) return fail('请填写完整的账号信息和配对码', 400);
    const input = parsed.data;
    await consumeRateLimit(`public-test-scan:${input.pairCode}`, 10);
    const pairing = await prisma.pairingSession.findUnique({ where: { pairCode: input.pairCode } });
    if (!pairing) return fail('配对码不存在，请填写客户端“二维码登录”页显示的 6 位配对码', 403);
    if (!['TEST_INITIAL', 'INITIAL'].includes(pairing.purpose)) return fail('该配对码用于恢复连接，请使用客户端“二维码登录”页的配对码进行首次登录', 403);
    if (pairing.claimedAt) return fail('配对码已完成登录，请先在客户端检查当前会话；重新登录时请刷新配对码', 410);
    if (pairing.expiresAt <= new Date()) return fail('配对码已过期，请在客户端刷新后填写新配对码；已拍摄的材料可以继续使用', 410);
    if (!pairing.screenOk || !pairing.desktopCameraOk) return fail('系统测试要求电脑屏幕和前置摄像头实测通过，请返回客户端完成检测后刷新配对码', 400);
    if (input.testSecret !== undefined && !verifyPairSecret('RECOVERY', input.testSecret, pairing.recoveryTokenHash)) return fail('配对凭据与客户端不匹配，请填写客户端当前显示的配对码', 403);
    await consumeRateLimit('public-test:all:minute', 300);
    await consumeRateLimit('public-test:all:day', 10_000, 86_400_000);
    const exam = await getPublicTestExam();
    const room = exam.rooms.find(item => item.name === PUBLIC_TEST_ROOMS.secondCamera);
    if (!room || !room.requireSecondCamera || !room.requireFrontCamera) throw new PublicTestError('测试环境暂不可用', 503);
    const candidate = await prisma.candidate.findFirst({ where: { examId: exam.id, examNumber: input.examNumber.trim(), password: input.password, name: input.name, rooms: { some: { roomId: room.id } } } });
    if (input.examCode !== exam.examCode || !candidate) return fail('考试编号、姓名、考号或密码不匹配，请填写领取的测试账号', 401);

    const photo = materials.get('identityPhoto'), video = materials.get('roomVideo');
    if (!photo || typeof photo === 'string' || !video || typeof video === 'string') return fail('请拍摄手持身份证明照片并录制环境视频', 400);
    if (!photo.size || photo.size > 8 * 1024 * 1024 || !video.size || video.size > 20 * 1024 * 1024) return fail('身份材料大小不符合要求，请重新采集', 413);
    // Decode the real image/video in memory, then discard. Never issue a storage grant or create a media record.
    await validateMedia(Buffer.from(await photo.arrayBuffer()), 'IDENTITY_PHOTO', photo.type, { memoryOnly: true });
    await validateMedia(Buffer.from(await video.arrayBuffer()), 'ROOM_VIDEO', video.type, { memoryOnly: true });
    const miniToken = createClientSessionToken();
    const session = await candidateLoginTransaction(async tx => {
      await tx.$queryRaw`SELECT id FROM ClientSession WHERE candidateId = ${candidate.id}
        AND status IN ('WAITING_REVIEW', 'APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE') ORDER BY id FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${candidate.id} FOR UPDATE`;
      const now = new Date();
      let current = await tx.candidate.findUniqueOrThrow({ where: { id: candidate.id } });
      if (current.status === 'FINISHED' || !canCandidateLogin(exam, current.startedAt, now, true)) {
        const binding = await tx.publicTestAccount.findUnique({ where: { candidateId: current.id } });
        if (!binding) throw new PublicTestError('本次体验已结束，请登录官网后绑定旧测试账号', 403);
        current = await resetPublicTestCandidate(tx, current);
      }
      const active = await tx.clientSession.findMany({ where: { candidateId: current.id, status: { not: 'FINISHED' } } });
      for (const previous of active) await revokeSupersededSession(tx, previous, now);
      // Claim once before establishing the direct session; no login request is created.
      const claimed = await tx.pairingSession.updateMany({ where: { id: pairing.id, purpose: pairing.purpose,
        claimedAt: null, expiresAt: { gt: now }, recoveryTokenHash: pairing.recoveryTokenHash, screenOk: true, desktopCameraOk: true,
      }, data: { claimedAt: now, recoveryTokenHash: null } });
      if (!claimed.count) throw new PublicTestError('测试二维码已失效，请先完成设备检测并刷新二维码', 410);
      await tx.candidate.update({ where: { id: candidate.id }, data: { status: current.startedAt ? 'ONLINE_NORMAL' : 'APPROVED' } });
      const created = await tx.clientSession.create({ data: { id: `test_${randomUUID()}`, examId: exam.id,
        candidateId: candidate.id, desktopDeviceId: pairing.desktopDeviceId, miniProgramDeviceId: input.deviceId,
        miniProgramTokenHash: miniToken.tokenHash, status: current.startedAt ? 'IN_EXAM' : 'APPROVED', startedAt: current.startedAt, approvedAt: now,
        lastDesktopSeenAt: now, lastMiniProgramSeenAt: now,
        peripheralsBaselineFingerprint: pairing.peripheralsFingerprint, lastPeripheralsFingerprint: pairing.peripheralsFingerprint } });
      await tx.pairingSession.update({ where: { id: pairing.id }, data: { recoverySessionId: created.id } });
      return created;
    }, { signal: request.signal });
    return ok({ sessionId: session.id, session: publicClientSession(session), miniProgramSessionToken: miniToken.token,
      requirements: { roomName: room.name, requireSecondCamera: true, requireFrontCamera: true, loginMode: 'SECOND_CAMERA_QR', isPublicTest: true },
    }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof RequestParseError) return fail('请填写完整的账号信息和配对码', 400);
    return fail(toErrorMessage(error), error instanceof PublicTestError || error instanceof UploadSecurityError || error instanceof LoginFlowError ? error.status : 500);
  } finally { release?.(); }
}
export const OPTIONS = options;
