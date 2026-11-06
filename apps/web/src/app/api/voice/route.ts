import { accountAuxiliaryUpload, acquireUploadSlot, boundedUploadForm, UploadSecurityError } from '@/lib/upload-security';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessCandidate } from '@/lib/permissions';
import { isPublicTestExam } from '@/lib/public-test';
import { publicObjectUrl, storeBuffer } from '@/lib/storage';
import { options, fail, ok, toErrorMessage } from '@/lib/http';

const QuerySchema = z.object({
  sessionId: z.string().optional(),
  candidateId: z.string().optional(),
  after: z.string().optional()
});

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const query = QuerySchema.parse({
      sessionId: searchParams.get('sessionId') || undefined,
      candidateId: searchParams.get('candidateId') || undefined,
      after: searchParams.get('after') || undefined
    });
    const session = query.sessionId ? await prisma.clientSession.findUnique({ where: { id: query.sessionId } }) : null;
    const candidateId = query.candidateId || session?.candidateId;
    if (!candidateId) return fail('缺少 candidateId 或 sessionId', 400);
    if (!(await canAccessCandidate(user, candidateId))) return fail('无权查看该考生语音', 403);
    const messages = await prisma.voiceMessage.findMany({
      where: {
        candidateId,
        ...(query.after ? { createdAt: { gt: new Date(query.after) } } : {})
      },
      orderBy: { createdAt: 'asc' },
      take: 100
    });
    const safeMessages = await Promise.all(
      messages.map(async (message) => ({
        ...message,
        objectPath: (await publicObjectUrl(message.objectPath)) || message.objectPath
      }))
    );
    return ok(safeMessages);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof UploadSecurityError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    const user = await requireUser(request);
    release = acquireUploadSlot();
    const form = await boundedUploadForm(request, 9 * 1024 * 1024);
    const file = form.get('file');
    if (!(file instanceof File)) return fail('缺少语音文件', 400);
    if (!file.size || file.size > 8 * 1024 * 1024) return fail('语音文件必须有效且不超过 8MB', 413);
    if (!file.type.startsWith('audio/')) return fail('语音只允许音频文件', 400);
    const sessionId = `${form.get('sessionId') || ''}` || undefined;
    const candidateIdFromForm = `${form.get('candidateId') || ''}` || undefined;
    const durationMs = Number(form.get('durationMs') || 0) || undefined;
    const session = sessionId ? await prisma.clientSession.findUnique({ where: { id: sessionId } }) : null;
    const candidateId = candidateIdFromForm || session?.candidateId;
    if (!candidateId) return fail('缺少 candidateId 或 sessionId', 400);
    if (sessionId && (!session || session.candidateId !== candidateId)) return fail('客户端会话不属于该考生', 403);
    if (!(await canAccessCandidate(user, candidateId))) return fail('无权对该考生发送语音', 403);
    const candidate = await prisma.candidate.findUnique({ where: { id: candidateId }, include: { exam: true } });
    if (!candidate) return fail('考生不存在', 404);
    if (await isPublicTestExam(candidate.examId)) return fail('环境测试不保存语音消息', 403);
    const now = new Date();
    if (now < candidate.exam.startAt || now > candidate.exam.endAt) return fail('当前不在考试时间内，不能发送语音消息', 400);

    const buffer = Buffer.from(await file.arrayBuffer());
    await accountAuxiliaryUpload(`admin:${user.id}:exam:${candidate.examId}`, buffer.length, 30);
    const stored = await storeBuffer(buffer, {
      filename: `voice-admin-${Date.now()}-${file.name || 'message.webm'}`,
      contentType: file.type || undefined,
      prefix: `${candidate.examId}/${candidateId}/voice`
    });
    const message = await prisma.voiceMessage.create({
      data: {
        examId: candidate.examId,
        candidateId,
        sessionId,
        sender: 'ADMIN',
        objectPath: stored.url || stored.objectPath,
        durationMs,
        createdById: user.id
      }
    });
    return ok(message, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof UploadSecurityError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  } finally { release?.(); }
}

export const OPTIONS = options;
