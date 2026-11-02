import { allowedProblemLanguages, examLanguageName, type HydroLanguage } from './exam-languages';
import { submissionVisibility } from './submission-visibility';
import { problemLimits } from './problem-limits';
import type { ContestRule, Exam, ExamProblem, Candidate, ContestSubmission, Prisma } from '@prisma/client';
import { flexibleExam, scaledSubmissionScore } from './contest-rules';
import { canReadContestAttachments } from './contest-attachment-policy';

export type LocalContestSession = {
  exam: Pick<Exam, 'id' | 'name' | 'startAt' | 'latestStartAt' | 'endAt' | 'durationMinutes' | 'contestRule' | 'contestType' | 'teamAccountMode' | 'rules' | 'scoreboardFrozenAt' | 'flexible' | 'allowedLanguages' | 'showTestCaseCount' | 'showObjectiveScore' | 'allowPrint' | 'printMode' | 'allowTeamSubmissionView' | 'leaderOnlySubmission'> & { problems: ExamProblem[] };
  candidate: Pick<Candidate, 'id' | 'examNumber' | 'name' | 'studentId' | 'teamName' | 'teamMembers' | 'teamMemberStudentIds' | 'school' | 'college' | 'major' | 'groupName' | 'seatNo' | 'startedAt' | 'isTeamLeader'>;
  roomName?: string | null;
  teamMemberNames?: string[];
  session: { id: string; status: string; startedAt: Date | null; lockdown: boolean; lockdownReason: string | null; latestStartAt: Date; flexible?: boolean; effectiveEndAt?: string };
  submissions: ContestSubmission[];
  languages: HydroLanguage[];
};

export type ClientContestData = {
  contest: {
    id: string;
    title: string;
    rule: 'acm' | 'oi' | 'ioi' | 'ks';
    sourceRule: ContestRule;
    content: string;
    beginAt: string;
    endAt: string;
    flexible: boolean;
    allowPrint: boolean;
    printMode: 'DISABLED' | 'VIRTUAL' | 'PHYSICAL';
    allowTeamSubmissionView: boolean;
    leaderOnlySubmission: boolean;
    contestType: 'INDIVIDUAL' | 'TEAM';
    showTestCaseCount: boolean;
    showObjectiveScore: boolean;
    latestStartAt: string;
    durationMinutes: number;
    candidateCount?: number;
    langs: Array<{ id: string; name: string }>;
  };
  problems: Array<{
    index: string;
    pid: number;
    title: string;
    score: number;
    content: string;
    html: boolean;
    problemType: string;
    config?: Record<string, unknown>;
    timeLimit?: number;
    memoryLimit?: number;
    languages: string[];
  }>;
  files: Array<{ name: string; size?: number; type: 'public' | 'private'; problemId?: string; problemIndex?: string }>;
  user: {
    uid: string; username: string; displayName?: string; examNumber: string; name?: string; school?: string; college?: string;
    major?: string; groupName?: string; roomName?: string; seatNo?: string; teamName?: string; teamMembers: string[]; studentId?: string; isTeamLeader?: boolean;
  };
  submissions: Array<{
    id: string;
    actorKey: string;
    problemIndex: string;
    problemTitle: string;
    status: number;
    statusText: string;
    score: number | null;
    totalTestCases: number | null;
    passedTestCases: number | null;
    resultHidden: boolean;
    scoreVisible: boolean;
    time: number;
    memory: number;
    lang: string;
    code: string;
    testCases: unknown[];
    subtasks?: Record<string, unknown>;
    createdAt: string;
    updatedAt?: string;
    canViewDetail?: boolean;
    detailsLoaded?: boolean;
    isOwn?: boolean;
    submittedBy?: { username: string; displayName?: string };
  }>;
};

export function localRule(rule: ContestRule): 'acm' | 'oi' | 'ioi' | 'ks' {
  if (rule === 'XCPC') return 'acm';
  if (rule === 'GPLT') return 'ioi';
  if (rule === 'LANQIAO') return 'oi';
  return rule.toLowerCase() as 'acm' | 'oi' | 'ioi' | 'ks';
}

function statusText(status: number) {
  if (status === 1) return 'Accepted';
  if ([0, 2, 3, 4, 5, 6].includes(status)) return 'Waiting';
  return 'Rejected';
}

function problemIndex(order: number) {
  let n = order + 1;
  let result = '';
  while (n > 0) {
    n -= 1;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

export const submissionSummarySelect = {
  id: true, candidateId: true, actorKey: true, problemId: true,
  candidateExamNumber: true, candidateName: true, teamName: true,
  status: true, statusText: true, score: true, totalTestCases: true,
  passedTestCases: true, time: true, memory: true, lang: true, createdAt: true, updatedAt: true,
} satisfies Prisma.ContestSubmissionSelect;

export const submissionDetailSelect = {
  ...submissionSummarySelect, code: true, testCases: true, subtasks: true,
} satisfies Prisma.ContestSubmissionSelect;

type SubmissionDetails = Omit<Prisma.ContestSubmissionGetPayload<{ select: typeof submissionDetailSelect }>, 'updatedAt'> & { updatedAt?: Date };
type SubmissionProblem = Pick<ExamProblem, 'id' | 'order' | 'title' | 'scorePercent' | 'hydroScore' | 'score' | 'problemType'>;
type SubmissionExam = Pick<Exam, 'contestRule' | 'endAt' | 'scoreboardFrozenAt' | 'showTestCaseCount' | 'showObjectiveScore'> & { problems: SubmissionProblem[] };

function serializeSubmission(submission: SubmissionDetails, problem: SubmissionProblem, exam: SubmissionExam, viewerCandidateId: string, now: Date) {
  const visibility = submissionVisibility(exam, problem.problemType, now, {
    candidateId: viewerCandidateId, submissionCandidateId: submission.candidateId, submittedAt: submission.createdAt,
  });
  const visibleTestCases = visibility.details && Array.isArray(submission.testCases)
    ? exam.contestRule === 'KS'
      ? submission.testCases.map(testCase => ({
          status: testCase && typeof testCase === 'object' && 'status' in testCase
            ? Number(testCase.status) || 0
            : 0,
        }))
      : submission.testCases
    : [];
  return {
    id: submission.id,
    actorKey: submission.actorKey,
    problemIndex: problemIndex(problem.order),
    problemTitle: problem.title,
    resultHidden: !visibility.result,
    scoreVisible: visibility.score,
    status: visibility.result ? submission.status : 0,
    statusText: visibility.result ? submission.statusText || statusText(submission.status) : 'Submitted',
    score: visibility.score ? scaledSubmissionScore(exam.contestRule, submission.score, problem.score ?? problem.scorePercent ?? 100, problem.hydroScore) : null,
    totalTestCases: visibility.counts ? submission.totalTestCases : null,
    passedTestCases: visibility.counts ? submission.passedTestCases : null,
    // Runtime and memory are part of the visible judge result, not privileged
    // testcase detail. Hiding details must not turn completed metrics into zero.
    time: visibility.result ? submission.time : 0,
    memory: visibility.result ? submission.memory : 0,
    lang: submission.lang,
    code: submission.code,
    testCases: visibleTestCases,
    subtasks: visibility.details && exam.contestRule !== 'KS' && submission.subtasks && typeof submission.subtasks === 'object' ? submission.subtasks as Record<string, unknown> : {},
    createdAt: submission.createdAt.toISOString(),
    updatedAt: (submission.updatedAt || submission.createdAt).toISOString(),
    submittedBy: {
      username: submission.candidateExamNumber || submission.actorKey,
      displayName: submission.candidateName || submission.teamName || submission.candidateExamNumber || undefined,
    },
  };
}

// The one-second submission poll must not rebuild the entire contest or fetch
// Hydro's language list just to serialize the records it returns.
export function serializeLocalSubmissions(exam: SubmissionExam, submissions: SubmissionDetails[], viewerCandidateId: string | ReadonlySet<string>, now = new Date()) {
  const problemsById = new Map(exam.problems.map(problem => [problem.id, problem]));
  return submissions.flatMap(submission => {
    const problem = problemsById.get(submission.problemId);
    // A set may only come from an authorized account/team scope. Members with
    // explicitly shared history see their own team's verdict during a freeze.
    const ownerId = typeof viewerCandidateId === 'string' ? viewerCandidateId
      : viewerCandidateId.has(submission.candidateId) ? submission.candidateId : '';
    return problem ? [serializeSubmission(submission, problem, exam, ownerId, now)] : [];
  });
}

export function serializeLocalContest(input: LocalContestSession): ClientContestData {
  const { exam, candidate, submissions, session } = input;
  const started = canReadContestAttachments({ ...session, candidate, exam });
  const languages = new Set(exam.problems.flatMap(problem => allowedProblemLanguages(problem, exam.allowedLanguages, input.languages)));
  const langList = input.languages.filter(lang => languages.has(lang.id)).map(language => ({ ...language, name: examLanguageName(language) }));
  if (languages.has('_')) langList.push({ id: '_', name: '答案提交' });
  return {
    contest: {
      id: exam.id,
      title: exam.name,
      rule: localRule(exam.contestRule),
      sourceRule: exam.contestRule,
      content: exam.rules || '',
      beginAt: exam.startAt.toISOString(),
      endAt: exam.endAt.toISOString(),
      flexible: flexibleExam(exam),
      allowPrint: exam.allowPrint,
      printMode: exam.printMode,
      allowTeamSubmissionView: exam.allowTeamSubmissionView,
      leaderOnlySubmission: exam.leaderOnlySubmission,
      contestType: exam.contestType,
      showTestCaseCount: exam.showTestCaseCount,
      showObjectiveScore: exam.showObjectiveScore,
      latestStartAt: exam.latestStartAt.toISOString(),
      durationMinutes: exam.durationMinutes,
      langs: langList,
    },
    problems: exam.problems.map((problem) => {
      const langs = allowedProblemLanguages(problem, exam.allowedLanguages, input.languages);
      const numericPid = Number(problem.hydroProblemId);
      const config = problem.config && typeof problem.config === 'object' && !Array.isArray(problem.config)
        ? problem.config as Record<string, unknown>
        : {};
      const limits = problemLimits(config);
      return {
        index: problemIndex(problem.order),
        pid: Number.isSafeInteger(numericPid) ? numericPid : problem.order + 1,
        problemId: problem.hydroProblemId,
        title: started ? problem.title : `题目 ${problemIndex(problem.order)}`,
        score: started ? problem.score : 0,
        content: started ? problem.content : '',
        html: started ? problem.html : false,
        problemType: problem.problemType,
        // Judge configuration may contain objective answers; it is never public.
        config: { type: problem.problemType },
        timeLimit: started ? problem.timeLimitMs || limits.timeLimitMs || undefined : undefined,
        memoryLimit: started ? problem.memoryLimitMb || limits.memoryLimitMb || undefined : undefined,
        languages: langs,
      };
    }),
    files: !started ? [] : exam.problems.flatMap((problem) => {
      if (!Array.isArray(problem.files)) return [];
      return problem.files
        .filter((file): file is { name: string; size?: number } => Boolean(file && typeof file === 'object' && typeof (file as { name?: unknown }).name === 'string'))
        .map((file) => ({ ...file, type: 'public' as const, problemId: problem.hydroProblemId, problemIndex: problemIndex(problem.order) }));
    }),
    user: {
      uid: candidate.id,
      username: candidate.examNumber,
      displayName: candidate.name || candidate.teamName || candidate.examNumber,
      examNumber: candidate.examNumber,
      name: candidate.name || '',
      school: candidate.school || '',
      college: candidate.college || '',
      major: candidate.major || '',
      groupName: candidate.groupName || '',
      roomName: input.roomName || '',
      seatNo: candidate.seatNo || '',
      teamName: candidate.teamName || '',
      teamMembers: input.teamMemberNames || [],
      studentId: candidate.studentId || '',
      isTeamLeader: candidate.isTeamLeader,
    },
    submissions: serializeLocalSubmissions(exam, submissions, candidate.id),
  };
}

export function isLocalContest(exam: { problems?: readonly unknown[] }) {
  return Boolean(exam.problems?.length);
}
