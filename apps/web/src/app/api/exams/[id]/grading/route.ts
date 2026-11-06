import { gradeLatestSubmission } from '@/lib/contest-grading-write';
import { z } from 'zod';
import { AuthError, requireUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { calculateLeaderboards } from '@/lib/leaderboards';
import { canManageExam } from '@/lib/permissions';
import { compareSubmissionOrder, IGNORED_SUBMISSION_STATUS, problemLabel, scaledSubmissionScore } from '@/lib/contest-rules';
import { fail, ok, options, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const GradeSchema = z.object({
  submissionId: z.string().min(1),
  score: z.number().finite().min(0).nullable(),
});

async function gradingExam(id: string) {
  return prisma.exam.findUnique({
    where: { id },
    include: {
      problems: {
        orderBy: { order: 'asc' },
        select: {
          id: true, order: true, hydroProblemId: true, title: true, content: true, html: true,
          problemType: true, hydroScore: true, scorePercent: true, score: true,
        },
      },
      candidates: {
        orderBy: [{ seatNo: 'asc' }, { examNumber: 'asc' }],
        select: {
          id: true, examNumber: true, name: true, teamName: true, groupName: true,
          school: true, college: true, ranked: true,
        },
      },
    },
  });
}

async function gradingSubmissions(id: string, exam: { startAt: Date; endAt: Date }, now: Date) {
  return prisma.contestSubmission.findMany({
    where: { examId: id, status: { not: IGNORED_SUBMISSION_STATUS }, createdAt: { gte: exam.startAt, lt: exam.endAt, lte: now } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true, candidateId: true, problemId: true, status: true, statusText: true,
      score: true, manualScore: true, manualScoreUpdatedAt: true, lang: true, code: true,
      hydroRecordId: true, judgeAt: true, createdAt: true,
    },
  });
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    if (!(await canManageExam(user, id))) return fail('无权评阅该考试', 403);
    const exam = await gradingExam(id);
    if (!exam) return fail('考试不存在', 404);
    if (exam.contestRule !== 'KS') return fail('只有 KS 赛制可以使用评卷功能', 400);

    // Poll the same durable results as candidate history; the background judge
    // refreshes them without making review pages wait on Hydro availability.
    const now = new Date();
    const submissions = await gradingSubmissions(id, exam, now);

    const latest = new Map<string, (typeof submissions)[number]>();
    for (const submission of submissions) {
      const key = `${submission.candidateId}:${submission.problemId}`;
      const previous = latest.get(key);
      if (!previous || compareSubmissionOrder(submission, previous) > 0) latest.set(key, submission);
    }
    const ranking = calculateLeaderboards(exam, exam.problems, exam.candidates, submissions, now, true);
    const rankByExamNumber = new Map(ranking.rows.map(row => [row.username, row]));
    const rows = exam.candidates.map(candidate => {
      const ranked = rankByExamNumber.get(candidate.examNumber);
      return {
        candidate: {
          id: candidate.id,
          examNumber: candidate.examNumber,
          name: candidate.name,
          teamName: candidate.teamName,
          groupName: candidate.groupName,
          institution: candidate.school || candidate.college || '',
        },
        rank: ranked?.rank ?? null,
        totalScore: ranked?.score ?? 0,
        cells: exam.problems.map(problem => {
          const submission = latest.get(`${candidate.id}:${problem.id}`);
          if (!submission) return null;
          const systemScore = scaledSubmissionScore('KS', submission.score, problem.score, problem.hydroScore);
          return {
            submissionId: submission.id,
            status: submission.status,
            statusText: submission.statusText,
            systemScore,
            manualScore: submission.manualScore,
            effectiveScore: submission.manualScore ?? systemScore,
            manualScoreUpdatedAt: submission.manualScoreUpdatedAt,
            lang: submission.lang,
            code: submission.code,
            createdAt: submission.createdAt,
          };
        }),
      };
    }).sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)
      || (a.candidate.examNumber < b.candidate.examNumber ? -1 : a.candidate.examNumber > b.candidate.examNumber ? 1 : 0));

    return ok({
      exam: { id: exam.id, name: exam.name, examCode: exam.examCode, contestRule: exam.contestRule },
      problems: exam.problems.map(problem => ({ ...problem, label: problemLabel(problem.order) })),
      rows,
    });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    if (!(await canManageExam(user, id))) return fail('无权评阅该考试', 403);
    const input = await parseBody(request, GradeSchema);
    const submission = await prisma.contestSubmission.findFirst({
      where: { id: input.submissionId, examId: id, status: { not: IGNORED_SUBMISSION_STATUS } },
      include: {
        exam: { select: { contestRule: true } },
        problem: { select: { id: true, score: true, problemType: true } },
      },
    });
    if (!submission) return fail('递交记录不存在或成绩已取消', 404);
    if (submission.exam.contestRule !== 'KS') return fail('只有 KS 赛制可以人工评分', 400);
    if (submission.problem.problemType === 'objective') return fail('客观题不允许人工改分', 400);
    if (input.score !== null && input.score > submission.problem.score) {
      return fail(`评分不能超过该题满分 ${submission.problem.score}`, 400);
    }
    const manualScore = input.score === null ? null : Math.round(input.score * 100) / 100;
    const updated = await gradeLatestSubmission(submission, manualScore);
    return ok(updated);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
