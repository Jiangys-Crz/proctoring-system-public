import { prisma } from '@/lib/db';
import { fail, options } from '@/lib/http';
import { admittedScreenControlImage, requireScreenControlAdmin, screenControlImageResponse, screenControlRouteError } from '@/lib/screen-control-route';

async function getImage(_request: Request, context: { params: Promise<{ id: string; imageId: string }> }) {
  try {
    const { id, imageId } = await context.params;
    await requireScreenControlAdmin(id);
    const image = await prisma.screenControlImage.findFirst({ where: { id: imageId, group: { examId: id } } });
    if (!image) return fail('图片不存在', 404);
    return await screenControlImageResponse(image);
  } catch (error) { return screenControlRouteError(error); }
}

export async function GET(request: Request, context: { params: Promise<{ id: string; imageId: string }> }) {
  return admittedScreenControlImage(request, () => getImage(request, context));
}

export const OPTIONS = options;
