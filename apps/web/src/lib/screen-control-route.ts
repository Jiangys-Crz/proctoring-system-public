import { AuthError, requireUser } from './auth';
import { prisma } from './db';
import { fail, RequestParseError, toErrorMessage } from './http';
import { canManageExam } from './permissions';
import { ScreenControlError } from './screen-control-policy';
import { readScreenControlImage } from './screen-control-images';
import { cachedScreenControlImage } from './screen-control-render';
import { readScreenImageTemplate, type ScreenImageTemplate, type ScreenTextValues } from './screen-control-template';
import { UploadSecurityError } from './upload-security';

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
    : await readScreenControlImage(image.objectPath);
  return new Response(new Uint8Array(buffer), { headers: {
    'content-type': personalized ? 'image/webp' : image.contentType, 'content-length': String(buffer.length),
    'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
  } });
}
