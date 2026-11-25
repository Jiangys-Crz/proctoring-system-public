import { AuthError, requireUser } from './auth';
import { prisma } from './db';
import { fail, RequestParseError, toErrorMessage } from './http';
import { canManageExam } from './permissions';
import { ScreenControlError } from './screen-control-policy';
import { readScreenControlImage } from './screen-control-images';
import { cachedScreenControlImage } from './screen-control-render';
import { readScreenImageTemplate, type ScreenImageTemplate, type ScreenTextValues } from './screen-control-template';
import { UploadSecurityError } from './upload-security';
import { createRequestAdmission, isRequestAdmissionError } from './request-admission';
import { holdAttachment } from './attachment-admission';

const shared = globalThis as typeof globalThis & { screenImageAdmission?: ReturnType<typeof createRequestAdmission> };
const acquireImage = shared.screenImageAdmission ??= createRequestAdmission(4, 64, 3000);

/** Include authorization, storage, rendering and slow body consumers in the same budget. */
export async function admittedScreenControlImage(request: Request, work: () => Promise<Response>) {
  let release: (() => void) | undefined;
  try {
    release = await acquireImage(request.signal);
    const response = await work();
    if (!response.ok || !response.body) return response;
    const stream = holdAttachment(response, request.signal, release);
    release = undefined;
    return stream;
  } catch (error) {
    if (!isRequestAdmissionError(error)) throw error;
    const response = fail('图片加载繁忙，请稍后重试', 503);
    response.headers.set('Retry-After', '2'); return response;
  } finally { release?.(); }
}

export async function requireScreenControlAdmin(examId: string, request?: Request) {
  const user = await requireUser(request);
  if (!(await canManageExam(user, examId))) throw new ScreenControlError('无权管理该考试的屏幕控制', 403);
  if (!(await prisma.exam.findUnique({ where: { id: examId }, select: { id: true } }))) throw new ScreenControlError('考试不存在', 404);
  return user;
}

export function screenControlRouteError(error: unknown) {
  if (error instanceof AuthError || error instanceof ScreenControlError || error instanceof UploadSecurityError) return fail(error.message, error.status);
  if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
  return fail(toErrorMessage(error), 500);
}

export async function screenControlImageResponse(
  image: { objectPath: string; contentType: string; template?: unknown },
  values?: ScreenTextValues,
  previewTemplate?: ScreenImageTemplate | null,
) {
  const template = previewTemplate === undefined ? readScreenImageTemplate(image.template) : previewTemplate;
  const personalized = !!values && !!template?.blocks.length;
  const buffer = personalized
    ? await cachedScreenControlImage(image, template!, values!, () => readScreenControlImage(image.objectPath))
    : await cachedScreenControlImage(image, { version: 1, blocks: [] }, { name: '', teamname: '', members: '', school: '', college: '', group: '' }, () => readScreenControlImage(image.objectPath));
  return screenControlImageBytesResponse(buffer, personalized ? 'image/webp' : image.contentType);
}

export function screenControlImageBytesResponse(buffer: Buffer, contentType: string) {
  let offset = 0, data: Buffer | null = buffer;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!data) return;
      const end = Math.min(data.length, offset + 65536);
      if (offset < end) { controller.enqueue(data.subarray(offset, end)); offset = end; }
      if (offset === data.length) { controller.close(); data = null; }
    }, cancel() { data = null; },
  });
  return new Response(body, { headers: {
    'content-type': contentType, 'content-length': String(buffer.length),
    'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
  } });
}
