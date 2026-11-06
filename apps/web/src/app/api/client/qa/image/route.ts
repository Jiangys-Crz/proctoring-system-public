import { ScreenControlError } from '@/lib/screen-control-policy';
import { normalizeScreenControlImage } from '@/lib/screen-control-images';
import { authorizeAuxiliaryUpload, admitAuxiliaryUpload, acquireUploadSlot, boundedUploadForm, UploadSecurityError } from '@/lib/upload-security';
import { prisma } from '@/lib/db';
import { requireFreshQaSession } from '@/lib/qa-thread';
import { AuthError } from '@/lib/auth';
import { fail, ok, options, toErrorMessage } from '@/lib/http';
import { publicObjectUrl, storeBuffer } from '@/lib/storage';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const QA_IMAGE_TTL_SECONDS = 90 * 24 * 60 * 60;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    const authorized = await authorizeAuxiliaryUpload(request);
    const account = await admitAuxiliaryUpload(`session:${authorized.id}`, 20);
    release = acquireUploadSlot();
    const form = await boundedUploadForm(request, 11 * 1024 * 1024);
    const sessionId = String(form.get('sessionId') || '');
    if (sessionId !== authorized.id) return fail('上传会话不匹配', 403);
    const file = form.get('file');
    if (!sessionId || !(file instanceof File)) return fail('缺少会话或图片', 400);
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) return fail('仅支持 PNG、JPEG、GIF 或 WebP 图片', 400);
    if (file.size > MAX_IMAGE_BYTES) return fail('图片不能超过 10MB', 413);
    await requireFreshQaSession(prisma, request, sessionId);
    const normalized = await normalizeScreenControlImage(Buffer.from(await file.arrayBuffer()));
    await account(normalized.byteSize);
    const session = await requireFreshQaSession(prisma, request, sessionId);
    const stored = await storeBuffer(normalized.buffer, {
      filename: 'question-image.webp',
      contentType: normalized.contentType,
      prefix: `qa/${session.examId}/${session.candidateId}`,
    });
    const url = await publicObjectUrl(stored.objectPath, QA_IMAGE_TTL_SECONDS);
    await requireFreshQaSession(prisma, request, sessionId);
    return ok({ url }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof ScreenControlError) return fail(error.message, error.status);
    if (error instanceof UploadSecurityError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  } finally { release?.(); }
}

export const OPTIONS = options;
