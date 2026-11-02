import { prisma } from '@/lib/db';
import { fail, options } from '@/lib/http';
import { requireScreenControlAdmin, screenControlImageResponse, screenControlRouteError } from '@/lib/screen-control-route';

export async function GET(_request: Request, context: { params: Promise<{ id: string; imageId: string }> }) {
  try {
    const { id, imageId } = await context.params;
    await requireScreenControlAdmin(id);
    const image = await prisma.screenControlImage.findFirst({ where: { id: imageId, group: { examId: id } } });
    if (!image) return fail('图片不存在', 404);
    return await screenControlImageResponse(image);
  } catch (error) { return screenControlRouteError(error); }
}

export const OPTIONS = options;
