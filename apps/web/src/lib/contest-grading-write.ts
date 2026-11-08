import { prisma } from './db';
import { federationChange } from './exam-federation-store';
import { AuthError } from './auth';

export function requireGradingEnded(exam: { endAt: Date }, now = new Date()) {
  if (now < exam.endAt) throw new AuthError('整场考试结束后才能评卷', 403);
}

export async function gradeLatestSubmission(submission: { id: string; examId: string; candidateId: string; problemId: string; federationWriteToken: string }, score: number | null) {
  for (let attempt = 0; ; attempt++) {
    try { return await prisma.$transaction(async tx => {
      // Shared parent lock preserves Exam -> submission ordering with imports.
      await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${submission.examId} FOR SHARE`;
      const exam = await tx.exam.findUniqueOrThrow({ where: { id: submission.examId }, select: { startAt: true, endAt: true, contestRule: true } });
      if (exam.contestRule !== 'KS') throw new AuthError('只有 KS 赛制可以人工评分', 400);
      requireGradingEnded(exam);
      // Bank synchronization can update points without changing the parent
      // exam. Validate the actual problem under the same transaction as the grade.
      const [problem] = await tx.$queryRaw<Array<{examId:string;problemType:string;score:number}>>`SELECT examId, problemType, score FROM ExamProblem WHERE id = ${submission.problemId} AND examId = ${submission.examId} FOR SHARE`;
      if (!problem || problem.examId !== submission.examId) throw new AuthError('题目已改变，请刷新后重试', 409);
      if (problem.problemType === 'objective') throw new AuthError('客观题不允许人工改分', 400);
      if (score !== null && (!Number.isFinite(score) || score < 0 || score > problem.score)) throw new AuthError(`评分不能超过该题满分 ${problem.score}`, 400);
      const now = new Date();
      // Current/gap locks cover the candidate's newest valid run until commit.
      // Use the same time window as the leaderboard, including imported runs.
      const latest = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM ContestSubmission
        WHERE examId = ${submission.examId} AND candidateId = ${submission.candidateId} AND problemId = ${submission.problemId} AND status <> 30
        AND createdAt >= ${exam.startAt} AND createdAt < ${exam.endAt} AND createdAt <= ${now}
        ORDER BY createdAt DESC, BINARY id DESC LIMIT 1 FOR UPDATE`;
      if (latest[0]?.id !== submission.id) throw new AuthError('该记录已不是本题最后一次有效递交，请刷新后重试', 409);
      const result = await tx.contestSubmission.updateMany({ where: { id: submission.id, status: { not: 30 }, federationWriteToken: submission.federationWriteToken },
        data: { ...federationChange(), manualScore: score, manualScoreUpdatedAt: score === null ? null : new Date() } });
      if (!result.count) throw new AuthError('递交结果已被更新或取消，请刷新后重新评分', 409);
      return tx.contestSubmission.findUniqueOrThrow({ where: { id: submission.id }, select: { id: true, manualScore: true, manualScoreUpdatedAt: true } });
    }, { isolationLevel: 'RepeatableRead', maxWait: 3000, timeout: 10000 }); }
    catch (error) { if (attempt >= 2 || (error as { code?: string })?.code !== 'P2034') throw error; }
  }
}
