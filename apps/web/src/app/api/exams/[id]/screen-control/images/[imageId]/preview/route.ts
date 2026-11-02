import { z } from 'zod';
import { prisma } from '@/lib/db';
import { fail, options, parseBody } from '@/lib/http';
import { requireScreenControlAdmin, screenControlImageResponse, screenControlRouteError } from '@/lib/screen-control-route';
import { ScreenImageTemplateSchema, unsupportedScreenFields } from '@/lib/screen-control-template';
import { screenControlTextValues } from '@/lib/screen-control-personalization';

const PreviewSchema = z.object({
  template: ScreenImageTemplateSchema.nullable(),
  candidateId: z.string().min(1).max(100).optional(),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string; imageId: string }> }) {
  try {
    const { id, imageId } = await context.params;
    await requireScreenControlAdmin(id, request);
    const input = await parseBody(request, PreviewSchema, 64 * 1024);
    const [image, exam] = await Promise.all([
      prisma.screenControlImage.findFirst({ where: { id: imageId, group: { examId: id } } }),
      prisma.exam.findUniqueOrThrow({ where: { id }, select: { contestType: true } }),
    ]);
    if (!image) return fail('图片不存在', 404);
    if (input.template && unsupportedScreenFields(input.template, exam.contestType === 'TEAM').length) {
      return fail('模板包含当前赛制不支持的字段，请使用可添加字段中的选项');
    }
    const values = await screenControlTextValues(id, input.candidateId);
    return await screenControlImageResponse(image, values, input.template);
  } catch (error) { return screenControlRouteError(error); }
}

export const OPTIONS = options;
