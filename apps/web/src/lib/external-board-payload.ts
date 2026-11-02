import type { Candidate, ContestSubmission, ExamProblem } from '@prisma/client';
import { problemLabel } from './contest-rules';
import { hydroStatusText } from './hydro-status';

type Problem = Pick<ExamProblem, 'id' | 'order' | 'title' | 'score' | 'hydroScore' | 'timeLimitMs' | 'memoryLimitMb'>;
type Submission = Pick<ContestSubmission, 'id' | 'status' | 'statusText' | 'judgeAt' | 'score' | 'manualScore' | 'lang' | 'code' | 'time' | 'memory' | 'createdAt'>;

export class ExternalBoardCredentialError extends Error {}

/** An exam manager may change its endpoint, but cannot export a system secret. */
export function externalBoardFallbackKey(apiBase: string, settings: { apiBase: string; appKey: string }) {
  let trusted = false;
  try {
    const target = new URL(apiBase), configured = new URL(settings.apiBase);
    trusted = ['http:', 'https:'].includes(target.protocol) && !target.username && !target.password
      && target.origin === configured.origin;
  } catch { /* Invalid settings must never authorize a credential transfer. */ }
  if (!trusted) throw new ExternalBoardCredentialError('该外榜地址与系统登录服务不同源，请为本场考试填写专用推送密钥');
  return settings.appKey.trim();
}

export function externalBoardProblem(problem: Problem) {
  return {
    display_id: problemLabel(problem.order), title: problem.title, score: problem.score,
    time_limit: problem.timeLimitMs, memory_limit: problem.memoryLimitMb,
  };
}

/** The receiver parses a China-local datetime, integer percentages and KB. */
export function externalBoardSubmission(submission: Submission, problem: Problem, candidate: Pick<Candidate, 'examNumber'>) {
  const ignored = submission.status === 30;
  const percentage = submission.manualScore !== null
    ? submission.manualScore * 100 / (problem.score || 100)
    : submission.score * 100 / (problem.hydroScore || 100);
  return {
    rid: `proctor:${submission.id}`,
    username: candidate.examNumber,
    problem: problemLabel(problem.order),
    // The existing receiver has no deletion endpoint. CE with zero score is
    // its neutral verdict: it retracts an earlier AC without adding penalties.
    status: ignored ? 'Compile Error' : hydroStatusText(submission.statusText, submission.status),
    score: ignored ? 0 : Math.round(Math.max(0, Math.min(100, percentage))),
    language: submission.lang, code: submission.code,
    runtime: String(submission.time), memory: String(submission.memory),
    submit_time: new Date(+submission.createdAt + 8 * 3600_000).toISOString().replace('T', ' ').replace('Z', ''),
  };
}

export function externalBoardEndpoint(apiBase: string, eventId: string, kind: 'problems' | 'submissions') {
  const url = new URL(apiBase);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('请在比赛设置中填写有效的 CWNUPAA 官网域名');
  }
  return `${url.href.replace(/\/+$/, '')}/external/board/${eventId}/${kind}`;
}
