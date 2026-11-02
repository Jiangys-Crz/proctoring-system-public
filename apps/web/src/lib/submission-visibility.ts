import type { ContestRule } from '@prisma/client';
import { isScoreboardFrozen, isXcpcScoring } from './contest-rules';

export function submissionVisibility(exam: { contestRule: ContestRule; endAt: Date; scoreboardFrozenAt?: Date | null; showTestCaseCount: boolean; showObjectiveScore: boolean }, problemType: string, now = new Date(), viewer?: {
  candidateId: string; submissionCandidateId: string; submittedAt: Date;
}) {
  // Match the public scoreboard's submission-time boundary. Owners retain
  // their normal verdict access; no judge metrics may reveal someone else's
  // frozen result, including when testcase counts are otherwise enabled.
  if (viewer && viewer.candidateId !== viewer.submissionCandidateId && isXcpcScoring(exam.contestRule)
    && isScoreboardFrozen(exam, now) && viewer.submittedAt > exam.scoreboardFrozenAt!) {
    return { result: false, score: false, counts: false, details: false };
  }
  const ended = now >= exam.endAt;
  const objective = problemType === 'objective';
  const ks = exam.contestRule === 'KS';
  const ksObjective = ks && objective;
  const hidden = ksObjective || (!ended && (
    exam.contestRule === 'OI'
    || exam.contestRule === 'LANQIAO'
    || (objective && !exam.showObjectiveScore)
  ));
  return {
    result: !hidden,
    score: !hidden && !['ACM', 'XCPC', 'KS'].includes(exam.contestRule),
    counts: !ksObjective && (ks || ended || (!objective && exam.showTestCaseCount) || (!hidden && exam.showTestCaseCount)),
    details: !ksObjective && (ks || ended || (!hidden && ['IOI', 'GPLT'].includes(exam.contestRule) && exam.showTestCaseCount)),
  };
}
