import { leaderboardGroups, isFemale, isXcpcLeaderboard } from '@cwnupaa/proctor-shared/leaderboard';
import { gpltTeamRows, scoreRows, type RankingCandidate, type RankingProblem, type ScoreRecord, type Timing } from './contest-rules';

type RankingExam = Timing & {
  contestType: 'INDIVIDUAL' | 'TEAM';
  scoreboardFrozenAt?: Date | null;
};
const teamIdentity = (candidate: RankingCandidate) => JSON.stringify([
  candidate.teamName ? 'team' : 'candidate', candidate.teamName || candidate.examNumber,
]);

export function calculateLeaderboards(
  exam: RankingExam,
  problems: RankingProblem[],
  candidates: RankingCandidate[],
  records: ScoreRecord[],
  now = new Date(),
  admin = false,
) {
  const ranked = candidates.filter(candidate => candidate.ranked !== false || ['GPLT', 'LANQIAO'].includes(exam.contestRule) || isXcpcLeaderboard(exam.contestRule));
  if (exam.contestRule === 'GPLT') {
    const personal = scoreRows(exam, problems, ranked, records, now, admin);
    return {
      ...personal,
      rows: personal.rows,
      boards: [
        { key: 'personal' as const, label: '个人排名', rows: personal.rows },
        { key: 'team' as const, label: '团队排名', rows: gpltTeamRows(personal.rows) },
      ],
      groups: [...leaderboardGroups(exam.contestRule)],
    };
  }

  if (exam.contestType !== 'TEAM') {
    const result = scoreRows(exam, problems, ranked, records, now, admin);
    return { ...result, boards: [{ key: 'main' as const, label: '排行榜', rows: result.rows }],
      groups: [...leaderboardGroups(exam.contestRule)] };
  }

  // Different installations have different candidate IDs and insertion order.
  // Pick team representatives and assemble member names by the shared exam number.
  candidates = [...candidates].sort((a, b) => a.examNumber < b.examNumber ? -1 : a.examNumber > b.examNumber ? 1 : 0);
  const representatives = new Map<string, string>();
  const candidateIds = new Map<string, string>();
  const membersByTeam = new Map<string, RankingCandidate[]>();
  for (const candidate of candidates) {
    const key = teamIdentity(candidate);
    if (!representatives.has(key)) representatives.set(key, candidate.id);
    candidateIds.set(candidate.id, representatives.get(key)!);
    const members = membersByTeam.get(key);
    if (members) members.push(candidate); else membersByTeam.set(key, [candidate]);
  }
  const representativeIds = new Set(representatives.values());
  const result = scoreRows(
    exam,
    problems,
    candidates.filter(candidate => representativeIds.has(candidate.id) && (candidate.ranked !== false || exam.contestRule === 'LANQIAO' || isXcpcLeaderboard(exam.contestRule))).map(candidate => {
      const members = membersByTeam.get(teamIdentity(candidate))!;
      return { ...candidate, teamMembers: candidate.teamMembers || members.map(member => member.name).filter(Boolean).join(', '),
        gender: members.every(member => isFemale(member.gender)) ? '女' : null };
    }),
    records.map(record => ({ ...record, candidateId: candidateIds.get(record.candidateId) || record.candidateId })),
    now,
    admin,
  );
  return { ...result, boards: [{ key: 'main' as const, label: '排行榜', rows: result.rows }],
    groups: [...leaderboardGroups(exam.contestRule)] };
}
