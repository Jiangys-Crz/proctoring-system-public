import { problemSubmissionOwner } from '@/lib/problem-submission-owner';
import { requireUser, AuthError } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { judgeStatistics, requestHydroJudgeStatus } from '@/lib/hydro-contest';
import { hydroStatusIsAwaiting } from '@/lib/hydro-status';
import { fail, ok, toErrorMessage } from '@/lib/http';
import { canAccessHydroProblem } from '@/lib/permissions';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    if (!await canAccessHydroProblem(user, id)) return fail('无权查看该题目的提交', 403);
    const owner = await problemSubmissionOwner(user);
    const records = await prisma.problemSubmission.findMany({
      where: { problemId: id, ...owner },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const synced = await Promise.all(records.map(async (record) => {
      if (!record.hydroRecordId || !hydroStatusIsAwaiting(record.statusText, record.status, record.judgeAt?.toISOString() || null)) return record;
      try {
        const remote = await requestHydroJudgeStatus(
          { platformBaseUrl: process.env.HYDRO_PROCTOR_BASE_URL || 'http://localhost' },
          record.hydroRecordId,
        );
        return await prisma.problemSubmission.update({
          where: { id: record.id },
          data: {
            status: remote.status ?? 0,
            statusText: remote.statusText || 'Waiting',
            score: remote.score ?? 0,
            ...judgeStatistics(remote.testCases),
            time: remote.time ?? 0,
            memory: remote.memory ?? 0,
            testCases: remote.testCases as any,
            subtasks: remote.subtasks as any,
            judgeAt: remote.judgeAt ? new Date(remote.judgeAt) : null,
          },
        });
      } catch {
        return record;
      }
    }));
    return ok(synced.map((record) => ({ ...record, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(), judgeAt: record.judgeAt?.toISOString() || null })));
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}
