import { z } from 'zod';
import { CreateExamSchema, type CreateExamInput } from '@cwnupaa/proctor-shared';
import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessExam, canManageExam } from '@/lib/permissions';
import { isPublicTestExam } from '@/lib/public-test';
import { saveExam } from '@/lib/exam-save';
import { ExamSettingsError, normalizeExamSettings } from '@/lib/exam-settings';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { publicDto, PUBLIC_USER_SELECT } from '@/lib/public-dto';

const PatchExamSchema = z.record(z.string(), z.unknown()).transform(raw => {
  const parsed = CreateExamSchema.partial().parse(raw);
  // Zod defaults must not overwrite fields omitted from a PATCH request.
  return Object.fromEntries(Object.keys(raw).filter(key => key in parsed)
    .map(key => [key, parsed[key as keyof typeof parsed]])) as Partial<CreateExamInput>;
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
            candidates: { include: { candidate: true } }
          }
        }
      }
    });
    if (!exam) return fail('考试不存在', 404);
    return ok(publicDto({ ...exam, novaJudgeApiKeyConfigured: Boolean(exam.novaJudgeApiKey?.trim()) }));
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
    const input = await parseBody(request, PatchExamSchema);
    if (Object.keys(input).some(key => key.startsWith('externalBoard'))) return fail('请在考试管理的“外榜推送”中修改配置和实时开关', 400);
    const current = await prisma.exam.findUnique({ where: { id } });
    if (!current) return fail('考试不存在', 404);
    if (input.platform && input.platform !== current.platform) return fail('已创建考试不能切换答题平台，请另行发布考试', 400);
    const merged = CreateExamSchema.parse({ ...current, ...input });
    const normalized = normalizeExamSettings(merged);
    if (current.platform === 'NOVAJUDGE' && (normalized.platformBaseUrl !== current.platformBaseUrl || merged.platformContestId !== current.platformContestId)
      && await prisma.reactionConfig.count({where:{examId:id,initializedAt:{not:null}}})) {
      return fail('本场 Reaction 已绑定 CCS 比赛，请新建考试关联其他比赛，避免混用历史提交与录像',409);
    }
    if (current.platform === 'NOVAJUDGE' && (normalized.platformBaseUrl !== current.platformBaseUrl || merged.platformContestId !== current.platformContestId)
      && await prisma.clientSession.count({ where: { examId: id, status: { not: 'FINISHED' } } })) {
      return fail('已有未结束的监考会话时不能更换 NovaJudge 域名或比赛 ID，请先结束这些会话', 409);
    }
    if ((normalized.teamAccountMode !== current.teamAccountMode || normalized.contestType !== current.contestType)
      && await prisma.candidate.count({ where: { examId: id } })) {
      return fail('已有考生后不能切换比赛类型或团队账号方式，请先清空考生名单', 400);
    }
    const exam = await saveExam(merged, user.id, id);
    return ok(exam);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof ExamSettingsError) return fail(error.message, 400);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
