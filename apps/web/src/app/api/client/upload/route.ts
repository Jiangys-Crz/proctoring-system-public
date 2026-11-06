import { z } from 'zod';
import { MediaChannelSchema } from '@cwnupaa/proctor-shared';
import { prisma } from '@/lib/db';
import { clientSessionTokenFromRequest, hashClientSessionToken, verifyClientTokenForSession, type ClientSide } from '@/lib/client-auth';
import { storeBuffer, deleteStoredObject } from '@/lib/storage';
import { options, fail, ok, toErrorMessage } from '@/lib/http';
import { mediaUploadIdentity } from '@/lib/media-upload-policy';
import { boundedUploadForm, hashUploadTicket, consumeRateLimit, reserveUploadBytes, acquireUploadSlot, UploadSecurityError } from '@/lib/upload-security';
import { validateMedia } from '@/lib/media-validation';
import { isPublicTestExam } from '@/lib/public-test';
import { objectHash, queueFileDeletion, deletionStorage, mediaHasReferences } from '@/lib/file-deletion';
import { getStorageSettings } from '@/lib/settings';
import { isIncidentRecording } from '@/lib/recording-policy';
import { acquireMaterialUploadSlot } from '@/lib/upload-admission';
import { withMediaSegmentWrite } from '@/lib/media-segment-write';
import type { MaterialUploadGrant, Prisma } from '@prisma/client';
import { pinReactionSegments } from '@/lib/reaction-events';
import { reactionStoredBytes } from '@/lib/reaction-storage-budget';

const UploadMetaSchema = z.object({
  examId: z.string().optional(),
  candidateId: z.string().optional(),
  sessionId: z.string().optional(),
  channel: MediaChannelSchema,
  uploadId: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  endedAt: z.iso.datetime({ offset: true }).optional(),
  evidenceOnly: z.enum(['true', 'false']).optional(),
  clockOffsetMs: z.coerce.number().finite().min(-86400000).max(86400000).optional(),
  clockUncertaintyMs: z.coerce.number().finite().min(0).max(60000).optional()
});

const MB = 1024 * 1024;
const FINISHED_UPLOAD_GRACE_MS = 30 * 60 * 1000;
const channelRules: Record<string, { maxBytes: number; mimePrefixes: string[] }> = {
  IDENTITY_PHOTO: { maxBytes: 10 * MB, mimePrefixes: ['image/'] },
  ROOM_VIDEO: { maxBytes: 80 * MB, mimePrefixes: ['video/'] },
  DESKTOP_SCREEN: { maxBytes: 80 * MB, mimePrefixes: ['video/'] },
  DESKTOP_CAMERA: { maxBytes: 80 * MB, mimePrefixes: ['video/'] },
  MOBILE_CAMERA: { maxBytes: 80 * MB, mimePrefixes: ['video/'] },
  EVIDENCE_CLIP: { maxBytes: 80 * MB, mimePrefixes: ['video/', 'image/'] }
};

function sideForChannel(channel: string): ClientSide {
  return channel === 'MOBILE_CAMERA' ? 'MINIPROGRAM' : 'DESKTOP';
}

function validateUploadFile(file: File, channel: string) {
  const rule = channelRules[channel];
  if (!rule) return '上传通道不正确';
  if (!file.size) return '上传文件为空';
  if (file.size > rule.maxBytes) return '上传文件过大';
  if (file.type && !rule.mimePrefixes.some((prefix) => file.type.startsWith(prefix))) {
    return '上传文件类型不符合通道要求';
  }
  return '';
}

async function uploadGrantIsActive(grant: MaterialUploadGrant, client: Pick<Prisma.TransactionClient, 'materialUploadGrant' | 'pairingSession'> = prisma) {
  const current = await client.materialUploadGrant.findUnique({ where: { id: grant.id } });
  const now = new Date();
  if (!current || current.consumedAt || current.expiresAt <= now || current.tokenHash !== grant.tokenHash
    || current.examId !== grant.examId || current.candidateId !== grant.candidateId || current.pairingId !== grant.pairingId) return false;
  const pair = await client.pairingSession.findUnique({ where: { id: current.pairingId } });
  return Boolean(pair && !pair.claimedAt && pair.expiresAt > now && pair.purpose === 'INITIAL');
}

export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    const uploadTicket = request.headers.get('x-proctor-upload-ticket') || '';
    const sessionToken = clientSessionTokenFromRequest(request);
    if (!uploadTicket && !sessionToken) return fail('上传必须提供登录材料凭据或客户端会话令牌', 401);
    const grant = uploadTicket ? await prisma.materialUploadGrant.findUnique({ where: { tokenHash: hashUploadTicket(uploadTicket) } }) : null;
    let authorizedSession = null;
    if (uploadTicket) {
      if (!grant || grant.consumedAt || grant.expiresAt <= new Date()) return fail('材料上传凭据已失效', 401);
      const pair = await prisma.pairingSession.findUnique({ where: { id: grant.pairingId } });
      if (!pair || pair.claimedAt || pair.expiresAt <= new Date() || pair.purpose !== 'INITIAL') return fail('电脑配对已失效', 401);
    } else {
      const hash = hashClientSessionToken(sessionToken);
      authorizedSession = await prisma.clientSession.findFirst({ where: { OR: [{ desktopTokenHash: hash }, { miniProgramTokenHash: hash }], revokedAt: null } });
      if (!authorizedSession) return fail('客户端会话令牌无效或已注销', 401);
    }
    if (await isPublicTestExam(grant?.examId || authorizedSession!.examId)) return fail('环境测试不上传或保存录像', 403);
    release = grant ? await acquireMaterialUploadSlot(request.signal) : acquireUploadSlot();
    if (request.signal.aborted) throw new UploadSecurityError('上传已取消，请重试', 408);
    // Capacity rejection/queue cancellation must not exhaust a candidate's
    // attempts before either their identity photo or environment video is read.
    if (grant) await consumeRateLimit(`upload-material:${grant.pairingId}:${grant.candidateId}`, 8);
    else await consumeRateLimit(`upload-session:${authorizedSession!.id}`, 36);
    await consumeRateLimit(grant ? 'uploads:materials:global' : 'uploads:global', grant ? 300 : 1200);
    const form = await boundedUploadForm(request);
    const file = form.get('file');
    if (!(file instanceof File)) return fail('缺少上传文件', 400);
    const meta = UploadMetaSchema.parse({
      examId: form.get('examId') || undefined,
      candidateId: form.get('candidateId') || undefined,
      sessionId: form.get('sessionId') || undefined,
      channel: form.get('channel'),
      startedAt: form.get('startedAt') || undefined,
      endedAt: form.get('endedAt') || undefined,
      uploadId: form.get('uploadId') || undefined,
      evidenceOnly: form.get('evidenceOnly') || undefined,
      clockOffsetMs: form.get('clockOffsetMs') ?? undefined,
      clockUncertaintyMs: form.get('clockUncertaintyMs') ?? undefined
    });
    const fileError = validateUploadFile(file, meta.channel);
    if (fileError) return fail(fileError, fileError === '上传文件过大' ? 413 : 400);
    if (meta.startedAt && meta.endedAt && new Date(meta.endedAt) < new Date(meta.startedAt)) return fail('录像结束时间不能早于开始时间', 400);

    // Both admission and multipart reading may wait. A grant can be consumed,
    // deleted, or expire while queued; even duplicate acknowledgements require
    // current authority rather than the pre-upload grant snapshot.
    if (grant && !await uploadGrantIsActive(grant)) return fail('材料上传凭据或电脑配对已失效，请重新提交', 401);

    // Reading the body can take two minutes. Recheck revocation/token rotation
    // after that wait instead of accepting the pre-upload authorization snapshot.
    const session = meta.sessionId ? await prisma.clientSession.findUnique({ where: { id: meta.sessionId } }) : null;
    if (meta.sessionId && !session) return fail('客户端会话不存在', 404);
    if (session) {
      if (!verifyClientTokenForSession(request, session, sideForChannel(meta.channel))) return fail('客户端会话令牌无效或已过期', 401);
      if (meta.examId && meta.examId !== session.examId) return fail('上传 examId 与会话不匹配', 400);
      if (meta.candidateId && meta.candidateId !== session.candidateId) return fail('上传 candidateId 与会话不匹配', 400);
    }
    if (!session && !['IDENTITY_PHOTO', 'ROOM_VIDEO'].includes(meta.channel)) {
      return fail('该上传通道必须绑定客户端会话', 401);
    }
    if (!session && meta.candidateId && meta.candidateId !== grant?.candidateId) return fail('材料与考生不匹配', 403);
    if (!session && (!grant || meta.examId !== grant.examId)) return fail('材料与考试不匹配', 403);
    if (session && (grant || session.id !== authorizedSession?.id || ['IDENTITY_PHOTO', 'ROOM_VIDEO'].includes(meta.channel))) return fail('上传凭据或通道与会话不匹配', 403);

    const examId = meta.examId || session?.examId || grant?.examId;
    if (!examId) return fail('缺少 examId，且无法从 session/candidate 推断考试', 400);
    const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { endAt: true, saveFullRecording: true, saveIncidentRecording: true, reactionEnabled: true, reactionConfig: true, recordingsDeletedAt: true } });
    if (!exam) return fail('考试不存在', 404);
    const monitoring = ['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA', 'EVIDENCE_CLIP'].includes(meta.channel);
    const recordingChannel = ['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA'].includes(meta.channel) ? meta.channel
      : meta.channel === 'EVIDENCE_CLIP' && !file.type.startsWith('image/') ? 'DESKTOP_SCREEN' : null;
    if (monitoring && exam.recordingsDeletedAt) return ok({ discarded: true, reason: 'deleted' });
    const reactionRecording = exam.reactionEnabled && ['DESKTOP_SCREEN','DESKTOP_CAMERA'].includes(recordingChannel || '');
    if (reactionRecording) {
      if (!meta.startedAt || !meta.endedAt) return fail('Reaction 录像必须提供采集起止时间',400);
      if (new Date(meta.endedAt).getTime() > Date.now()+5000 || new Date(meta.startedAt).getTime() < Date.now()-86400000) return fail('录像时钟未同步',400);
    }
    if (recordingChannel && !exam.saveFullRecording && !exam.saveIncidentRecording && !reactionRecording) return ok({ discarded: true, reason: 'disabled' });
    if (session && !exam.saveFullRecording && recordingChannel && !reactionRecording) {
      if (!meta.startedAt || !meta.endedAt) return fail('异常录像必须提供真实起止时间', 400);
      if (!await isIncidentRecording(session.id, recordingChannel, new Date(meta.startedAt), new Date(meta.endedAt))) {
        // New clients retry evidence until its incident has arrived. Older
        // clients' continuous uploads are discarded without creating files.
        if (meta.evidenceOnly === 'true') return fail('异常记录尚未同步，请稍后补传录像', 409);
        return ok({ discarded: true });
      }
    }
    const uploadBuffer = Buffer.from(await file.arrayBuffer());
    const identityInput = { ...meta, sessionId: session?.id || grant?.id, examId, uploadId: meta.uploadId };
    const isImage = meta.channel === 'IDENTITY_PHOTO' || (meta.channel === 'EVIDENCE_CLIP' && file.type.startsWith('image/'));
    // Videos are preserved byte-for-byte. Authenticate and recheck recording
    // policy above, then acknowledge a previously validated content digest
    // before starting another CPU-heavy decoder or consuming storage quota.
    // Photos are re-encoded, so their identity is computed after validation.
    const videoIdentity = isImage ? null : mediaUploadIdentity({ ...identityInput, buffer: uploadBuffer });
    let existing = videoIdentity ? await prisma.mediaSegment.findUnique({ where: { id: videoIdentity.id } }) : null;
    if (existing?.deletedAt) return ok({ discarded: true, reason: 'deleted' });
    if (existing?.validatedAt && videoIdentity) {
      const basename = `${videoIdentity.id}-${videoIdentity.digest.slice(0, 32)}`;
      if (existing.byteSize !== uploadBuffer.length || !['.webm', '.mp4'].some(extension => existing!.objectPath.endsWith(`/${basename}${extension}`))) {
        return fail('同一录像上传标识对应了不同内容', 409);
      }
      return ok({ segment: existing, stored: { objectPath: existing.objectPath, url: existing.objectPath }, duplicate: true });
    }
    const validated = await validateMedia(uploadBuffer, meta.channel, file.type);
    const buffer = validated.buffer;
    // Before login there is no authenticated identity to share a retry key
    // across callers; never accidentally rebind another person's materials.
    const { id, digest } = videoIdentity || mediaUploadIdentity({ ...identityInput, buffer });
    // Keep the full object URL within the existing MySQL VARCHAR(191) field.
    const filename = `${id}-${digest.slice(0, 32)}${validated.extension}`;
    if (!videoIdentity) existing = await prisma.mediaSegment.findUnique({ where: { id } });
    if (existing?.deletedAt) return ok({ discarded: true, reason: 'deleted' });
    if (existing) {
      if (!existing.objectPath.endsWith(filename)) return fail('同一录像上传标识对应了不同内容', 409);
      return ok({ segment: existing, stored: { objectPath: existing.objectPath, url: existing.objectPath }, duplicate: true });
    }
    // A lost success response can be acknowledged even after the grace window;
    // only new data is subject to the finished-session deadline.
    if (reactionRecording && await reactionStoredBytes(prisma,examId)+BigInt(buffer.length) > (exam.reactionConfig?.maxStorageBytes ?? 21474836480n)) return fail('Reaction 存储已达上限，保留现有录像并暂停新上传',507);
    if (session?.status === 'FINISHED' && (!session.endedAt || session.endedAt.getTime() < Date.now() - FINISHED_UPLOAD_GRACE_MS)) {
      return fail('考试会话已结束且录像补传窗口已关闭', 409);
    }
    const withinUploadGrace = Boolean(session && (session.endedAt || exam.endAt).getTime() >= Date.now() - FINISHED_UPLOAD_GRACE_MS);
    if (exam.endAt < new Date() && !withinUploadGrace) return fail('考试已结束，不能继续上传材料', 400);
    const scope = session ? `session:${session.id}` : `materials:${grant!.pairingId}:${grant!.candidateId}`;
    const quota = session ? Number(process.env.UPLOAD_SESSION_QUOTA_BYTES || 16 * 1024 * MB) : 100 * MB;
    // Distinct content racing under one uploadId must each account for disk space.
    await reserveUploadBytes(scope, buffer.length, quota, `${id}:${digest}`);
    const storageSettings = await getStorageSettings();
    const stored = await storeBuffer(buffer, {
      filename,
      stableName: true,
      immutable: true,
      contentType: validated.contentType,
      prefix: `${examId}/${session?.candidateId || grant!.candidateId}`
    }, storageSettings);
    const storage = deletionStorage(storageSettings);
    let discardedReason = 'deleted';
    let authorizationExpired = false;
    const segment = await withMediaSegmentWrite(async tx => {
      discardedReason = 'deleted';
      authorizationExpired = false;
      await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${examId} FOR UPDATE`;
      const currentExam = await tx.exam.findUnique({ where: { id: examId }, select: { saveFullRecording: true, saveIncidentRecording: true, reactionEnabled: true, reactionConfig:true, recordingsDeletedAt: true } });
      const previous = await tx.mediaSegment.findUnique({ where: { id } });
      const currentSession = session ? await tx.clientSession.findUnique({ where: { id: session.id } }) : null;
      const authorized = session ? Boolean(currentSession && verifyClientTokenForSession(request, currentSession, sideForChannel(meta.channel)))
        : Boolean(grant && await uploadGrantIsActive(grant, tx));
      if (!authorized) {
        authorizationExpired = true;
        // The object is already published. Commit cleanup rather than throwing
        // and rolling back the only deletion job for this unreferenced file.
        if (!await mediaHasReferences(tx, stored.objectPath)) await queueFileDeletion(tx, { kind: 'MEDIA', examId, objectPath: stored.objectPath, storage, requestedById: 'client-upload' }, true);
        return null;
      }
      // Recheck under the exam lock: an administrator can disable saving while decoding/uploading.
      const reactionAllowed = currentExam?.reactionEnabled && ['DESKTOP_SCREEN','DESKTOP_CAMERA'].includes(recordingChannel || '');
      if (reactionAllowed && !previous && await reactionStoredBytes(tx,examId)+BigInt(buffer.length) > (currentExam.reactionConfig?.maxStorageBytes ?? 21474836480n)) {
        discardedReason='storage_limit';
        if(!await mediaHasReferences(tx,stored.objectPath)) await queueFileDeletion(tx,{kind:'MEDIA',examId,objectPath:stored.objectPath,storage,requestedById:'reaction-budget'},true);
        return null;
      }
      const recordingDenied = !reactionAllowed && recordingChannel && !currentExam?.saveFullRecording && (!currentExam?.saveIncidentRecording
        || !session || !meta.startedAt || !meta.endedAt || !await isIncidentRecording(session.id, recordingChannel, new Date(meta.startedAt), new Date(meta.endedAt), tx));
      if (monitoring && (recordingDenied || currentExam?.recordingsDeletedAt || previous?.deletedAt || await tx.fileDeletionJob.findFirst({ where: { kind: 'MEDIA', objectHash: objectHash(stored.objectPath) } }))) {
        if (recordingDenied) discardedReason = 'disabled';
        if (!await mediaHasReferences(tx, stored.objectPath)) await queueFileDeletion(tx, { kind: 'MEDIA', examId, objectPath: stored.objectPath, storage, requestedById: 'client-upload' }, true);
        return null;
      }
      const saved = await tx.mediaSegment.upsert({
        where: { id },
        update: {},
        create: {
          id,
          examId,
          candidateId: session?.candidateId || grant?.candidateId,
          sessionId: meta.sessionId,
          channel: meta.channel,
          uploadGrantId: grant?.id,
          byteSize: buffer.length,
          validatedAt: new Date(),
          durationSeconds: validated.duration,
          reactionCache: Boolean(reactionAllowed && !currentExam?.saveFullRecording),
          clockOffsetMs: meta.clockOffsetMs,
          clockUncertaintyMs: meta.clockUncertaintyMs,
          // Persist the short provider-independent key; authorized read APIs
          // resolve/sign it, and long S3 hostnames cannot overflow VARCHAR(191).
          objectPath: stored.objectPath,
          startedAt: meta.startedAt ? new Date(meta.startedAt) : new Date(),
          endedAt: meta.endedAt ? new Date(meta.endedAt) : undefined
        }
      }).catch(async (error: unknown) => {
        // MySQL-backed Prisma can emulate upsert as read/create. Its unique id
        // still protects concurrent retries, but return the winning row as 200.
        if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return tx.mediaSegment.findUniqueOrThrow({ where: { id } });
        throw error;
      });
      if (saved && reactionAllowed) {
        const pending = await tx.reaction.findMany({where:{examId,candidateId:session?.candidateId,status:{in:['PENDING','TAIL','CAPTURING']}}});
        for(const r of pending) await pinReactionSegments(tx,r.id);
      }
      return saved;
    });
    if (!segment) return authorizationExpired ? fail('上传凭据已失效或会话已注销，请重新连接后重试', 401) : ok({ discarded: true, reason: discardedReason });
    if (segment.objectPath !== stored.objectPath) {
      // The unique upload ID has a committed winner. This digest-specific key
      // cannot become that winner and must not remain as an unused second file.
      await deleteStoredObject(stored.objectPath, storageSettings);
      return fail('同一录像上传标识对应了不同内容', 409);
    }
    return ok({ segment, stored }, { status: 201 });
  } catch (error) {
    if (error instanceof UploadSecurityError) return fail(error.message, error.status);
    if (error instanceof z.ZodError) return fail('上传参数格式不正确', 400);
    return fail(toErrorMessage(error), 500);
  } finally { release?.(); }
}

export const OPTIONS = options;
