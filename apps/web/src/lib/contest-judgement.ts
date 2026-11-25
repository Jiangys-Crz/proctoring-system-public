import type { ContestSubmission, Prisma } from '@prisma/client';
import { digest } from './exam-federation-protocol';

// Manual grades and transport revisions do not change the underlying judge
// task. Compare only the judgement before retaining any node-local handles.
export const judgementSelect = {
  lang: true, status: true, statusText: true, score: true,
  totalTestCases: true, passedTestCases: true, time: true, memory: true,
  testCases: true, subtasks: true, judgeAt: true,
} satisfies Prisma.ContestSubmissionSelect;

type Judgement = Omit<Pick<ContestSubmission, keyof typeof judgementSelect>, 'judgeAt' | 'testCases' | 'subtasks'> & {
  judgeAt: Date | string | null; testCases: unknown; subtasks: unknown;
};

export function sameJudgement(a: Judgement, b: Judgement): boolean {
  return a.lang === b.lang && a.status === b.status && a.statusText === b.statusText && a.score === b.score
    && a.totalTestCases === b.totalTestCases && a.passedTestCases === b.passedTestCases
    && a.time === b.time && a.memory === b.memory
    && (a.judgeAt === null ? b.judgeAt === null : b.judgeAt !== null && +new Date(a.judgeAt) === +new Date(b.judgeAt))
    && digest([a.testCases, a.subtasks]) === digest([b.testCases, b.subtasks]);
}
