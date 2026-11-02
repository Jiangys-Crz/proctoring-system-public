import { problemSubmissionOwner } from '@/lib/problem-submission-owner';
import { requireUser, AuthError } from '@/lib/auth';
import { judgeStatistics, requestHydroJudgeStatus } from '@/lib/hydro-contest';
import { prisma } from '@/lib/db';
import { fail, ok, toErrorMessage } from '@/lib/http';
import { canAccessHydroProblem } from '@/lib/permissions';
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const owner = await problemSubmissionOwner(user);
    const local = await prisma.problemSubmission.findFirst({
      where: {
        id,
        ...owner,
      },
      include: { user: { select: { id: true, username: true, numberId: true, nickname: true, realName: true } } },
    });
    if (!local) return fail('提交记录不存在或无权访问', 404);
    if (!await canAccessHydroProblem(user, local.problemId)) return fail('无权查看该提交记录', 403);
    const remote = await requestHydroJudgeStatus({ platformBaseUrl: process.env.HYDRO_PROCTOR_BASE_URL || 'http://localhost' }, local.hydroRecordId || id);
    const updated = await prisma.problemSubmission.update({ where: { id: local.id }, data: { status: remote.status || 0, statusText: remote.statusText || 'Waiting', score: remote.score || 0, ...judgeStatistics(remote.testCases), time: remote.time || 0, memory: remote.memory || 0, testCases: remote.testCases as any, subtasks: remote.subtasks as any, judgeAt: remote.judgeAt ? new Date(remote.judgeAt) : null }, include: { user: { select: { id: true, username: true, numberId: true, nickname: true, realName: true } } } });
    const submitter = updated.user?.realName || updated.user?.nickname || updated.user?.numberId || updated.user?.username || updated.ownerKey;
    return ok({ ...remote, id: updated.id, recordExamId: updated.recordExamId, ownerKey: updated.ownerKey, hydroRecordId: updated.hydroRecordId, code: updated.code, createdAt: updated.createdAt.toISOString(), totalTestCases: updated.totalTestCases, passedTestCases: updated.passedTestCases, submitter });
  } catch (error) { if (error instanceof AuthError) return fail(error.message, error.status); return fail(toErrorMessage(error), 502); }
}
