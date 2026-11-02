import type { ContestRule, ContestType, TeamAccountMode } from '@prisma/client';

type FormatSettings = {
  contestRule: ContestRule;
  contestType: ContestType;
  teamAccountMode: TeamAccountMode;
  allowTeamSubmissionView: boolean;
  leaderOnlySubmission: boolean;
};

export function isXcpcRule(rule: ContestRule | string) {
  return rule === 'XCPC' || rule === 'ACM';
}

export function normalizeContestFormat<T extends FormatSettings>(input: T): T {
  if (input.contestRule === 'GPLT') {
    return { ...input, contestType: 'TEAM', teamAccountMode: 'MEMBER_ACCOUNTS', leaderOnlySubmission: false };
  }
  if (isXcpcRule(input.contestRule)) {
    if (input.contestType === 'INDIVIDUAL') {
      return { ...input, teamAccountMode: 'MEMBER_ACCOUNTS', allowTeamSubmissionView: false, leaderOnlySubmission: false };
    }
    if (input.teamAccountMode === 'MEMBER_ACCOUNTS') {
      return { ...input, leaderOnlySubmission: true };
    }
    return { ...input, leaderOnlySubmission: false };
  }
  if (input.contestType === 'INDIVIDUAL') {
    return { ...input, teamAccountMode: 'MEMBER_ACCOUNTS', allowTeamSubmissionView: false, leaderOnlySubmission: false };
  }
  return { ...input };
}

export function canCandidateSubmit(exam: Pick<FormatSettings, 'contestRule' | 'contestType' | 'teamAccountMode' | 'leaderOnlySubmission'>, candidate: { isTeamLeader: boolean }) {
  if (isXcpcRule(exam.contestRule) && exam.contestType === 'TEAM' && exam.teamAccountMode === 'MEMBER_ACCOUNTS') return candidate.isTeamLeader;
  return exam.contestType !== 'TEAM' || !exam.leaderOnlySubmission || candidate.isTeamLeader;
}

export function canViewTeamSubmissions(exam: Pick<FormatSettings, 'contestRule' | 'contestType' | 'teamAccountMode' | 'allowTeamSubmissionView'>) {
  // Shared accounts already own their records through one candidate identity;
  // this switch only grants access across separate member accounts.
  return exam.contestType === 'TEAM' && exam.teamAccountMode === 'MEMBER_ACCOUNTS' && exam.allowTeamSubmissionView === true;
}
