import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canManageExam } from '@/lib/permissions';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { isPublicTestExam } from '@/lib/public-test';
import { ExternalBoardPatchSchema, ExternalBoardSettingsError, externalBoardSelect, saveExternalBoardSettings } from '@/lib/external-board-settings';
import { readExternalBoardLogs } from '@/lib/external-board-log';

async function readState(id: string) {
  const [state, exam] = await Promise.all([
    prisma.externalBoardSync.findUnique({ where: { examId: id }, select: { lastSuccessAt: true, lastError: true, scanUntil: true, nextAttemptAt: true } }),
    prisma.exam.findUnique({ where: { id }, select: externalBoardSelect }),
  ]);
  if (!exam) throw new ExternalBoardSettingsError('考试不存在', 404);
  return { ...state, logs: readExternalBoardLogs(id), enabled: exam.externalBoardEnabled, intervalSeconds: exam.externalBoardIntervalSeconds,
    baseUrl: exam.externalBoardBaseUrl || 'https://www.example.org/api', eventId: exam.externalBoardEventId || '', appKey: exam.externalBoardApiKey || '' };
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    if (!await canManageExam(user, id)) return fail('无权查看该考试的外榜推送状态', 403);
    // Explicit credential read, available only to this exam's managers.
    return ok(await readState(id), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof ExternalBoardSettingsError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    if (!await canManageExam(user, id)) return fail('无权修改该考试的外榜推送配置', 403);
    if (await isPublicTestExam(id)) return fail('公开测试考试不支持外榜推送', 403);
    const input = await parseBody(request, ExternalBoardPatchSchema);
    await saveExternalBoardSettings(id, input);
    return ok(await readState(id), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof ExternalBoardSettingsError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
