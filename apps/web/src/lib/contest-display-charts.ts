import type { ContestDisplayChartScene, ContestDisplayCharts } from './contest-display-contract';
import type { ContestLiveData, ContestLiveSubmission } from './contest-live-contract';

const interval = 300;
type ChartRun = { submission: ContestLiveSubmission; accepted: boolean; language?: string; judgedAt?: Date | null };

export function makeContestDisplayCharts(data: ContestLiveData, runs: ChartRun[], now: Date, scenes: readonly ContestDisplayChartScene[]): ContestDisplayCharts {
  const start = Date.parse(data.exam.startAt), end = Date.parse(data.exam.endAt);
  let lastEvent = 0;
  for (const { submission, judgedAt } of runs) lastEvent = Math.max(lastEvent, submission.seconds, judgedAt ? (+judgedAt - start) / 1000 : 0);
  const count = Math.max(1, Math.floor(Math.min(lastEvent, (end - start) / 1000) / interval));
  const days = Math.max(1, Math.ceil((end - start) / 86_400_000));
  const queueStep = days <= 2 ? 1 : days;
  const queue = scenes.includes('judgeQueueDepthChart') ? new Array<number>(Math.max(1, Math.floor((end - start) / (1000 * queueStep))) + 1).fill(0) : null;
  const problems = data.problems.map(({ id }) => ({ problemId: id, failed: new Array<number>(count).fill(0),
    pending: new Array<number>(count).fill(0), solved: new Array<number>(count).fill(0), frozen: new Array<number>(count).fill(0),
    judgement: undefined as { solvedMs: number; failedMs: number } | undefined }));
  const byProblem = new Map(problems.map(problem => [problem.problemId, problem]));
  const languages = new Map<string, { name: string; attempts: number; solved: number }>();
  const times = new Map<string, { solved: number; solvedCount: number; failed: number; failedCount: number }>();
  let hasQueueTiming = false;
  for (const { submission, accepted, language, judgedAt } of runs) {
    const problem = byProblem.get(submission.problemId);
    if (!problem) continue;
    const bucket = Math.min(count - 1, Math.floor(submission.seconds / interval));
    const status = submission.frozen ? 'frozen' : !submission.verdict ? 'pending' : accepted ? 'solved' : 'failed';
    problem[status][bucket]++;
    const label = language?.trim().slice(0, 48);
    if (label && scenes.includes('languageSummaryChart')) {
      const row = languages.get(label) ?? { name: label, attempts: 0, solved: 0 };
      row.attempts++;
      row.solved += Number(status === 'solved');
      languages.set(label, row);
    }
    const submittedAt = Date.parse(submission.submittedAt);
    const finishedAt = judgedAt && +judgedAt >= submittedAt && +judgedAt <= +now ? +judgedAt : null;
    if (finishedAt !== null && (status === 'solved' || status === 'failed')) {
      hasQueueTiming = true;
      if (scenes.includes('judgementChart')) {
        const result = times.get(problem.problemId) ?? { solved: 0, solvedCount: 0, failed: 0, failedCount: 0 };
        result[status] += finishedAt - submittedAt;
        if (status === 'solved') result.solvedCount++;
        else result.failedCount++;
        times.set(problem.problemId, result);
      }
    }
    if (!queue || status === 'frozen' || (finishedAt === null && status !== 'pending')) continue;
    const first = Math.max(0, Math.ceil((submittedAt - start) / (1000 * queueStep)));
    const stop = Math.min(queue.length - 1, Math.floor(((finishedAt ?? Math.min(+now, end)) - start) / (1000 * queueStep)));
    if (first < stop) {
      hasQueueTiming = true;
      queue[first]++;
      queue[stop]--;
    }
  }
  for (const problem of problems) {
    const time = times.get(problem.problemId);
    if (time) problem.judgement = { solvedMs: time.solvedCount ? time.solved / time.solvedCount : 0,
      failedMs: time.failedCount ? time.failed / time.failedCount : 0 };
  }
  if (queue) {
    queue.pop();
    for (let i = 1; i < queue.length; i++) queue[i] += queue[i - 1];
  }
  return { intervalSeconds: interval, problems,
    ...(languages.size && { languages: [...languages.values()].sort((a, b) => a.name.localeCompare(b.name, 'en')) }),
    ...(queue && hasQueueTiming && { queueDepth: { stepSeconds: queueStep, values: queue } }) };
}
