import crypto from 'node:crypto';
import { z } from 'zod';
import { proctorSessionEndAt, requireContestSession } from '@/lib/client-contest';
import { requestHydroLanguages } from '@/lib/hydro-contest';
import { allowedProblemLanguages, resolveJudgeLanguage } from '@/lib/exam-languages';
import { prisma } from '@/lib/db';
import { isLocalContest, serializeLocalSubmissions } from '@/lib/local-contest';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { canCandidateSubmit } from '@/lib/contest-format';
import { triggerDeferredJudge } from '@/lib/deferred-judge';
import { judgeObjectiveImmediately } from '@/lib/contest-rules';
import { isPublicTestExam } from '@/lib/public-test';
import { syncPublicTestProblem } from '@/lib/public-test-judge';
import { consumeRateLimit, UploadSecurityError } from '@/lib/upload-security';
import { AuthError } from '@/lib/auth';
import { verifyClientTokenForSession } from '@/lib/client-auth';
import { withSessionWrite, SessionWriteQueueError } from '@/lib/session-write';
import { createRequestAdmission, isRequestAdmissionError } from '@/lib/request-admission';

const shared = globalThis as typeof globalThis & { contestSubmitAdmission?: ReturnType<typeof createRequestAdmission> };
const acquireSubmit = shared.contestSubmitAdmission ??= createRequestAdmission(4, 128, 5000);

const SubmitSchema = z.object({
  sessionId: z.string().min(1),
  pid: z.number().int().positive(),
  lang: z.string().min(1).max(64),
  code: z.string().min(1).max(512 * 1024)
});

export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    release = await acquireSubmit(request.signal);
    // JSON may escape each allowed code character into six bytes. Bound the
    // wire body as well as the parsed code, before borrowing any DB connection.
    const input = await parseBody(request, SubmitSchema, 4 * 1024 * 1024);
    const authorized = await requireContestSession(request, input.sessionId, true);
    if (!authorized.ok) return fail(authorized.message, authorized.status);
    const session = authorized.session;
    const publicTest = await isPublicTestExam(session.examId);
    if (publicTest) {
      if (input.code.length > 64 * 1024) return fail('体验代码请控制在 64 KB 内', 413);
      await consumeRateLimit(`public-test-submit:${session.id}`, 10);
    }
    if (session.status !== 'IN_EXAM' || session.lockdown) return fail('考试尚未开始或当前会话不可提交', 400);
    if (new Date() >= proctorSessionEndAt(session)) return fail('考试已经结束，不能继续提交', 400);
    if (!canCandidateSubmit(session.exam, session.candidate)) {
      return fail('本场团队赛仅允许队长提交', 403);
    }

    if (isLocalContest(session.exam)) {
      // Submission authorization needs IDs and language rules, not every
      // statement, attachment list or private judge configuration in the exam.
      const problems = publicTest ? [await syncPublicTestProblem(session.examId)] : await prisma.examProblem.findMany({
        where: { examId: session.examId }, orderBy: { order: 'asc' },
        select: { id: true, order: true, hydroProblemId: true, problemType: true, languages: true },
      });
      const problem = problems.find((item) => Number.isSafeInteger(Number(item.hydroProblemId)) ? Number(item.hydroProblemId) === input.pid : item.order + 1 === input.pid);
      if (!problem) return fail('题目不存在', 404);
      const languages = ['objective', 'submit_answer'].includes(problem.problemType)
        ? []
        : await requestHydroLanguages();
      const allowed = allowedProblemLanguages(problem, session.exam.allowedLanguages, languages);
      if (!resolveJudgeLanguage(input.lang, allowed)) return fail('本场考试或该题目不允许使用所选语言', 400);
      const accepted = await withSessionWrite(session.id, async tx => {
        // Serialize with replacement logins, locks and session finish. Network
        // language/problem preparation above must never authorize a later write.
        await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${session.examId} FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${session.candidateId} FOR UPDATE`;
        const current = await tx.clientSession.findUnique({ where: { id: session.id }, include: { exam: true, candidate: true } });
        if (!current || !verifyClientTokenForSession(request, current, 'DESKTOP')) throw new AuthError('考试会话已失效，请重新登录', 401);
        if (current.examId !== session.examId || current.candidateId !== session.candidateId || current.exam.platform !== 'HYDRO') throw new AuthError('考试配置已改变，请刷新后重试', 409);
        if (current.status !== 'IN_EXAM' || current.lockdown || current.candidate.status === 'FINISHED') throw new AuthError('当前会话不可提交，请检查考试状态', 409);
        if (current.exam.platformContestId === 'local' && !current.exam.published) throw new AuthError('考试尚未发布', 409);
        if (!canCandidateSubmit(current.exam, current.candidate)) throw new AuthError('本场团队赛仅允许队长提交', 403);
        const currentProblem = await tx.examProblem.findFirst({ where: { id: problem.id, examId: current.examId }, select: {
          id: true, order: true, title: true, hydroProblemId: true, problemType: true, languages: true, score: true, scorePercent: true, hydroScore: true,
        } });
        if (!currentProblem || currentProblem.hydroProblemId !== problem.hydroProblemId || currentProblem.problemType !== problem.problemType) throw new AuthError('题目配置已改变，请刷新后重试', 409);
        const judgeLanguage = resolveJudgeLanguage(input.lang, allowedProblemLanguages(currentProblem, current.exam.allowedLanguages, languages));
        if (!judgeLanguage) throw new AuthError('本场考试或该题目不允许使用所选语言', 400);
        const acceptedAt = new Date();
        if (!(current.candidate.startedAt || current.startedAt) || acceptedAt < current.exam.startAt || acceptedAt >= proctorSessionEndAt(current)) throw new AuthError('当前不在允许递交的考试时间内', 409);
        const objective = ['objective', 'submit_answer'].includes(currentProblem.problemType);
        const judgeImmediately = !objective || judgeObjectiveImmediately(current.exam.contestRule, current.exam.showObjectiveScore, acceptedAt >= current.exam.endAt);
        const saved = await tx.contestSubmission.create({
          data: {
            id: `sub_${crypto.randomUUID()}`,
            examId: current.exam.id,
            candidateId: current.candidate.id,
            problemId: currentProblem.id,
            candidateExamNumber: current.candidate.examNumber,
            candidateName: current.candidate.name,
            teamName: current.candidate.teamName,
            teamMembers: current.candidate.teamMembers,
            teamMemberStudentIds: current.candidate.teamMemberStudentIds,
            actorKey: `${current.exam.examCode}:${current.candidate.examNumber}`,
            hydroRecordId: null,
            deferredJudge: true,
            judgeError: null,
            lang: judgeLanguage,
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
            createdAt: acceptedAt,
          },
        });
        return { saved, judgeImmediately, exam: { ...current.exam, problems: [currentProblem] }, candidateId: current.candidateId };
      }, { signal: request.signal });
      // Return the durable local record immediately. The worker submits it to
      // Hydro's Judger queue without blocking concurrent candidate requests.
      if (accepted.judgeImmediately) void triggerDeferredJudge();
      const { saved } = accepted;
      const [serialized] = serializeLocalSubmissions(accepted.exam, [saved], accepted.candidateId);
      const submission = { ...serialized, canViewDetail: true, detailsLoaded: true, isOwn: true };
      return ok({ ...submission, submissionId: saved.id }, { status: 201 });
    }

    return fail('该考试尚未配置本地题目，无法在监考系统保存测评记录', 400);
  } catch (error) {
    if (isRequestAdmissionError(error)) return fail('递交服务繁忙，请稍后重试', 503);
    if (error instanceof AuthError || error instanceof SessionWriteQueueError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    if (error instanceof UploadSecurityError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 502);
  } finally { release?.(); }
}

export const OPTIONS = options;
