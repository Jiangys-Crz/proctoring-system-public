import crypto from 'node:crypto';
import { z } from 'zod';
import { proctorSessionEndAt, requireContestSession } from '@/lib/client-contest';
import { requestHydroLanguages } from '@/lib/hydro-contest';
import { allowedProblemLanguages } from '@/lib/exam-languages';
import { prisma } from '@/lib/db';
import { isLocalContest, serializeLocalSubmissions } from '@/lib/local-contest';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { canCandidateSubmit } from '@/lib/contest-format';
import { triggerDeferredJudge } from '@/lib/deferred-judge';
import { judgeObjectiveImmediately } from '@/lib/contest-rules';
import { isPublicTestExam } from '@/lib/public-test';
import { syncPublicTestProblem } from '@/lib/public-test-judge';
import { consumeRateLimit, UploadSecurityError } from '@/lib/upload-security';

const SubmitSchema = z.object({
  sessionId: z.string().min(1),
  pid: z.number().int().positive(),
  lang: z.string().min(1).max(64),
  code: z.string().min(1).max(512 * 1024)
});

export async function POST(request: Request) {
  try {
    const input = await parseBody(request, SubmitSchema);
    const authorized = await requireContestSession(request, input.sessionId);
    if (!authorized.ok) return fail(authorized.message, authorized.status);
    const session = authorized.session;
    const publicTest = await isPublicTestExam(session.examId);
    if (publicTest) {
      if (input.code.length > 64 * 1024) return fail('体验代码请控制在 64 KB 内', 413);
      await consumeRateLimit(`public-test-submit:${session.id}`, 10);
    }
    if (session.status !== 'IN_EXAM') return fail('考试尚未开始或当前会话不可提交', 400);
    if (new Date() >= proctorSessionEndAt(session)) return fail('考试已经结束，不能继续提交', 400);
    if (!canCandidateSubmit(session.exam, session.candidate)) {
      return fail('本场团队赛仅允许队长提交', 403);
    }

    if (isLocalContest(session.exam)) {
      if (publicTest) session.exam.problems = [await syncPublicTestProblem(session.examId)];
      const problem = session.exam.problems.find((item) => Number.isSafeInteger(Number(item.hydroProblemId)) ? Number(item.hydroProblemId) === input.pid : item.order + 1 === input.pid);
      if (!problem) return fail('题目不存在', 404);
      const languages = ['objective', 'submit_answer'].includes(problem.problemType)
        ? []
        : await requestHydroLanguages();
      const allowed = allowedProblemLanguages(problem, session.exam.allowedLanguages, languages);
      if (!allowed.includes(input.lang)) return fail('本场考试或该题目不允许使用所选语言', 400);
      const objective = ['objective', 'submit_answer'].includes(problem.problemType);
      const judgeImmediately = !objective || judgeObjectiveImmediately(session.exam.contestRule, session.exam.showObjectiveScore, new Date() >= session.exam.endAt);
      const saved = await prisma.contestSubmission.create({
        data: {
          id: `sub_${crypto.randomUUID()}`,
          examId: session.exam.id,
          candidateId: session.candidate.id,
          problemId: problem.id,
          candidateExamNumber: session.candidate.examNumber,
          candidateName: session.candidate.name,
          teamName: session.candidate.teamName,
          teamMembers: session.candidate.teamMembers,
          teamMemberStudentIds: session.candidate.teamMemberStudentIds,
          actorKey: `${session.exam.examCode}:${session.candidate.examNumber}`,
          hydroRecordId: null,
          deferredJudge: true,
          judgeError: null,
          lang: input.lang,
          code: input.code,
          status: 22,
          statusText: judgeImmediately ? '已接收，等待测评' : '等待考试结束后判题',
          score: 0,
          totalTestCases: 0,
          passedTestCases: 0,
          time: 0,
          memory: 0,
          testCases: [],
          subtasks: {},
          judgeAt: null,
        },
      });
      // Return the durable local record immediately. The worker submits it to
      // Hydro's Judger queue without blocking concurrent candidate requests.
      if (judgeImmediately) void triggerDeferredJudge();
      const [serialized] = serializeLocalSubmissions(session.exam, [saved], session.candidate.id);
      const submission = { ...serialized, canViewDetail: true, detailsLoaded: true, isOwn: true };
      return ok({ ...submission, submissionId: saved.id }, { status: 201 });
    }

    return fail('该考试尚未配置本地题目，无法在监考系统保存测评记录', 400);
  } catch (error) {
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    if (error instanceof UploadSecurityError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 502);
  }
}

export const OPTIONS = options;
