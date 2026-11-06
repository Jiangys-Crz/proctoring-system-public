import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { federationChange } from './exam-federation-store';
import { triggerDeferredJudge } from './deferred-judge';

const queueData = () => ({ ...federationChange(), status: 22, statusText: '已接收，等待重测', score: 0,
  hydroRecordId: null, deferredJudge: true, judgeForced: true, judgeClaimedAt: null, judgeAt: null, judgeError: null,
  totalTestCases: 0, passedTestCases: 0, time: 0, memory: 0, testCases: Prisma.JsonNull, subtasks: Prisma.JsonNull,
});
/** The HTTP request only enqueues. A lease/token prevents a stale judge response from replacing a newer action. */
export async function queueContestRejudge(examId: string, submissionId?: string) {
  const result = await prisma.contestSubmission.updateMany({ where: { examId, ...(submissionId ? { id: submissionId } : {}),
    ...(submissionId ? {} : { status: { not: 30 } }), judgeForced: false }, data: queueData() });
  if (result.count) void triggerDeferredJudge();
  return result.count;
}
