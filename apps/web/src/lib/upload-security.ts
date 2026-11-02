import { createHash } from 'node:crypto';
import { prisma } from './db';
import type { Prisma } from '@prisma/client';
import { LoginFlowError } from './room-login-policy';
import { storedObjectExists } from './storage';
import { clientSessionTokenFromRequest, hashClientSessionToken, verifyClientTokenForAnySide } from './client-auth';
import { randomUUID } from 'node:crypto';
import { isValidRoomVideoDuration } from '@cwnupaa/proctor-shared';
import { isPublicTestExam } from './public-test';
import { getStorageSettings, type StorageSettings } from './settings';

export const hashUploadTicket = (value: string) => createHash('sha256').update(value).digest('hex');
export class UploadSecurityError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** Database counters protect across workers. Forwarded IPs are deliberately not trusted. */
export async function consumeRateLimit(scope: string, limit: number, windowMs = 60_000) {
  const now = Date.now();
  const id = createHash('sha256').update(`${scope}:${Math.floor(now / windowMs)}`).digest('hex');
  const bucket = await prisma.requestRateBucket.upsert({ where: { id },
    create: { id, count: 1, expiresAt: new Date(now + windowMs * 2) }, update: { count: { increment: 1 } } })
    .catch(async (error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return prisma.requestRateBucket.update({ where: { id }, data: { count: { increment: 1 } } });
      throw error;
    });
  if (bucket.count > limit) throw new UploadSecurityError('操作过于频繁，请稍后再试', 429);
}

const sharedUploads = globalThis as typeof globalThis & { uploadSlots?: { active: number } };
const uploadSlots = sharedUploads.uploadSlots ??= { active: 0 };
export function acquireUploadSlot() {
  const configured = Number(process.env.UPLOAD_MAX_CONCURRENT || 4);
  const maximum = Number.isSafeInteger(configured) ? Math.max(1, Math.min(16, configured)) : 4;
  if (uploadSlots.active >= maximum) throw new UploadSecurityError('上传服务繁忙，请稍后重试', 429);
  uploadSlots.active++;
  let released = false;
  return () => { if (!released) { released = true; uploadSlots.active--; } };
}

export async function authorizeAuxiliaryUpload(request: Request) {
  const token = clientSessionTokenFromRequest(request);
  if (!token) throw new UploadSecurityError('上传需要有效客户端会话令牌', 401);
  const hash = hashClientSessionToken(token);
  const session = await prisma.clientSession.findFirst({ where: { revokedAt: null, OR: [{ desktopTokenHash: hash }, { miniProgramTokenHash: hash }] }, include: { exam: true } });
  if (!session || !verifyClientTokenForAnySide(request, session)) throw new UploadSecurityError('客户端会话令牌无效或已注销', 401);
  if (await isPublicTestExam(session.examId)) throw new UploadSecurityError('环境测试不保存录像、图片或语音', 403);
  if (session.status === 'FINISHED' || session.exam.endAt <= new Date()) throw new UploadSecurityError('客户端会话已经结束', 409);
  return session;
}

/** Admit before parsing multipart bodies; charge storage only after decoding.
 * One admitted image group can account for its images without counting twice. */
export async function admitAuxiliaryUpload(scope: string, rate: number) {
  await consumeRateLimit(`auxiliary:${scope}:${rate}`, rate);
  return (bytes: number, quota = Number(process.env.UPLOAD_SESSION_QUOTA_BYTES || 16 * 1024 * 1024 * 1024)) =>
    reserveUploadBytes(scope, bytes, quota, `aux:${randomUUID()}`);
}

export async function accountAuxiliaryUpload(scope: string, bytes: number, rate: number, quota = Number(process.env.UPLOAD_SESSION_QUOTA_BYTES || 16 * 1024 * 1024 * 1024)) {
  const account = await admitAuxiliaryUpload(scope, rate);
  await account(bytes, quota);
}

export async function reserveUploadBytes(scope: string, bytes: number, limit: number, reservationId: string) {
  if (!Number.isSafeInteger(limit) || limit < bytes) throw new UploadSecurityError('上传配额不足', 413);
  for (let attempt = 0; ; attempt++) {
    try {
      await prisma.$transaction(async tx => {
        await tx.uploadReservation.upsert({ where: { id: reservationId }, create: { id: reservationId }, update: {} });
        const claimed = await tx.uploadReservation.updateMany({ where: { id: reservationId, bytes: 0n }, data: { bytes: BigInt(bytes) } });
        if (!claimed.count) return;
        await tx.uploadBudget.upsert({ where: { scope }, create: { scope }, update: {} });
        const used = await tx.uploadBudget.updateMany({
          where: { scope, bytes: { lte: BigInt(limit - bytes) } }, data: { bytes: { increment: BigInt(bytes) } }
        });
        if (!used.count) throw new UploadSecurityError('上传配额已用完，请联系管理员', 413);
      });
      return;
    } catch (error) {
      if (attempt >= 2 || !error || typeof error !== 'object' || !('code' in error) || !['P2002', 'P2034'].includes(String(error.code))) throw error;
    }
  }
}

export async function boundedUploadForm(request: Request, limit = 81 * 1024 * 1024) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > limit) throw new UploadSecurityError('上传文件过大', 413);
  if (!request.body) throw new UploadSecurityError('缺少上传文件');
  const reader = request.body.getReader();
  let bytes = 0;
  let failure: UploadSecurityError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Pass bounded chunks straight to the multipart parser. Retaining all chunks,
  // concatenating them, and constructing another buffered Response used to keep
  // several complete copies of each 80 MB recording alive at the same time.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        failure = new UploadSecurityError('上传超时，请重试', 408);
        controller.error(failure);
        void reader.cancel('upload timeout').catch(() => {});
      }, 120_000);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (failure) return;
        if (done) { clearTimeout(timer); controller.close(); return; }
        bytes += value.byteLength;
        if (bytes > limit) {
          failure = new UploadSecurityError('上传文件过大', 413);
          controller.error(failure);
          await reader.cancel('upload size limit');
          return;
        }
        controller.enqueue(value);
      } catch (error) { if (!failure) controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); }
  });
  try {
    return await new Response(body, { headers: { 'content-type': request.headers.get('content-type') || '' } }).formData();
  } catch { throw failure || new UploadSecurityError('上传表单格式无效', 400); }
  finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function validatedLoginMaterials(tx: Prisma.TransactionClient, input: {
  uploadTicket?: string; miniProgramDeviceId?: string; identityPhotoPath?: string; roomVideoPath?: string;
}, examId: string, candidateId: string, pairingId: string, now: Date, memberIdentity: { memberStudentId: string | null; memberName: string | null } | null = null, storage?: StorageSettings) {
  if (!input.uploadTicket || !input.miniProgramDeviceId) throw new LoginFlowError('请重新上传身份照片和环境视频', 400);
  const grant = await tx.materialUploadGrant.findUnique({ where: { tokenHash: hashUploadTicket(input.uploadTicket) } });
  if (!grant || grant.consumedAt || grant.expiresAt <= now || grant.examId !== examId || grant.candidateId !== candidateId ||
    grant.pairingId !== pairingId || grant.deviceId !== input.miniProgramDeviceId ||
    grant.memberStudentId !== (memberIdentity?.memberStudentId || null) || grant.memberName !== (memberIdentity?.memberName || null)) throw new LoginFlowError('材料凭据已失效或与当前考生、队员、电脑配对不匹配', 403);
  const records = await tx.mediaSegment.findMany({ where: { uploadGrantId: grant.id, examId, candidateId, sessionId: null,
    objectPath: { in: [input.identityPhotoPath || '', input.roomVideoPath || ''] }, validatedAt: { not: null } } });
  const photo = records.find(item => item.channel === 'IDENTITY_PHOTO' && item.objectPath === input.identityPhotoPath && item.byteSize > 0n);
  const video = records.find(item => item.channel === 'ROOM_VIDEO' && item.objectPath === input.roomVideoPath && item.byteSize > 0n && isValidRoomVideoDuration(item.durationSeconds));
  if (!photo || !video) throw new LoginFlowError('必须提交本人上传的真实身份照片和 3–15 秒环境视频', 400);
  const destination = storage || await getStorageSettings(tx);
  const files = await Promise.all([photo, video].map(record => storedObjectExists(record.objectPath, record.byteSize, destination)));
  if (files.some(exists => !exists)) throw new LoginFlowError('材料文件缺失或不完整，请重新上传', 400);
  return { grant, ids: [photo.id, video.id] };
}

export async function assertReviewMaterials(tx: Prisma.TransactionClient, requestId: string, candidateId: string, examId: string, storage?: StorageSettings) {
  const room = await tx.examRoom.findFirst({ where: { examId, candidates: { some: { candidateId } } } });
  if (!room) throw new LoginFlowError('考生尚未分配考室', 403);
  if (!room.requireSecondCamera) return;
  const login = await tx.loginRequest.findUnique({ where: { id: requestId } });
  const grant = await tx.materialUploadGrant.findFirst({ where: { loginRequestId: requestId, candidateId, examId, consumedAt: { not: null } } });
  if (!login || !grant || login.miniProgramDeviceId !== grant.deviceId || login.memberStudentId !== grant.memberStudentId || login.memberName !== grant.memberName) throw new LoginFlowError('登录请求没有有效的本人材料，请重新提交', 400);
  const records = await tx.mediaSegment.findMany({ where: { uploadGrantId: grant.id, candidateId, examId, validatedAt: { not: null } } });
  const photo = records.find(item => item.channel === 'IDENTITY_PHOTO' && item.objectPath === login.identityPhotoPath && item.byteSize > 0n);
  const video = records.find(item => item.channel === 'ROOM_VIDEO' && item.objectPath === login.roomVideoPath && item.byteSize > 0n && isValidRoomVideoDuration(item.durationSeconds));
  if (!photo || !video) {
    throw new LoginFlowError('审核材料缺失、格式无效或不属于该考生', 400);
  }
  const destination = storage || await getStorageSettings(tx);
  if ((await Promise.all([photo, video].map(record => storedObjectExists(record.objectPath, record.byteSize, destination)))).some(exists => !exists)) throw new LoginFlowError('审核材料文件缺失或不完整，请重新上传', 400);
}
