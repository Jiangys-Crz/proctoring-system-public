import { isFemale, normalizeParticipationGroup } from '@cwnupaa/proctor-shared/leaderboard';

// ACM is a legacy XCPC alias; LANQIAO has its own score leaderboard.
export type Rule = 'GPLT' | 'XCPC' | 'LANQIAO' | 'ACM' | 'OI' | 'IOI' | 'KS';
export type Timing = { startAt: Date; latestStartAt: Date; endAt: Date; durationMinutes: number; contestRule: Rule; flexible?: boolean };

export function isXcpcScoring(rule: Rule) { return rule === 'XCPC' || rule === 'ACM'; }

export function isScoreboardFrozen(exam: { scoreboardFrozenAt?: Date | null; endAt: Date }, now = new Date()) {
  return !!exam.scoreboardFrozenAt && now >= exam.scoreboardFrozenAt && now < exam.endAt;
}

export function flexibleExam(exam: Pick<Timing, 'contestRule' | 'flexible'>) {
  return !isXcpcScoring(exam.contestRule) && exam.flexible === true;
}
export function effectiveEnd(exam: Timing, startedAt?: Date | null) {
  return flexibleExam(exam) && startedAt
    ? new Date(Math.min(exam.endAt.getTime(), startedAt.getTime() + exam.durationMinutes * 60_000)) : exam.endAt;
}
export function candidateStartDeadline(exam: Timing, lateStartAllowedAt?: Date | null) {
  if (lateStartAllowedAt) return exam.endAt;
  if (flexibleExam(exam)) return new Date(Math.min(exam.latestStartAt.getTime(), exam.endAt.getTime()));
  return new Date(Math.min(exam.startAt.getTime() + 15 * 60_000, exam.endAt.getTime()));
}
export function candidateLoginOpensAt(exam: Pick<Timing, 'startAt'>) {
  return new Date(exam.startAt.getTime() - 40 * 60_000);
}
export function candidateLoginError(exam: Timing, startedAt: Date | null | undefined, now = new Date(), publicTest = false, lateStartAllowedAt?: Date | null) {
  if (!publicTest && now < candidateLoginOpensAt(exam)) return '本场考试在开始前 40 分钟开放登录，请到时再请求登录';
  if (now >= effectiveEnd(exam, startedAt) || (!startedAt && now > candidateStartDeadline(exam, lateStartAllowedAt))) return '已超过本场考试允许登录时间';
  return '';
}
export function canCandidateLogin(exam: Timing, startedAt: Date | null | undefined, now = new Date(), publicTest = false, lateStartAllowedAt?: Date | null) {
  return !candidateLoginError(exam, startedAt, now, publicTest, lateStartAllowedAt);
}
export function timingError(exam: Timing) {
  if (exam.startAt >= exam.endAt) return '结束时间必须晚于开始时间';
  if (exam.latestStartAt < exam.startAt || exam.latestStartAt > exam.endAt) return '最晚开始时间须在开始时间至结束时间之间';
  if (isXcpcScoring(exam.contestRule) && exam.flexible) return 'XCPC 不支持灵活考试';
  return '';
}
export function problemLabel(order: number) {
  let n = order + 1, result = '';
  while (n > 0) { n--; result = String.fromCharCode(65 + n % 26) + result; n = Math.floor(n / 26); }
  return result;
}
export function resultVisibility(rule: Rule, ended: boolean) {
  return { verdict: !['OI', 'LANQIAO'].includes(rule) || ended, detail: ['IOI', 'GPLT'].includes(rule) || ended };
}

export function judgeObjectiveImmediately(rule: Rule, showObjectiveScore: boolean, ended = false) {
  return rule === 'KS' || ended || (showObjectiveScore && !['OI', 'LANQIAO'].includes(rule));
}

export type ScoreRecord = { id: string; candidateId: string; problemId: string; status: number; score: number; manualScore?: number | null; createdAt: Date };
export function compareSubmissionOrder(a: Pick<ScoreRecord, 'id' | 'createdAt'>, b: Pick<ScoreRecord, 'id' | 'createdAt'>) {
  return +a.createdAt - +b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export type RankingCandidate = {
  id: string; examNumber: string; name: string | null; teamName: string | null;
  groupName?: string | null; school?: string | null; college?: string | null; ranked?: boolean; gender?: string | null; teamMembers?: string | null;
};
export type ScoreRow = {
  rank: number; username: string; displayName: string; groupName: string; teamName: string | null;
  institution: string; members?: string; isStar: boolean; isGirl: boolean; medal?: 'Gold' | 'Silver' | 'Bronze'; penaltyMillis: number;
  score: number; solved: number; penalty: number; problemScores: Array<number | null>;
  cells: Array<{ score: number | null; accepted: boolean; wrong: number; pending: number; seconds: number; penalty: number; penaltyMillis: number; firstBlood: boolean }>;
};

export const IGNORED_SUBMISSION_STATUS = 30;
export type RankingProblem = { id: string; score: number; hydroScore?: number; scorePercent?: number };

export function scaledSubmissionScore(rule: Rule, raw: number, score: number, hydroScore = 100) {
  // Normalize Hydro points by the real full score before applying the exam maximum.
  // A 25/25 AC on a 20-point exam problem earns 20, not 5.
  const value = raw * score / (hydroScore || 100);
  if (rule === 'GPLT') return Math.ceil(value);
  if (rule === 'LANQIAO') return Math.round(value);
  return Math.round(value * 100) / 100;
}

function assignRanks(rows: ScoreRow[], xcpc: boolean, grouped: boolean, teamNames = false) {
  const compare = (a: ScoreRow, b: ScoreRow) => (xcpc ? b.solved - a.solved : b.score - a.score)
    || a.penaltyMillis - b.penaltyMillis
    || (teamNames ? (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0) : 0)
    || (a.username < b.username ? -1 : a.username > b.username ? 1 : 0);
  const byGroup = new Map<string, ScoreRow[]>();
  if (grouped) for (const row of rows) {
    const group = byGroup.get(row.groupName);
    if (group) group.push(row); else byGroup.set(row.groupName, [row]);
  }
  const groups = grouped ? [...byGroup.values()] : [rows];
  for (const groupRows of groups) {
    groupRows.sort(compare);
    let officialCount = 0;
    let previous: ScoreRow | undefined;
    for (const row of groupRows) {
      row.medal = undefined;
      if (row.isStar) { row.rank = -1; continue; }
      officialCount += 1;
      const tied = previous && (xcpc ? previous.solved === row.solved : previous.score === row.score)
        && previous.penaltyMillis === row.penaltyMillis;
      row.rank = tied && previous ? previous.rank : officialCount;
      previous = row;
    }
    if (grouped) {
      const gold = officialCount ? Math.max(1, Math.round(officialCount * .1)) : 0;
      groupRows.filter(row => !row.isStar).forEach((row, index) => {
        row.medal = index < gold ? 'Gold' : index < gold * 3 ? 'Silver' : index < gold * 6 ? 'Bronze' : undefined;
      });
    }
  }
  rows.sort(compare);
}

export function scoreRows(exam: Timing & { scoreboardFrozenAt?: Date | null },
  problems: RankingProblem[],
  candidates: RankingCandidate[], records: ScoreRecord[], now = new Date(), admin = false) {
  const xcpc = isXcpcScoring(exam.contestRule);
  const scoreContest = ['GPLT', 'LANQIAO'].includes(exam.contestRule);
  const available = admin || (exam.contestRule !== 'KS') && (now >= exam.startAt && (exam.contestRule !== 'OI' || now >= exam.endAt));
  if (!available) return { available: false, frozen: false, rows: [] as ScoreRow[] };
  const frozen = (!admin || xcpc || scoreContest) && isScoreboardFrozen(exam, now);
  const first = new Map<string, number>();
  const candidateIds = new Set(candidates.map(candidate => candidate.id));
  const ordered = [...records].filter(record => record.status !== IGNORED_SUBMISSION_STATUS && candidateIds.has(record.candidateId)
    && record.createdAt >= exam.startAt && record.createdAt < exam.endAt && record.createdAt <= now)
    // A server's locale must not select a different latest run at equal time.
    .sort(compareSubmissionOrder);
  const byCandidate = new Map<string, Map<string, ScoreRecord[]>>();
  for (const record of ordered) {
    if (record.status === 1 && (!frozen || record.createdAt <= exam.scoreboardFrozenAt!) && !first.has(record.problemId)) first.set(record.problemId, +record.createdAt);
    let byProblem = byCandidate.get(record.candidateId);
    if (!byProblem) { byProblem = new Map(); byCandidate.set(record.candidateId, byProblem); }
    const problemRecords = byProblem.get(record.problemId);
    if (problemRecords) problemRecords.push(record);
    else byProblem.set(record.problemId, [record]);
  }

  const rows: ScoreRow[] = candidates.map(candidate => {
    const cells = problems.map(problem => {
      const all = byCandidate.get(candidate.id)?.get(problem.id) || [];
      let chosen: ScoreRecord | undefined, wrong = 0, pending = 0, lastSubmitMillis = 0;
      const realScore = (record: ScoreRecord) => record.manualScore ?? scaledSubmissionScore(exam.contestRule, record.score, problem.score, problem.hydroScore);
      for (const record of all) {
        if (xcpc && chosen?.status === 1) break;
        lastSubmitMillis = Math.max(lastSubmitMillis, +record.createdAt - +exam.startAt);
        if (frozen && record.createdAt > exam.scoreboardFrozenAt!) { pending++; continue; }
        if ([0, 20, 21, 22].includes(record.status)) {
          pending++;
          // KS always uses the latest non-cancelled submission. A latest run
          // that is still pending must not fall back to an older score.
          if (exam.contestRule === 'KS') chosen = record;
          continue;
        }
        if (xcpc) {
          if (record.status === 1) chosen = record;
          else if (record.status !== 7) { wrong++; chosen = record; }
        } else if (scoreContest) {
          if (record.status === 7) continue;
          if (!chosen || realScore(record) > realScore(chosen) || (realScore(record) === realScore(chosen) && record.createdAt < chosen.createdAt)) chosen = record;
        } else if (exam.contestRule === 'OI' || exam.contestRule === 'KS' || !chosen || record.score > chosen.score) chosen = record;
      }
      const accepted = chosen?.status === 1;
      const millis = chosen ? Math.max(0, +chosen.createdAt - +exam.startAt) : 0;
      const seconds = Math.floor((xcpc ? lastSubmitMillis : millis) / 1000);
      const score = chosen ? realScore(chosen) : null;
      return { score, accepted, wrong, pending, seconds,
        // ICPC/DOMjudge rounds each solved problem down to whole minutes before
        // adding 20 minutes for each penalty-bearing rejection before the AC.
        penalty: xcpc && accepted ? Math.floor(seconds / 60) * 60 + wrong * 1200 : scoreContest && score && score > 0 ? seconds : 0,
        penaltyMillis: xcpc && accepted ? millis + wrong * 1_200_000 : scoreContest && score && score > 0 ? millis : 0,
        firstBlood: !!chosen && accepted && first.get(problem.id) === +chosen.createdAt };
    });
    return {
      rank: 0,
      username: candidate.examNumber,
      displayName: exam.contestRule === 'GPLT' ? candidate.name || candidate.examNumber : candidate.teamName || candidate.name || candidate.examNumber,
      groupName: normalizeParticipationGroup(exam.contestRule, candidate.groupName) || '未分组',
      isStar: candidate.ranked === false || normalizeParticipationGroup(exam.contestRule, candidate.groupName) === 'star',
      isGirl: normalizeParticipationGroup(exam.contestRule, candidate.groupName) === 'girl' || isFemale(candidate.gender),
      members: candidate.teamMembers || undefined,
      teamName: candidate.teamName,
      institution: candidate.college || candidate.school || '',
      penaltyMillis: scoreContest ? Math.max(0, ...cells.map(cell => cell.penaltyMillis)) : cells.reduce((sum, cell) => sum + cell.penaltyMillis, 0),
      score: cells.reduce((sum, cell) => sum + (cell.score || 0), 0),
      solved: cells.filter(cell => cell.accepted).length,
      penalty: scoreContest ? Math.max(0, ...cells.map(cell => cell.penalty)) : cells.reduce((sum, cell) => sum + cell.penalty, 0),
      problemScores: cells.map(cell => xcpc ? (cell.accepted ? 1 : cell.wrong || cell.pending ? 0 : null) : cell.score),
      cells,
    };
  });
  assignRanks(rows, xcpc, scoreContest);
  return { available, frozen, rows };
}

export function gpltTeamRows(personalRows: ScoreRow[]) {
  const teams = new Map<string, ScoreRow>();
  for (const row of personalRows) {
    const teamName = row.teamName || row.username;
    // An actual team named after an exam number is distinct from that
    // unteamed candidate. JSON also keeps embedded separators unambiguous.
    const key = JSON.stringify([row.groupName, row.teamName ? 'team' : 'candidate', teamName]);
    const existing = teams.get(key);
    if (!existing) {
      teams.set(key, { ...row, rank: 0, username: teamName, displayName: teamName,
        members: row.displayName, problemScores: [...row.problemScores], cells: [...row.cells] });
      continue;
    }
    existing.score += row.score;
    existing.members = [existing.members, row.displayName].filter(Boolean).join(', ');
    existing.isStar ||= row.isStar;
    existing.isGirl &&= row.isGirl;
    existing.penaltyMillis = Math.max(existing.penaltyMillis, row.penaltyMillis);
    existing.penalty = Math.max(existing.penalty, row.penalty);
    existing.solved += row.solved;
    existing.problemScores = existing.problemScores.map((score, index) => {
      const added = row.problemScores[index];
      return score === null && added === null ? null : (score || 0) + (added || 0);
    });
  }
  const rows = [...teams.values()];
  const identity = (row: ScoreRow, name = row.username) => JSON.stringify([row.groupName, name]);
  const named = new Set(rows.filter(row => row.teamName).map(row => identity(row)));
  const used = new Set(rows.map(row => identity(row)));
  // Keep the established team-name identifiers for existing consumers. Only
  // unteamed rows colliding with real team names need a different hidden key.
  // Process in exam-number order so score changes cannot change those keys.
  const collisions = rows.filter(row => !row.teamName && named.has(identity(row)))
    .sort((a, b) => a.username < b.username ? -1 : a.username > b.username ? 1 : 0);
  for (const row of collisions) {
    let name = `candidate:${row.username}`;
    while (used.has(identity(row, name))) name = `candidate:${name}`;
    row.username = name;
    used.add(identity(row));
  }
  // Display names preserve the established order even for disambiguated rows.
  assignRanks(rows, false, true, true);
  return rows;
}
