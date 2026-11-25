import type { ReactionLogoMatchBy } from '@prisma/client';

export function isContestLiveSupported(platform: string, rule: string) {
  return platform === 'HYDRO_BROWSER' || platform === 'NOVAJUDGE' || (platform === 'HYDRO' && (rule === 'XCPC' || rule === 'ACM'));
}

export type ContestLiveProblem = { id: string; label: string; name: string; color: string | null; maxScore: number };

export type ContestLiveTeam = {
  id: string;
  account: string;
  accounts: string[];
  candidateIds: string[];
  name: string;
  organization: string;
  group: string;
  members: string[];
  isOutOfContest: boolean;
};

export type ContestLiveCell = {
  problemId: string;
  score: number | null;
  accepted: boolean;
  wrong: number;
  pending: number;
  frozen?: boolean;
  seconds: number;
  firstBlood: boolean;
};

export type ContestLiveStanding = {
  teamId: string;
  rank: number | null;
  solved: number;
  score: number;
  penaltySeconds: number;
  medal: 'Gold' | 'Silver' | 'Bronze' | null;
  cells: ContestLiveCell[];
};

export type ContestLiveSubmission = {
  id: string;
  teamId: string;
  problemId: string;
  submittedAt: string;
  seconds: number;
  verdict: string | null;
  frozen?: boolean;
  testedPart?: number;
  score: number | null;
  firstBlood: boolean;
};

export type ContestLiveStatistics = {
  problemId: string;
  accepted: number;
  rejected: number;
  pending: number;
  teamsAccepted: number;
  teamsRejected: number;
  teamsPending: number;
};
export type ContestLiveScoreboardVersion = 'normal' | 'optimistic' | 'pessimistic';
export type ContestLiveFreeze = { at: string | null; revealed: boolean };

export function validContestFreezeTime(at: string | null, timing: { startAt: Date; endAt: Date }) {
  if (!at) return false;
  const timestamp = Date.parse(at);
  return timestamp > +timing.startAt && timestamp < +timing.endAt;
}

export type ContestLiveData = {
  exam: {
    id: string;
    name: string;
    source: 'local' | 'hydro' | 'nova';
    startAt: string;
    endAt: string;
    beforeStart: boolean;
    freezeAt: string | null;
    frozen: boolean;
    scoring: 'icpc' | 'score';
    reactionLogoMatchBy?: ReactionLogoMatchBy;
  };
  problems: ContestLiveProblem[];
  teams: ContestLiveTeam[];
  standings: ContestLiveStanding[];
  submissions: ContestLiveSubmission[];
  timeline: ContestLiveSubmission[];
  statistics: ContestLiveStatistics[];
  updatedAt: string | null;
  sourceError: string | null;
};
