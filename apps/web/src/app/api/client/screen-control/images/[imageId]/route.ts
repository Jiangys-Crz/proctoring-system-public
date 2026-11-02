import { requireClientSession } from '@/lib/client-auth';
import { prisma } from '@/lib/db';
import { fail, options } from '@/lib/http';
import { getClientScreenControl } from '@/lib/screen-control';
import { screenControlImageResponse, screenControlRouteError } from '@/lib/screen-control-route';
import { screenControlTextValues } from '@/lib/screen-control-personalization';
import { readScreenImageTemplate } from '@/lib/screen-control-template';

export async function GET(request: Request, context: { params: Promise<{ imageId: string }> }) {
  try {
    const sessionId = new URL(request.url).searchParams.get('sessionId');
    if (!sessionId) return fail('缺少客户端会话', 400);
    const authorization = await requireClientSession(request, sessionId, 'DESKTOP');
    if (!authorization.ok) return fail(authorization.message, authorization.status);
    const { imageId } = await context.params;
    const state = await getClientScreenControl(authorization.session.examId, sessionId);
    // A candidate may download only images in the currently selected group,
    // including while waiting for review or after the exam itself has finished.
    if (!state.active?.images.some((image) => image.id === imageId)) return fail('图片不属于当前展示', 403);
    const image = await prisma.screenControlImage.findFirst({ where: { id: imageId, group: { examId: authorization.session.examId } } });
    if (!image) return fail('图片不存在', 404);
    // Derive the identity solely from the authenticated session. Query-string
    // candidate IDs must never select another candidate's personalized image.
    const template = readScreenImageTemplate(image.template);
    const values = template?.blocks.length
      ? await screenControlTextValues(authorization.session.examId, authorization.session.candidateId) : undefined;
    return await screenControlImageResponse(image, values);
  } catch (error) { return screenControlRouteError(error); }
}

export const OPTIONS = options;
