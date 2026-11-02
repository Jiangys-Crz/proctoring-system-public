import { admitAuxiliaryUpload, acquireUploadSlot, boundedUploadForm, UploadSecurityError } from '@/lib/upload-security';
import { ok, options } from '@/lib/http';
import { createScreenControlGroup } from '@/lib/screen-control';
import { normalizeScreenControlImage, removeScreenControlImage } from '@/lib/screen-control-images';
import { ScreenControlError, ScreenControlGroupNameSchema, SCREEN_CONTROL_MAX_GROUP_BYTES, validateScreenUploadSizes } from '@/lib/screen-control-policy';
import { requireScreenControlAdmin, screenControlRouteError } from '@/lib/screen-control-route';
import { storeBuffer } from '@/lib/storage';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const uploaded: string[] = [];
  let release: (() => void) | undefined;
  try {
    const { id } = await context.params;
    const user = await requireScreenControlAdmin(id, request);
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > SCREEN_CONTROL_MAX_GROUP_BYTES + 1024 * 1024) throw new ScreenControlError('每组图片总大小不能超过 80MB', 413);
    const account = await admitAuxiliaryUpload(`admin:${user.id}:exam:${id}`, 30);
    release = acquireUploadSlot();
    const form = await boundedUploadForm(request, 81 * 1024 * 1024);
    const name = ScreenControlGroupNameSchema.safeParse(form.get('name'));
    if (!name.success) throw new ScreenControlError('请输入图片组名称（最多 120 字）');
    const entries = form.getAll('files');
    if (entries.some((file) => !(file instanceof File))) throw new ScreenControlError('请上传有效图片文件');
    const files = entries as File[];
    validateScreenUploadSizes(files.map((file) => file.size));
    const images = [];
    for (const file of files) {
      const normalized = await normalizeScreenControlImage(Buffer.from(await file.arrayBuffer()));
      validateScreenUploadSizes([...images.map((image) => image.byteSize), normalized.byteSize]);
      await account(normalized.byteSize);
      const stored = await storeBuffer(normalized.buffer, { filename: 'image.webp', contentType: normalized.contentType, prefix: `screen-control/${id}` });
      uploaded.push(stored.objectPath);
      const { buffer: _buffer, ...metadata } = normalized;
      images.push({ ...metadata, name: (file.name || '图片').slice(0, 255), objectPath: stored.objectPath });
    }
    const group = await createScreenControlGroup(id, name.data, images, user.id);
    return ok(group, { status: 201 });
  } catch (error) {
    await Promise.allSettled(uploaded.map(removeScreenControlImage));
    if (error instanceof UploadSecurityError) return new Response(JSON.stringify({ ok: false, message: error.message }), { status: error.status, headers: { 'content-type': 'application/json' } });
    return screenControlRouteError(error);
  } finally { release?.(); }
}

export const OPTIONS = options;
