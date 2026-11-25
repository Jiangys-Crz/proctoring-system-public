import { calculateLeaderboards } from './leaderboards';
import { makeContestDisplayCharts } from './contest-display-charts';
import type { ContestDisplayChartScene, ContestDisplayCharts } from './contest-display-contract';
import { compareSubmissionOrder, isXcpcScoring, scaledSubmissionScore, type RankingCandidate, type Rule, type ScoreRecord, type Timing } from './contest-rules';
import type { ContestLiveData, ContestLiveFreeze, ContestLiveProblem, ContestLiveScoreboardVersion } from './contest-live-contract';
import { contestTeamNameFields, defaultContestTeamNameTemplate, formatContestTeamName } from './contest-team-name';

export type LiveRosterEntry = RankingCandidate & {
  hydroAccount: string | null;
  school: string | null;
};
export type LiveProblem = ContestLiveProblem & { hydroScore: number; objective?: boolean };
export type LiveRun = ScoreRecord & { verdict: string; language?: string; judgedAt?: Date | null; testedPart?: number };
export type LiveExam = Timing & {
  id: string;
  name: string;
  contestType: 'INDIVIDUAL' | 'TEAM';
  reactionLogoMatchBy?: ContestLiveData['exam']['reactionLogoMatchBy'];
  scoreboardFrozenAt: Date | null;
  showObjectiveScore: boolean;
};
export type LiveSnapshot = {
  problems: LiveProblem[];
  runs: LiveRun[];
  capturedAt: Date;
  rule?: Rule;
  remoteFrozenAt?: string | null;
};
export type LiveSource = ContestLiveData['exam']['source'];

// A roster exam number takes precedence over legacy aliases. Shared aliases
// may identify a team but cannot safely identify two different participants.
export function liveRoster(exam: LiveExam, roster: LiveRosterEntry[], source: LiveSource, teamNameTemplate = defaultContestTeamNameTemplate) {
  const candidates = [...roster].sort((a, b) => (a.memberOrder ?? 1) - (b.memberOrder ?? 1)
    || (a.examNumber < b.examNumber ? -1 : Number(a.examNumber > b.examNumber)));
  const byTeam = new Map<string, LiveRosterEntry[]>();
  for (const candidate of candidates) {
    const teamName = exam.contestType === 'TEAM' && exam.contestRule !== 'GPLT' && candidate.teamName;
    const key = teamName ? JSON.stringify(['team', teamName]) : JSON.stringify(['account', candidate.examNumber]);
    const members = byTeam.get(key) ?? [];
    members.push(candidate);
    byTeam.set(key, members);
  }
  const byCandidate = new Map<string, string>();
  const byAccount = new Map(candidates.map(candidate => [candidate.examNumber, candidate.id]));
  const aliases = new Map<string, string | null>();
  const teams: ContestLiveData['teams'] = [];
  for (const members of byTeam.values()) {
    const first = members[0];
    for (const member of members) {
      byCandidate.set(member.id, first.id);
      const alias = member.hydroAccount;
      if (source !== 'hydro' || !alias || byAccount.has(alias)) continue;
      const previous = aliases.get(alias);
      if (previous === undefined) aliases.set(alias, first.id);
      else if (previous !== first.id) aliases.set(alias, null);
    }
    const name = (exam.contestRule !== 'GPLT' && first.teamName?.trim()) || first.name?.trim() || first.examNumber;
    const fields = contestTeamNameFields(name, first, exam.reactionLogoMatchBy);
    teams.push({
      id: first.id, account: first.examNumber, accounts: members.map(member => member.examNumber),
      candidateIds: members.map(member => member.id),
      name: formatContestTeamName(teamNameTemplate, fields),
      organization: fields.org, group: first.groupName || '',
      members: first.teamMembers?.split(/[,，、;；\n]+/).map(name => name.trim()).filter(Boolean)
        || members.map(member => member.name).filter((name): name is string => !!name),
      isOutOfContest: first.ranked === false,
    });
  }
  const teamIndex = new Map(teams.map(team => [team.id, team]));
  for (const [alias, teamId] of aliases) {
    if (!teamId) continue;
    byAccount.set(alias, teamId);
    teamIndex.get(teamId)?.accounts.push(alias);
  }
  return { candidates, teams, byCandidate, byAccount };
}

const pendingStatus = (status: number) => status === 0 || (status >= 20 && status < 30);

export function contestLivePresentation(exam: LiveExam, source: LiveSource, roster: ReturnType<typeof liveRoster>,
  snapshot: LiveSnapshot | null, sourceError: string | null, now: Date, timelineTeamIds: string[] | 'all' = [],
  scoreboardVersion: ContestLiveScoreboardVersion = 'normal', manualFreeze?: ContestLiveFreeze,
  chartScenes: readonly ContestDisplayChartScene[] = []): ContestLiveData & { displayCharts?: ContestDisplayCharts } {
  const problems = snapshot?.problems ?? [];
  const rule = snapshot?.rule || exam.contestRule;
  const xcpc = isXcpcScoring(rule);
  const nativeFreeze = snapshot?.remoteFrozenAt ? new Date(snapshot.remoteFrozenAt) : null;
  const localFreeze = manualFreeze?.at
    ? manualFreeze.revealed ? null : new Date(manualFreeze.at)
    : now < exam.endAt ? exam.scoreboardFrozenAt : null;
  const scheduled = [nativeFreeze, localFreeze].filter((date): date is Date => !!date).sort((a, b) => +a - +b)[0];
  const freeze = scheduled && scheduled <= now ? scheduled : null;
  const contest: ContestLiveData['exam'] = {
    id: exam.id, name: exam.name, source, startAt: exam.startAt.toISOString(), endAt: exam.endAt.toISOString(),
    beforeStart: now < exam.startAt, reactionLogoMatchBy: exam.reactionLogoMatchBy ?? 'SCHOOL',
    freezeAt: scheduled?.toISOString() ?? null, frozen: !!freeze, scoring: xcpc ? 'icpc' : 'score',
  };
  const updatedAt = snapshot?.capturedAt.toISOString() ?? null;
  if (contest.beforeStart) {
    return {
      exam: contest, teams: roster.teams, updatedAt, sourceError,
      standings: roster.teams.map(team => ({
        teamId: team.id, rank: null, solved: 0, score: 0, penaltySeconds: 0, medal: null, cells: [],
      })),
      problems: [], submissions: [], timeline: [], statistics: [],
    };
  }
  const knownProblems = new Map(problems.map(problem => [problem.id, problem]));
  const runs = (snapshot?.runs ?? []).filter(run => knownProblems.has(run.problemId) && roster.byCandidate.has(run.candidateId)
    && run.createdAt >= exam.startAt && run.createdAt < exam.endAt && run.createdAt <= now && run.status !== 30);
  const frozenRun = (run: LiveRun) => !!freeze && run.createdAt > freeze;
  const withheld = (run: LiveRun) => frozenRun(run)
    || (now < exam.endAt && (rule === 'OI' || rule === 'LANQIAO'
      || (knownProblems.get(run.problemId)?.objective && !exam.showObjectiveScore)));
  const hidden = (run: LiveRun) => pendingStatus(run.status) || withheld(run);
  const rankingExam = { ...exam, contestRule: rule, scoreboardFrozenAt: null };
  const rankingProblems = problems.map(problem => ({ id: problem.id, score: problem.maxScore, hydroScore: problem.hydroScore }));
  const rankingRuns = runs.map(run => {
      if (!hidden(run)) return run;
      // Project frozen runs without reading their underlying verdict or score.
      if (xcpc && frozenRun(run) && scoreboardVersion === 'optimistic') return { ...run, status: 1, score: knownProblems.get(run.problemId)!.hydroScore, manualScore: null };
      return { ...run, status: frozenRun(run) && xcpc && scoreboardVersion === 'pessimistic' ? 2 : 0, score: 0, manualScore: null };
  });
  const ranked = calculateLeaderboards(rankingExam, rankingProblems, roster.candidates, rankingRuns, now);
  const teamsByAccount = new Map(roster.teams.map(team => [team.account, team]));
  const statistics = new Map<string, ContestLiveData['statistics'][number]>(
    problems.map(problem => [problem.id, { problemId: problem.id, accepted: 0, rejected: 0, pending: 0,
      teamsAccepted: 0, teamsRejected: 0, teamsPending: 0 }]));
  const byProblemTeam = new Map(problems.map(problem => [problem.id, new Map<string, number>()]));
  const frozenCells = new Map<string, Set<string>>();
  const firstBlood = new Set<string>();
  const submissions: ContestLiveData['submissions'] = [];
  const chartRuns: Parameters<typeof makeContestDisplayCharts>[1] = [];
  for (const run of runs.sort(compareSubmissionOrder)) {
    const problem = knownProblems.get(run.problemId)!;
    const teamId = roster.byCandidate.get(run.candidateId)!;
    const masked = hidden(run);
    const frozen = frozenRun(run);
    const accepted = !masked && run.status === 1;
    const first = accepted && !firstBlood.has(problem.id);
    if (first) firstBlood.add(problem.id);
    const counts = statistics.get(problem.id)!;
    if (masked) counts.pending++;
    else if (accepted) counts.accepted++;
    else counts.rejected++;
    const teamStatuses = byProblemTeam.get(problem.id)!;
    teamStatuses.set(teamId, Math.max(teamStatuses.get(teamId) ?? 0, accepted ? 3 : masked ? 2 : 1));
    if (frozen) {
      const cells = frozenCells.get(teamId) ?? new Set<string>();
      cells.add(problem.id);
      frozenCells.set(teamId, cells);
    }
    const submission = {
      id: run.id, teamId, problemId: problem.id, submittedAt: run.createdAt.toISOString(),
      seconds: Math.floor((+run.createdAt - +exam.startAt) / 1000), verdict: masked ? null : run.verdict,
      ...(frozen ? { frozen: true } : {}),
      ...(run.testedPart !== undefined && pendingStatus(run.status) && !withheld(run) && { testedPart: run.testedPart }),
      score: masked || xcpc ? null : run.manualScore ?? scaledSubmissionScore(rule, run.score, problem.maxScore, problem.hydroScore),
      firstBlood: first,
    };
    submissions.push(submission);
    if (chartScenes.length) chartRuns.push({ submission, accepted, language: run.language, judgedAt: masked ? null : run.judgedAt });
  }
  for (const [problemId, teamStatuses] of byProblemTeam) for (const status of teamStatuses.values()) {
    const counts = statistics.get(problemId)!;
    if (status === 3) counts.teamsAccepted++;
    else if (status === 2) counts.teamsPending++;
    else counts.teamsRejected++;
  }
  let timeline = submissions;
  if (timelineTeamIds !== 'all') {
    const timelineByTeam = new Map([...new Set(timelineTeamIds)].slice(0, 6).map(id => [id, [] as ContestLiveData['timeline']]));
    for (const run of submissions) timelineByTeam.get(run.teamId)?.push(run);
    timeline = [...timelineByTeam.values()].flatMap(runs => runs.slice(-500));
  }
  const data: ContestLiveData = {
    exam: contest,
    problems: problems.map(({ id, label, name, color, maxScore }) => ({ id, label, name, color, maxScore })),
    teams: roster.teams,
    standings: ranked.rows.flatMap(row => {
      const team = teamsByAccount.get(row.username);
      if (!team) return [];
      team.isOutOfContest = row.isStar;
      return [{
        teamId: team.id, rank: row.rank > 0 ? row.rank : null, solved: row.solved, score: row.score, medal: row.medal ?? null,
        penaltySeconds: source === 'hydro' && xcpc ? Math.floor(row.penaltyMillis / 1000) : row.penalty, cells: row.cells.map((cell, index) => {
          const { score, accepted, wrong, pending, seconds, firstBlood } = cell;
          const problemId = problems[index].id;
          return { problemId, score, accepted, wrong, pending, seconds, firstBlood,
            ...(pending > 0 && scoreboardVersion === 'normal' && frozenCells.get(team.id)?.has(problemId) ? { frozen: true } : {}) };
        }),
      }];
    }),
    submissions: submissions.slice(-250).reverse(),
    timeline,
    statistics: [...statistics.values()],
    updatedAt,
    sourceError,
  };
  if (!chartScenes.length) return data;
  const displayCharts = makeContestDisplayCharts(data, chartRuns, now, chartScenes);
  const leaders = ranked.rows.filter(row => row.rank > 0).slice(0, 4);
  if (xcpc && leaders.length === 4 && chartScenes.includes('scoreboardChart')) {
    const points = displayCharts.problems[0]?.solved.length ?? 0;
    const ranks = leaders.flatMap(row => {
      const team = teamsByAccount.get(row.username);
      return team ? [{ username: row.username, teamId: team.id, values: new Array<number>(points).fill(0) }] : [];
    });
    for (let point = 1; point < points; point++) {
      const cutoff = +exam.startAt + point * displayCharts.intervalSeconds * 1000;
      const rows = calculateLeaderboards(rankingExam, rankingProblems, roster.candidates, rankingRuns.filter(run =>
        +run.createdAt < cutoff && (!run.judgedAt || +run.judgedAt < cutoff)), new Date(cutoff)).rows;
      const positions = new Map(rows.filter(row => row.rank > 0).map((row, index) => [row.username, row.solved ? roster.teams.length - index : 0]));
      for (const track of ranks) track.values[point] = positions.get(track.username) ?? 0;
    }
    displayCharts.ranks = ranks.map(({ teamId, values }) => ({ teamId, values }));
  }
  return { ...data, displayCharts };
}
