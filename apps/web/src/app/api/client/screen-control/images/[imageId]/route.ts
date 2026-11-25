import { requireClientSession } from '@/lib/client-auth';
import { prisma } from '@/lib/db';
import { fail, options } from '@/lib/http';
import { getCurrentClientScreenControlDisplay, isParticipantOnlyDisplay, screenControlParticipantImageId } from '@/lib/screen-control';
import { getScreenControlParticipantCard } from '@/lib/screen-control-participant-card';
import { admittedScreenControlImage, screenControlImageBytesResponse, screenControlImageResponse, screenControlRouteError } from '@/lib/screen-control-route';
import { screenControlTextValues } from '@/lib/screen-control-personalization';
import { readScreenImageTemplate } from '@/lib/screen-control-template';

async function getImage(request: Request, context: { params: Promise<{ imageId: string }> }) {
  try {
    const sessionId = new URL(request.url).searchParams.get('sessionId');
    if (!sessionId) return fail('缺少客户端会话', 400);
    const authorization = await requireClientSession(request, sessionId, 'DESKTOP');
    if (!authorization.ok) return fail(authorization.message, authorization.status);
    const { imageId } = await context.params;
    const { examId, candidateId } = authorization.session;
    const display = await getCurrentClientScreenControlDisplay(examId);
    if (!display) return fail('图片不属于当前展示', 403);
    if (display.showParticipantCard && imageId === screenControlParticipantImageId(display.id)) {
      const card = await getScreenControlParticipantCard(examId, candidateId);
      return screenControlImageBytesResponse(card, 'image/webp');
    }
    if (isParticipantOnlyDisplay(display) || !display.group.images.some(image => image.id === imageId)) return fail('图片不属于当前展示', 403);
    const image = await prisma.screenControlImage.findFirst({ where: { id: imageId, group: { examId } } });
    if (!image) return fail('图片不存在', 404);
    // Older pushes keep their saved layouts until they end. New pushes serve
    // group images directly and show the personalized slide as a separate image.
    const template = display.showParticipantCard == null ? readScreenImageTemplate(image.template) : null;
    const values = template?.blocks.length ? await screenControlTextValues(examId, candidateId) : undefined;
    return await screenControlImageResponse(image, values, template);
  } catch (error) { return screenControlRouteError(error); }
}

export async function GET(request: Request, context: { params: Promise<{ imageId: string }> }) {
  return admittedScreenControlImage(request, () => getImage(request, context));
}

export const OPTIONS = options;
