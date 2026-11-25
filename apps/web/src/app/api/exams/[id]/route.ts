import { z } from 'zod';
import { CreateExamSchema, isBrowserExam } from '@cwnupaa/proctor-shared';
import { Prisma, ReactionLogoMatchBy } from '@prisma/client';
import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessExam, canManageExam } from '@/lib/permissions';
import { isPublicTestExam } from '@/lib/public-test';
import { saveExam } from '@/lib/exam-save';
import { ExamSettingsError, normalizeExamSettings } from '@/lib/exam-settings';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { publicDto, PUBLIC_USER_SELECT } from '@/lib/public-dto';

const EditableExamSchema = CreateExamSchema.extend({ reactionLogoMatchBy: z.enum(ReactionLogoMatchBy).optional() });
const PatchExamSchema = z.record(z.string(), z.unknown()).transform(raw => {
  const parsed = EditableExamSchema.partial().parse(raw);
  // Zod defaults must not overwrite fields omitted from a PATCH request.
  return Object.fromEntries(Object.keys(raw).filter(key => key in parsed)
    .map(key => [key, parsed[key as keyof typeof parsed]])) as Partial<z.infer<typeof EditableExamSchema>>;
});

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    if (!(await canAccessExam(user, id))) return fail('无权查看该考试', 403);
    const manageable = await canManageExam(user, id);
    const exam = await prisma.exam.findUnique({
      where: { id },
      include: {
        problems: { orderBy: { order: 'asc' } },
        administrators: { select: { user: { select: { id: true, username: true, realName: true, numberId: true } } } },
        rooms: {
          ...(manageable ? {} : { where: { proctors: { some: { userId: user.id } } } }),
          include: {
            proctors: { include: { user: { select: PUBLIC_USER_SELECT } } },
            candidates: { where: { candidate: { examId: id } }, include: { candidate: true } }
          }
        }
      }
    });
    if (!exam) return fail('考试不存在', 404);
    return ok(publicDto({ ...exam, novaJudgeApiKeyConfigured: Boolean(exam.novaJudgeApiKey?.trim()), hydroBrowserApiKeyConfigured: Boolean(exam.hydroBrowserApiKey?.trim()), hydroBrowserEventFeedApiKeyConfigured: Boolean(exam.hydroBrowserEventFeedApiKey?.trim()) }));
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    if (!(await canManageExam(user, id))) return fail('无权编辑该考试', 403);
    if (await isPublicTestExam(id)) return fail('公开测试考试由系统维护，不能修改开放时间或考试规则', 403);
    const { reactionLogoMatchBy, ...input } = await parseBody(request, PatchExamSchema);
    if (Object.keys(input).some(key => key.startsWith('externalBoard'))) return fail('请在考试管理的“外榜推送”中修改配置和实时开关', 400);
    if (reactionLogoMatchBy !== undefined && Object.keys(input).length === 0) {
      try {
        const setting = await prisma.exam.update({ where: { id }, data: { reactionLogoMatchBy }, select: { reactionLogoMatchBy: true } });
        return ok(setting);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return fail('考试不存在', 404);
        throw error;
      }
    }
    const current = await prisma.exam.findUnique({ where: { id } });
    if (!current) return fail('考试不存在', 404);
    if (input.platform && input.platform !== current.platform) return fail('已创建考试不能切换答题平台，请另行发布考试', 400);
    const merged = CreateExamSchema.parse({ ...current, ...input,
      hydroBrowserApiKey: input.hydroBrowserApiKey?.trim() || current.hydroBrowserApiKey,
      hydroBrowserEventFeedApiKey: input.hydroBrowserEventFeedApiKey?.trim() || current.hydroBrowserEventFeedApiKey });
    const normalized = normalizeExamSettings(merged);
    const targetChanged = normalized.platformBaseUrl !== current.platformBaseUrl || normalized.platformContestId !== current.platformContestId;
    if (current.platform === 'HYDRO_BROWSER' && current.published && targetChanged) {
      return fail('发布后不能更换已启用监考的 HydroOJ 比赛，请另行发布考试', 409);
    }
    if (targetChanged
      && await prisma.reactionConfig.count({where:{examId:id,initializedAt:{not:null}}})) {
      return fail('本场 Reaction 已绑定比赛来源，请新建考试关联其他比赛，避免混用历史提交与录像',409);
    }
    if (isBrowserExam(current.platform) && targetChanged
      && await prisma.clientSession.count({ where: { examId: id, status: { not: 'FINISHED' } } })) {
      return fail('已有未结束的监考会话时不能更换浏览器考试地址或比赛 ID，请先结束这些会话', 409);
    }
    if ((normalized.teamAccountMode !== current.teamAccountMode || normalized.contestType !== current.contestType)
      && await prisma.candidate.count({ where: { examId: id } })) {
      return fail('已有考生后不能切换比赛类型或团队账号方式，请先清空考生名单', 400);
    }
    const exam = await saveExam({ ...merged, reactionLogoMatchBy }, user.id, id, input.novaJudgeApiKey, input.hydroBrowserApiKey, input.hydroBrowserEventFeedApiKey);
    return ok(exam);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof ExamSettingsError) return fail(error.message, 400);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
