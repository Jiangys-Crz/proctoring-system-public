import { proctorSessionEndAt, requireContestSession } from '@/lib/client-contest';
import { readClientSubmissionHistory } from '@/lib/client-submission-history';
import { serializeContestState } from '@/lib/client-contest-state';
import { requestHydroContest, requestHydroLanguages } from '@/lib/hydro-contest';
import { prisma } from '@/lib/db';
import { isLocalContest, serializeLocalContest } from '@/lib/local-contest';
import { options, fail, ok, toErrorMessage } from '@/lib/http';
import { canCandidateSubmit, canViewTeamSubmissions } from '@/lib/contest-format';
import { candidateStartDeadline, flexibleExam } from '@/lib/contest-rules';
import { isPublicTestExam } from '@/lib/public-test';
import { syncPublicTestProblem } from '@/lib/public-test-judge';

type HydroContestData = {
  contest: {
    id: string;
    title: string;
    rule: string;
    sourceRule?: string;
    content: string;
    beginAt: string;
    endAt: string;
    langs: Array<{ id: string; name: string }>;
  };
  problems: Array<{
    index: string;
    pid: number;
    title: string;
    score: number;
    content: string;
    html?: boolean;
    timeLimit?: number;
    memoryLimit?: number;
    languages: string[];
  }>;
  files: Array<{ name: string; size?: number; type: 'public' | 'private' }>;
  user: { uid: number; username: string; displayName?: string; school?: string; studentId?: string };
  submissions: Array<{
    id: string;
    problemIndex: string;
    problemTitle: string;
    status: number;
    statusText: string;
    score: number;
    time: number;
    memory: number;
    lang: string;
    code: string;
    testCases: unknown[];
    subtasks?: Record<string, unknown>;
    createdAt: string;
  }>;
};

function splitMemberText(value: string | null | undefined) {
  return String(value || '').split(/[、,，;；\n\r]+/).map(item => item.trim()).filter(Boolean);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId') || '';
    if (!sessionId) return fail('缺少 sessionId', 400);
    const authorized = await requireContestSession(request, sessionId);
    if (!authorized.ok) return fail(authorized.message, authorized.status);

    const session = authorized.session;
    if (await isPublicTestExam(session.examId)) session.exam.problems = [await syncPublicTestProblem(session.examId)];
    const [candidateCount, room, teamCandidates] = await Promise.all([
      prisma.candidate.count({ where: { examId: session.exam.id } }),
      prisma.examRoom.findFirst({
        where: { examId: session.exam.id, candidates: { some: { candidateId: session.candidate.id } } },
        select: { name: true },
      }),
      session.exam.contestType === 'TEAM' && session.candidate.teamName
        ? prisma.candidate.findMany({
            where: { examId: session.exam.id, teamName: session.candidate.teamName },
            select: { name: true, isTeamLeader: true, examNumber: true },
            orderBy: [{ isTeamLeader: 'desc' }, { examNumber: 'asc' }],
          })
        : Promise.resolve([]),
    ]);
    const teamMemberNames = Array.from(new Set([
      ...teamCandidates.map(candidate => candidate.name || candidate.examNumber),
      ...splitMemberText(session.candidate.teamMembers),
    ]));
    const candidateUser = {
      uid: session.candidate.id,
      username: session.candidate.examNumber,
      displayName: session.candidate.name || session.candidate.teamName || session.candidate.examNumber,
      examNumber: session.candidate.examNumber,
      name: session.candidate.name || '',
      school: session.candidate.school || '',
      college: session.candidate.college || '',
      major: session.candidate.major || '',
      groupName: session.candidate.groupName || '',
      roomName: room?.name || '',
      seatNo: session.candidate.seatNo || '',
      teamName: session.candidate.teamName || '',
      teamMembers: teamMemberNames,
      studentId: session.candidate.studentId || '',
      isTeamLeader: session.candidate.isTeamLeader,
    };
    if (isLocalContest(session.exam)) {
      let languagesError = '';
      const [languages, submissions] = await Promise.all([
        requestHydroLanguages().catch(error => { languagesError = toErrorMessage(error); return []; }),
        readClientSubmissionHistory(session, searchParams.get('summaryOnly') === 'true'),
      ]);
      const local = serializeLocalContest({
        exam: session.exam,
        candidate: session.candidate,
        session: {
          id: session.id,
          status: session.status,
          startedAt: session.startedAt,
          lockdown: session.lockdown,
          lockdownReason: session.lockdownReason,
          latestStartAt: candidateStartDeadline(session.exam, session.candidate.lateStartAllowedAt),
          flexible: flexibleExam(session.exam),
          effectiveEndAt: proctorSessionEndAt(session).toISOString(),
        },
        roomName: room?.name,
        teamMemberNames,
        submissions: [],
        languages,
      });
      return ok({
        ...local,
        submissions,
        revision: serializeContestState(session).revision,
        contest: { ...local.contest, languagesError, endAt: proctorSessionEndAt(session).toISOString(), latestStartAt: candidateStartDeadline(session.exam, session.candidate.lateStartAllowedAt).toISOString(), candidateCount, allowTeamSubmissionView: canViewTeamSubmissions(session.exam) },
        session: {
          id: session.id,
          status: session.status,
          startedAt: session.startedAt,
          lockdown: session.lockdown,
          lockdownReason: session.lockdownReason,
          latestStartAt: candidateStartDeadline(session.exam, session.candidate.lateStartAllowedAt),
          flexible: flexibleExam(session.exam),
          effectiveEndAt: proctorSessionEndAt(session).toISOString(),
          canSubmit: canCandidateSubmit(session.exam, session.candidate),
          canViewSubmissions: true,
        },
        user: candidateUser,
      });
    }
    const hydro = await requestHydroContest<HydroContestData>({ ...session.exam, candidate: session.candidate }, `/api/proctor/contest/${session.exam.platformContestId}`);
    const hydroEndAt = new Date(hydro.contest.endAt);
    const sessionEndAt = proctorSessionEndAt(session);
    const effectiveEndAt = Number.isNaN(hydroEndAt.getTime()) || sessionEndAt < hydroEndAt ? sessionEndAt : hydroEndAt;
    return ok({
      ...hydro,
      revision: serializeContestState(session).revision,
      user: candidateUser,
      // Hydro uses a shared judge account. The proctoring database is the
      // only source of truth for candidate submission history.
      submissions: [],
      contest: {
        ...hydro.contest,
        content: session.exam.rules?.trim() ? session.exam.rules : hydro.contest.content,
        endAt: effectiveEndAt.toISOString(),
        allowPrint: session.exam.allowPrint,
        printMode: session.exam.printMode,
        allowTeamSubmissionView: false,
        leaderOnlySubmission: session.exam.leaderOnlySubmission,
        contestType: session.exam.contestType,
        flexible: flexibleExam(session.exam),
        showTestCaseCount: session.exam.showTestCaseCount,
        showObjectiveScore: session.exam.showObjectiveScore,
        latestStartAt: candidateStartDeadline(session.exam, session.candidate.lateStartAllowedAt).toISOString(),
        durationMinutes: session.exam.durationMinutes,
        candidateCount
      },
      session: {
        id: session.id,
        status: session.status,
        startedAt: session.startedAt,
        lockdown: session.lockdown,
        lockdownReason: session.lockdownReason,
        latestStartAt: candidateStartDeadline(session.exam, session.candidate.lateStartAllowedAt),
        canSubmit: canCandidateSubmit(session.exam, session.candidate),
        canViewSubmissions: true,
      },
      files: hydro.files.map((file) => ({
        ...file
      }))
    });
  } catch (error) {
    return fail(toErrorMessage(error), 502);
  }
}

export const OPTIONS = options;
