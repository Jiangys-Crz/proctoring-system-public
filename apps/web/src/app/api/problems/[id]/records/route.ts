import { problemSubmissionOwner } from '@/lib/problem-submission-owner';
import { requireUser, AuthError } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { admittedProblemRecordRead, syncProblemSubmissionStatus } from '@/lib/problem-submission-sync';
import { fail, ok, toErrorMessage } from '@/lib/http';
import { canAccessHydroProblem } from '@/lib/permissions';

async function loadRecords(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    if (!await canAccessHydroProblem(user, id)) return fail('无权查看该题目的提交', 403);
    const owner = await problemSubmissionOwner(user);
    const records = await prisma.problemSubmission.findMany({
      where: { problemId: id, ...owner },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, hydroRecordId: true, status: true, statusText: true, judgeAt: true, updatedAt: true },
    });
    // The shared limiter bounds actual requests. Enqueue this one batch only:
    // repeated chunks could multiply Hydro's timeout during an outage.
    await Promise.allSettled(records.map(record => syncProblemSubmissionStatus(record)));
    if (_request.signal.aborted) return fail('请求已取消', 408);
    // Re-read even after a lost comparison: never return the old remote data
    // alongside the new Hydro ID, or a deleted/now-inaccessible record.
    const synced = records.length ? await prisma.problemSubmission.findMany({
      where: { id: { in: records.map(record => record.id) }, problemId: id, ...owner },
      orderBy: { createdAt: 'desc' },
    }) : [];
    return ok(synced.map((record) => ({ ...record, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(), judgeAt: record.judgeAt?.toISOString() || null })));
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return admittedProblemRecordRead(request, () => loadRecords(request, context));
}
