import { ScreenControlError } from '@/lib/screen-control-policy';
import { normalizeScreenControlImage } from '@/lib/screen-control-images';
import { authorizeAuxiliaryUpload, admitAuxiliaryUpload, acquireUploadSlot, boundedUploadForm, UploadSecurityError } from '@/lib/upload-security';
import { z } from 'zod';
import { MediaChannelSchema } from '@cwnupaa/proctor-shared';
import { prisma } from '@/lib/db';
import { verifyClientTokenForSession, type ClientSide } from '@/lib/client-auth';
import { storeBuffer } from '@/lib/storage';
import { options, fail, ok, toErrorMessage } from '@/lib/http';

const LiveFrameMetaSchema = z.object({
  sessionId: z.string().min(1),
  channel: MediaChannelSchema,
  capturedAt: z.string().optional()
});

const MAX_LIVE_FRAME_BYTES = 8 * 1024 * 1024;

function sideForChannel(channel: string): ClientSide {
  return channel === 'MOBILE_CAMERA' ? 'MINIPROGRAM' : 'DESKTOP';
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
    if (!['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA'].includes(meta.channel)) {
      return fail('实时帧通道不正确', 400);
    }

    const session = await prisma.clientSession.findUnique({
      where: { id: meta.sessionId },
      select: {
        id: true,
        examId: true,
        candidateId: true,
        desktopTokenHash: true,
        miniProgramTokenHash: true,
        status: true,
        exam: { select: { endAt: true } }
      }
    });
    if (meta.sessionId !== authorized.id) return fail('上传会话不匹配', 403);
    if (!session) return fail('客户端会话不存在', 404);
    if (!verifyClientTokenForSession(request, session, sideForChannel(meta.channel))) return fail('客户端会话令牌无效或已过期', 401);
    if (session.status === 'FINISHED' || session.exam.endAt <= new Date()) {
      return fail('考试会话已结束，不能继续上传实时帧', 409);
    }

    const capturedAt = meta.capturedAt ? new Date(meta.capturedAt) : new Date();
    const normalized = await normalizeScreenControlImage(Buffer.from(await file.arrayBuffer()));
    const buffer = normalized.buffer;
    await account(buffer.length);
    const stored = await storeBuffer(buffer, {
      filename: `live-${meta.channel}.webp`,
      contentType: normalized.contentType,
      prefix: `${session.examId}/${session.candidateId}/live`,
      stableName: true
    });

    const frame = await prisma.liveFrame.upsert({
      where: {
        sessionId_channel: {
          sessionId: session.id,
          channel: meta.channel
        }
      },
      create: {
        examId: session.examId,
        candidateId: session.candidateId,
        sessionId: session.id,
        channel: meta.channel,
        objectPath: stored.url || stored.objectPath,
        capturedAt
      },
      update: {
        examId: session.examId,
        candidateId: session.candidateId,
        objectPath: stored.url || stored.objectPath,
        capturedAt
      }
    });

    return ok({ frame, stored }, { status: 201 });
  } catch (error) {
    if (error instanceof ScreenControlError) return fail(error.message, error.status);
    if (error instanceof UploadSecurityError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  } finally { release?.(); }
}

export const OPTIONS = options;
