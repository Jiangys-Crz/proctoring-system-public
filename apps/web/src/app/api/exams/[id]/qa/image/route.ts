import { ScreenControlError } from '@/lib/screen-control-policy';
import { normalizeScreenControlImage } from '@/lib/screen-control-images';
import { admitAuxiliaryUpload, acquireUploadSlot, boundedUploadForm, UploadSecurityError } from '@/lib/upload-security';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessExam } from '@/lib/permissions';
import { fail, ok, options, toErrorMessage } from '@/lib/http';
import { publicObjectUrl, storeBuffer } from '@/lib/storage';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const QA_IMAGE_TTL_SECONDS = 90 * 24 * 60 * 60;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let release: (() => void) | undefined;
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    if (!(await canAccessExam(user, id))) return fail('无权上传该考试的答疑图片', 403);
    const account = await admitAuxiliaryUpload(`admin:${user.id}:exam:${id}`, 30);
    release = acquireUploadSlot();
    const form = await boundedUploadForm(request, 11 * 1024 * 1024);
    const file = form.get('file');
    if (!(file instanceof File)) return fail('缺少图片', 400);
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) return fail('仅支持 PNG、JPEG、GIF 或 WebP 图片', 400);
    if (file.size > MAX_IMAGE_BYTES) return fail('图片不能超过 10MB', 413);
    const normalized = await normalizeScreenControlImage(Buffer.from(await file.arrayBuffer()));
    await account(normalized.byteSize);
    const stored = await storeBuffer(normalized.buffer, {
      filename: 'announcement-image.webp',
      contentType: normalized.contentType,
      prefix: `qa/${id}/admin`,
    });
    return ok({ url: await publicObjectUrl(stored.objectPath, QA_IMAGE_TTL_SECONDS) }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof ScreenControlError) return fail(error.message, error.status);
    if (error instanceof UploadSecurityError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  } finally { release?.(); }
}

export const OPTIONS = options;
