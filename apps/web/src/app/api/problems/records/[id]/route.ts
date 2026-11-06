import { problemSubmissionOwner } from '@/lib/problem-submission-owner';
import { requireUser, AuthError } from '@/lib/auth';
import { admittedProblemRecordRead, syncProblemSubmissionStatus } from '@/lib/problem-submission-sync';
import { isRequestAdmissionError } from '@/lib/request-admission';
import { prisma } from '@/lib/db';
import { fail, ok, toErrorMessage } from '@/lib/http';
import { canAccessHydroProblem } from '@/lib/permissions';
async function loadRecord(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const owner = await problemSubmissionOwner(user);
    const local = await prisma.problemSubmission.findFirst({
      where: {
        id,
        ...owner,
      },
      select: { id: true, problemId: true, hydroRecordId: true, status: true, statusText: true, judgeAt: true, updatedAt: true },
    });
    if (!local) return fail('提交记录不存在或无权访问', 404);
    if (!await canAccessHydroProblem(user, local.problemId)) return fail('无权查看该提交记录', 403);
    await syncProblemSubmissionStatus(local, true);
    if (_request.signal.aborted) return fail('请求已取消', 408);
    const updated = await prisma.problemSubmission.findFirst({ where: { id: local.id, ...owner }, include: { user: { select: { id: true, username: true, numberId: true, nickname: true, realName: true } } } });
    if (!updated) return fail('提交记录不存在或无权访问', 404);
    const submitter = updated.user?.realName || updated.user?.nickname || updated.user?.numberId || updated.user?.username || updated.ownerKey;
    return ok({ id: updated.id, pid: Number(updated.problemId), lang: updated.lang, status: updated.status, statusText: updated.statusText,
      score: updated.score, time: updated.time, memory: updated.memory, testCases: updated.testCases || [], subtasks: updated.subtasks || {},
      judgeAt: updated.judgeAt?.toISOString() || null, recordExamId: updated.recordExamId, ownerKey: updated.ownerKey, hydroRecordId: updated.hydroRecordId,
      code: updated.code, createdAt: updated.createdAt.toISOString(), totalTestCases: updated.totalTestCases, passedTestCases: updated.passedTestCases, submitter });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (isRequestAdmissionError(error)) { const response = fail('判题状态刷新繁忙，请稍后重试', 503); response.headers.set('Retry-After', '2'); return response; }
    return fail(toErrorMessage(error), 502);
  }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return admittedProblemRecordRead(request, () => loadRecord(request, context));
}
