import { ScreenControlError } from '@/lib/screen-control-policy';
import { normalizeScreenControlImage } from '@/lib/screen-control-images';
import { authorizeAuxiliaryUpload, admitAuxiliaryUpload, acquireUploadSlot, boundedUploadForm, UploadSecurityError } from '@/lib/upload-security';
import { z, ZodError } from 'zod';
import { prisma } from '@/lib/db';
import { hashClientSessionToken, verifyClientTokenForSession, type ClientSide } from '@/lib/client-auth';
import { effectiveEnd } from '@/lib/contest-rules';
import { SessionWriteQueueError, withSessionWrite } from '@/lib/session-write';
import { storeBuffer } from '@/lib/storage';
import { options, fail, ok, toErrorMessage } from '@/lib/http';
import type { Prisma } from '@prisma/client';

const LiveFrameMetaSchema = z.object({
  sessionId: z.string().min(1).max(191),
  channel: z.enum(['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA']),
  capturedAt: z.iso.datetime({ offset: true }).optional()
});
type LiveFrameChannel = z.infer<typeof LiveFrameMetaSchema>['channel'];

const MAX_LIVE_FRAME_BYTES = 8 * 1024 * 1024;

async function authorizeFrame(db: Pick<Prisma.TransactionClient, 'clientSession' | 'examRoom'>, request: Request,
  sessionId: string, channel: LiveFrameChannel) {
  const session = await db.clientSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true, examId: true, candidateId: true, status: true, startedAt: true, revokedAt: true,
      desktopTokenHash: true, miniProgramTokenHash: true,
      candidate: { select: { startedAt: true, status: true } },
      exam: { select: { startAt: true, latestStartAt: true, endAt: true, durationMinutes: true,
        contestRule: true, flexible: true, requireFrontCamera: true, requireMiniProgram: true } }
    }
  });
  if (!session) throw new UploadSecurityError('客户端会话不存在', 404);
  const side: ClientSide = channel === 'MOBILE_CAMERA' ? 'MINIPROGRAM' : 'DESKTOP';
  if (!verifyClientTokenForSession(request, session, side)) throw new UploadSecurityError('客户端会话令牌无效或已过期', 401);
  if (session.status === 'FINISHED' || session.candidate.status === 'FINISHED'
    || effectiveEnd(session.exam, session.candidate.startedAt || session.startedAt) <= new Date()) {
    throw new UploadSecurityError('考试会话已结束，不能继续上传实时帧', 409);
  }
  if (channel !== 'DESKTOP_SCREEN') {
    const room = await db.examRoom.findFirst({
      where: { examId: session.examId, candidates: { some: { candidateId: session.candidateId } } },
      select: { requireFrontCamera: true, requireSecondCamera: true }
    });
    const enabled = channel === 'DESKTOP_CAMERA' ? room?.requireFrontCamera ?? session.exam.requireFrontCamera
      : room?.requireSecondCamera ?? session.exam.requireMiniProgram;
    if (!enabled) throw new UploadSecurityError('所在考室不要求该机位画面', 403);
  }
  return { session, credentialHash: side === 'DESKTOP' ? session.desktopTokenHash! : session.miniProgramTokenHash! };
}

export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    const authorized = await authorizeAuxiliaryUpload(request);
    const account = await admitAuxiliaryUpload(`session:${authorized.id}`, 240);
    release = acquireUploadSlot();
    const form = await boundedUploadForm(request, 9 * 1024 * 1024);
    const file = form.get('file');
    if (!(file instanceof File)) return fail('缺少实时帧文件', 400);
    if (file.size > MAX_LIVE_FRAME_BYTES) return fail('实时帧文件过大', 413);
    if (file.type && !['image/jpeg', 'image/png'].includes(file.type)) return fail('实时帧只允许上传 JPG/PNG 图片', 400);

    const meta = LiveFrameMetaSchema.parse({
      sessionId: form.get('sessionId'),
      channel: form.get('channel'),
      capturedAt: form.get('capturedAt') || undefined
    });
    if (meta.sessionId !== authorized.id) return fail('上传会话不匹配', 403);
    await authorizeFrame(prisma, request, meta.sessionId, meta.channel);

    const capturedAt = meta.capturedAt ? new Date(meta.capturedAt) : new Date();
    const normalized = await normalizeScreenControlImage(Buffer.from(await file.arrayBuffer()));
    const buffer = normalized.buffer;
    await account(buffer.length);
    const { session, credentialHash } = await authorizeFrame(prisma, request, meta.sessionId, meta.channel);
    // Keep each session and credential generation separate. The live-frame
    // rows and readers are session-scoped even when members share a candidate.
    const generation = hashClientSessionToken(`live-frame:${session.id}:${credentialHash}`).slice(0, 32);
    const stored = await storeBuffer(buffer, {
      filename: `live-${meta.channel}.webp`,
      contentType: normalized.contentType,
      prefix: `${session.examId}/${session.candidateId}/live/${session.id}/${generation}`,
      stableName: true
    });

    const objectPath = stored.url || stored.objectPath;
    const frame = await withSessionWrite(session.id, async (tx) => {
      await authorizeFrame(tx, request, session.id, meta.channel);
      return tx.liveFrame.upsert({
        where: { sessionId_channel: { sessionId: session.id, channel: meta.channel } },
        create: { examId: session.examId, candidateId: session.candidateId, sessionId: session.id,
          channel: meta.channel, objectPath, capturedAt },
        update: { objectPath, capturedAt }
      });
    }, { signal: request.signal });

    return ok({ frame, stored }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return fail('实时帧参数不正确', 400);
    if (error instanceof ScreenControlError) return fail(error.message, error.status);
    if (error instanceof UploadSecurityError) return fail(error.message, error.status);
    if (error instanceof SessionWriteQueueError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  } finally { release?.(); }
}

export const OPTIONS = options;
