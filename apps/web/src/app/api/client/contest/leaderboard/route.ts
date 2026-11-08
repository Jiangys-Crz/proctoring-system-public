import { z } from 'zod';
import { proctorSessionEndAt, requireContestSession } from '@/lib/client-contest';
import { requestHydroContest } from '@/lib/hydro-contest';
import { calculateLeaderboards } from '@/lib/leaderboards';
import { admittedLeaderboardRequest } from '@/lib/heavy-read-admission';
import { readContestLeaderboardData, calculateContestLeaderboard } from '@/lib/contest-leaderboard-data';
import { isLocalContest } from '@/lib/local-contest';
import { isPublicTestExam } from '@/lib/public-test';
import { effectiveEnd, isScoreboardFrozen, isXcpcScoring } from '@/lib/contest-rules';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { isRequestAdmissionError } from '@/lib/request-admission';

const LeaderboardQuerySchema = z.object({
  sessionId: z.string().min(1).max(191),
  timePoint: z.number().finite().min(0).max(8.64e15).optional()
});

type LeaderboardData = {
  available: boolean;
  rows: Array<{
    rank: number;
    username: string;
    displayName: string;
    score: number;
    solved: number;
    penalty: number;
    problemScores: Array<number | null>;
  }>;
};

async function leaderboard(request: Request) {
  try {
    const input = await parseBody(request, LeaderboardQuerySchema, 8192);
    const authorized = await requireContestSession(request, input.sessionId, true);
    if (!authorized.ok) return fail(authorized.message, authorized.status);
    if (new Date() >= proctorSessionEndAt(authorized.session)) return ok({ available: false, rows: [] });
    if (isLocalContest(authorized.session.exam)) {
      const exam = authorized.session.exam;
      if (exam.contestRule === 'KS' || await isPublicTestExam(exam.id)) return ok({ available: false, rows: [] });
      const now = new Date(input.timePoint === undefined ? Date.now() : Math.min(Date.now(), input.timePoint));
      const emptyBoard = calculateLeaderboards(exam, exam.problems, [], [], now);
      if (!emptyBoard.available) return ok(emptyBoard);
      const data = await readContestLeaderboardData(exam.id, exam);
      if (!data.exam.published) return fail('考试尚未发布', 403);
      if (new Date() >= effectiveEnd(data.exam, authorized.session.candidate.startedAt || authorized.session.startedAt)) return ok({ available: false, rows: [] });
      return ok(calculateContestLeaderboard(data, input.timePoint));
    }
    // Legacy Hydro summaries have neither submission timestamps nor our freeze
    // boundary. Do not relay an unverifiable live aggregate during an XCPC
    // freeze; local contests retain their pre-freeze results and pending cells.
    if (isXcpcScoring(authorized.session.exam.contestRule) && isScoreboardFrozen(authorized.session.exam)) {
      return ok({ available: false, frozen: true, rows: [] });
    }
    const result = await requestHydroContest<LeaderboardData>(
      { ...authorized.session.exam, candidate: authorized.session.candidate },
      `/api/proctor/contest/${authorized.session.exam.platformContestId}/leaderboard`
    );
    return ok(result);
  } catch (error) {
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    if (isRequestAdmissionError(error)) {
      const response = fail('排行榜加载繁忙，请稍后重试', 503);
      response.headers.set('Retry-After', '2');
      return response;
    }
    return fail(toErrorMessage(error), 502);
  }
}

export const OPTIONS = options;

export async function POST(request: Request) { return admittedLeaderboardRequest(request, () => leaderboard(request)); }
