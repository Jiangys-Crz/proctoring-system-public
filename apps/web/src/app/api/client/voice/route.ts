import { authorizeAuxiliaryUpload, accountAuxiliaryUpload, boundedUploadForm, UploadSecurityError } from '@/lib/upload-security';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { verifyClientTokenForSession } from '@/lib/client-auth';
import { publicObjectUrl, storeBuffer } from '@/lib/storage';
import { options, fail, ok, toErrorMessage } from '@/lib/http';

const QuerySchema = z.object({
  sessionId: z.string().min(1),
  after: z.string().optional()
});

const MAX_VOICE_BYTES = 8 * 1024 * 1024;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = QuerySchema.parse({
      sessionId: searchParams.get('sessionId'),
      after: searchParams.get('after') || undefined
    });
    const session = await prisma.clientSession.findUnique({ where: { id: query.sessionId } });
    if (!session) return fail('客户端会话不存在', 404);
    if (!verifyClientTokenForSession(request, session, 'MINIPROGRAM')) return fail('客户端会话令牌无效或已过期', 401);
    const messages = await prisma.voiceMessage.findMany({
      where: {
        sessionId: session.id,
        sender: 'ADMIN',
        ...(query.after ? { createdAt: { gt: new Date(query.after) } } : {})
      },
      orderBy: { createdAt: 'asc' },
      take: 20
    });
    const safeMessages = await Promise.all(
      messages.map(async (message) => ({
        ...message,
        objectPath: (await publicObjectUrl(message.objectPath)) || message.objectPath
      }))
    );
    return ok(safeMessages);
  } catch (error) {
    if (error instanceof UploadSecurityError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function POST(request: Request) {
  try {
    const authorized = await authorizeAuxiliaryUpload(request);
    const form = await boundedUploadForm(request, 9 * 1024 * 1024);
    const file = form.get('file');
    if (!(file instanceof File)) return fail('缺少语音文件', 400);
    if (file.size > MAX_VOICE_BYTES) return fail('语音文件过大', 413);
    if (file.type && !file.type.startsWith('audio/')) return fail('语音只允许上传音频文件', 400);
    const sessionId = `${form.get('sessionId') || ''}`;
    if (sessionId !== authorized.id) return fail('上传会话不匹配', 403);
    const durationMs = Number(form.get('durationMs') || 0) || undefined;
    const session = await prisma.clientSession.findUnique({ where: { id: sessionId }, include: { exam: true } });
    if (!session) return fail('客户端会话不存在', 404);
    if (!verifyClientTokenForSession(request, session, 'MINIPROGRAM')) return fail('客户端会话令牌无效或已过期', 401);
    const now = new Date();
    if (now < session.exam.startAt || now > session.exam.endAt) return fail('当前不在考试时间内，不能发送语音消息', 400);
    const buffer = Buffer.from(await file.arrayBuffer());
    await accountAuxiliaryUpload(`session:${session.id}`, buffer.length, 20);
    const stored = await storeBuffer(buffer, {
      filename: `voice-miniprogram-${Date.now()}-${file.name || 'reply.m4a'}`,
      contentType: file.type || undefined,
      prefix: `${session.examId}/${session.candidateId}/voice`
    });
    const message = await prisma.voiceMessage.create({
      data: {
        examId: session.examId,
        candidateId: session.candidateId,
        sessionId: session.id,
        sender: 'MINIPROGRAM',
        objectPath: stored.url || stored.objectPath,
        durationMs
      }
    });
    return ok(message, { status: 201 });
  } catch (error) {
    if (error instanceof UploadSecurityError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
