import { createHash } from 'node:crypto';
import type { Exam } from '@prisma/client';
import { readNovaJudgeArray } from './novajudge';

export const novaBoardHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const nonnegative = (value: unknown) => Math.max(0, Number(value) || 0);

export function novaBoardSubmitTime(value: string, timezone = 'Asia/Shanghai') {
  let date: Date;
  const local = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?::\d{1,3})?$/);
  if (local) {
    const parts = local.slice(1, 7).map(Number);
    const target = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const wallTime = (at: number) => {
      const p = Object.fromEntries(formatter.formatToParts(at).map(item => [item.type, item.value]));
      return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    };
    let timestamp = target;
    for (let attempt = 0; attempt < 4; attempt++) timestamp = target - (wallTime(timestamp) - timestamp);
    const normalized = new Date(target).toISOString().slice(0, 19).replace('T', ' ');
    if (wallTime(timestamp) !== target || normalized !== value.slice(0, 19)) throw new Error('NovaJudge 提交时间无效或处于时区跳变区间');
    date = new Date(timestamp);
  } else {
    date = new Date(value);
    if (!Number.isFinite(+date) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('NovaJudge 提交时间格式无效');
  }
  return new Date(+date + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}

export function novaBoardProblems(rows: Array<Record<string, unknown>>) {
  const seen = new Set<string>();
  return rows.map(row => {
    const display_id = text(row.displayId), title = text(row.name);
    if (!display_id || !title || seen.has(display_id)) throw new Error('NovaJudge 题目编号或名称无效');
    seen.add(display_id);
    // Both the NovaJudge export and receiver use ms/MB.
    return { display_id, title, score: nonnegative(row.score) || 100,
      time_limit: Math.round(nonnegative(row.time)), memory_limit: nonnegative(row.memory) };
  });
}

export function novaBoardSubmission(row: Record<string, unknown>, problems: ReturnType<typeof novaBoardProblems>, exam: Pick<Exam, 'id'> & { novaJudgeTimezone?: string }) {
  const rid = text(row.rid), username = text(row.username), rawProblem = text(row.problem);
  if (!rid || rid.length > 191 || !username) throw new Error('NovaJudge 提交记录缺少有效的 ID 或比赛账号');
  // The current NovaJudge API returns the problem title, not displayId. Fail on
  // ambiguous titles instead of assigning a submission to the wrong problem.
  const matches = problems.filter(p => p.title === rawProblem);
  if (matches.length !== 1) throw new Error('NovaJudge 提交记录题目无法唯一匹配，请检查比赛中是否有重名题目');
  const submit_time = novaBoardSubmitTime(text(row.submittedAt || row.submit_time), exam.novaJudgeTimezone);
  return { rid: `novajudge:${exam.id}:${rid}`, username, problem: matches[0].display_id,
    status: text(row.status), score: Math.round(Math.min(100, nonnegative(row.score))),
    language: text(row.language), code: text(row.code), runtime: String(nonnegative(row.runtime)),
    memory: String(nonnegative(row.memory)), submit_time };
}

export async function readNovaJudgeBoard(exam: Exam, signal: AbortSignal, usernames: Set<string>) {
  const [problemRows, submissionRows] = await Promise.all([
    readNovaJudgeArray(exam, 'problems', signal), readNovaJudgeArray(exam, 'submissions', signal),
  ]);
  const problems = novaBoardProblems(problemRows);
  const records = submissionRows.filter(row => usernames.has(text(row.username)) && !['Waiting', 'Running'].includes(text(row.status))).map(row => ({
    remoteId: text(row.rid), payload: novaBoardSubmission(row, problems, exam),
  })).filter(record => {
    const submittedAt = new Date(`${record.payload.submit_time.replace(' ', 'T')}+08:00`);
    return submittedAt >= exam.startAt && submittedAt < exam.endAt;
  }).sort((a, b) => a.remoteId.localeCompare(b.remoteId));
  if (new Set(records.map(row => row.remoteId)).size !== records.length) throw new Error('NovaJudge 提交记录 ID 重复');
  return { problems, records };
}
