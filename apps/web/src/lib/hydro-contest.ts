import type { Candidate, Exam } from '@prisma/client';
import { defaultHydroSettings, getHydroSettings, type HydroSettings } from './settings';
import { fetchHydroFile } from './hydro-file-url';

type HydroEnvelope<T> = {
  ok?: boolean;
  data?: T;
  message?: string;
};

export class HydroRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HydroRequestError';
  }
}

type ContestExam = Pick<Exam, 'platformBaseUrl' | 'platformContestId'> & {
  candidate: Pick<Candidate, 'examNumber'>;
};

async function connectionSettings(fallbackBaseUrl?: string): Promise<HydroSettings> {
  const stored = await getHydroSettings();
  const baseUrl = stored.baseUrl || fallbackBaseUrl || defaultHydroSettings.baseUrl;
  return { ...stored, baseUrl: baseUrl.replace(/\/$/, '') };
}

function requestBaseUrl(settings: HydroSettings) {
  // The monitoring backend's Hydro setting is the source of truth. Deployment
  // or client network addresses must not silently replace an administrator's value.
  return settings.baseUrl.replace(/\/$/, '');
}

function apiHeaders(settings: HydroSettings) {
  if (!settings.apiKey) throw new Error('请先在系统管理中配置评测服务 API-Key');
  return { 'content-type': 'application/json', 'x-proctor-api-key': settings.apiKey };
}

function hydroUrl(baseUrl: string, path: string) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('评测服务地址必须使用 HTTP 或 HTTPS');
  if (base.username || base.password) throw new Error('评测服务地址不能包含账号或密码');
  return new URL(path, `${base.origin}/`).toString();
}

export async function requestHydroContest<T>(
  exam: ContestExam,
  path: string,
  payload: Record<string, unknown> = {}
) {
  const settings = await connectionSettings(exam.platformBaseUrl);
  const body = JSON.stringify({
    account: settings.judgeUsername,
    contestId: exam.platformContestId,
    ...payload
  });
  const response = await fetch(hydroUrl(requestBaseUrl(settings), path), {
    method: 'POST',
    headers: apiHeaders(settings),
    body,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000)
  });
  const result = (await response.json().catch(() => null)) as HydroEnvelope<T> | null;
  if (!response.ok || !result?.ok) {
    throw new Error(result?.message || `评测服务请求失败（${response.status}）`);
  }
  return (result.data === undefined ? (result as unknown as T) : result.data) as T;
}

export async function requestHydroContestFile(
  exam: ContestExam,
  payload: Record<string, unknown>
) {
  const settings = await connectionSettings(exam.platformBaseUrl);
  const signed = await requestHydroContest<{ url: string }>(exam, `/api/proctor/contest/${exam.platformContestId}/file`, payload);
  const response = await fetchHydroFile(signed.url, requestBaseUrl(settings));
  if (!response.ok) throw new Error(`题目文件下载失败（${response.status}）`);
  return response;
}

export type HydroProblemPayload = {
  id: string;
  pid: string;
  title: string;
  content: string;
  html: boolean;
  config: Record<string, unknown>;
  files: Array<{ name: string; size?: number }>;
  tags: string[];
  difficulty: number;
  score?: number;
};

export type HydroRecordPayload = {
  id: string;
  pid: number;
  uid?: number;
  lang: string;
  code: string;
  status: number;
  statusText: string;
  score: number;
  time: number;
  memory: number;
  testCases: unknown[];
  subtasks?: Record<string, unknown>;
  judgeAt?: string | null;
  createdAt: string;
};

export function judgeStatistics(testCases: unknown) {
  const cases = Array.isArray(testCases) ? testCases : [];
  const passed = cases.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    const value = item as Record<string, unknown>;
    return value.status === 1
      || value.status === 'Accepted'
      || value.statusText === 'Accepted'
      || value.result === 'Accepted'
      || value.passed === true
      || value.accepted === true;
  }).length;
  return { totalTestCases: cases.length, passedTestCases: passed };
}

export async function requestHydroBridge<T>(
  exam: Pick<Exam, 'platformBaseUrl'> & { candidate?: Pick<Candidate, 'examNumber'> },
  path: string,
  payload: Record<string, unknown> = {},
) {
  const settings = await connectionSettings(exam.platformBaseUrl);
  const body = JSON.stringify(payload);
  const response = await fetch(hydroUrl(requestBaseUrl(settings), path), {
    method: 'POST',
    headers: apiHeaders(settings),
    body,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const result = (await response.json().catch(() => null)) as HydroEnvelope<T> | null;
  if (!response.ok || !result?.ok) throw new Error(result?.message || `评测服务请求失败（${response.status}）`);
  return (result.data === undefined ? (result as unknown as T) : result.data) as T;
}

async function requestHydroJudgeApi<T>(
  exam: Pick<Exam, 'platformBaseUrl'>,
  path: string,
  payload: Record<string, unknown> = {},
) {
  const settings = await connectionSettings(exam.platformBaseUrl);
  const body = JSON.stringify(payload);
  const response = await fetch(hydroUrl(requestBaseUrl(settings), path), {
    method: 'POST',
    headers: apiHeaders(settings),
    body,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const result = (await response.json().catch(() => null)) as HydroEnvelope<T> | null;
  if (!response.ok || !result?.ok) throw new HydroRequestError(result?.message || `评测服务请求失败（${response.status}）`, response.status);
  return (result.data === undefined ? (result as unknown as T) : result.data) as T;
}

export async function requestHydroProblem<T = HydroProblemPayload>(
  exam: Pick<Exam, 'platformBaseUrl'>,
  problemId: string,
) {
  return requestHydroBridge<T>(exam, `/api/proctor/problem/${encodeURIComponent(problemId)}`);
}

export async function requestHydroProblemAnswerKey(
  exam: Pick<Exam, 'platformBaseUrl'>,
  problemId: string,
) {
  const result = await requestHydroBridge<{ answers: Record<string, unknown> }>(
    exam,
    `/api/proctor/problem/${encodeURIComponent(problemId)}/answer-key`,
  );
  return result.answers && typeof result.answers === 'object' ? result.answers : {};
}

export async function requestHydroProblemFile(
  exam: Pick<Exam, 'platformBaseUrl'>,
  problemId: string,
  name: string,
) {
  const settings = await connectionSettings(exam.platformBaseUrl);
  const signed = await requestHydroBridge<{ url: string }>(
    exam,
    `/api/proctor/problem/${encodeURIComponent(problemId)}/file`,
    { name },
  );
  const response = await fetchHydroFile(signed.url, requestBaseUrl(settings));
  if (!response.ok) throw new Error(`题目文件下载失败（${response.status}）`);
  return response;
}

export async function syncHydroProblem<T = HydroProblemPayload>(
  exam: Pick<Exam, 'platformBaseUrl'>,
  payload: Record<string, unknown>,
) {
  return requestHydroBridge<T>(exam, '/api/proctor/problem/sync', payload);
}

export async function submitHydroJudge<T = HydroRecordPayload>(
  exam: Pick<Exam, 'platformBaseUrl'>,
  payload: { pid: number; lang: string; code: string },
) {
  return requestHydroJudgeApi<T>(exam, '/api/proctor/judge', payload);
}

export async function requestHydroJudgeStatus<T = HydroRecordPayload>(
  exam: Pick<Exam, 'platformBaseUrl'>,
  recordId: string,
) {
  return requestHydroJudgeApi<T>(exam, `/api/proctor/judge/${encodeURIComponent(recordId)}`);
}

export async function requestHydroJudgeStatuses<T = HydroRecordPayload>(
  exam: Pick<Exam, 'platformBaseUrl'>,
  recordIds: string[],
) {
  if (!recordIds.length) return [] as T[];
  return requestHydroJudgeApi<T[]>(exam, '/api/proctor/judge-status', { ids: recordIds.slice(0, 200) });
}

type LanguageCache = { key: string; expiresAt: number; data?: Array<{ id: string; name: string }>; pending?: Promise<Array<{ id: string; name: string }>> };
let languageCache: LanguageCache | undefined;

export async function requestHydroLanguages() {
  const settings = await connectionSettings();
  const key = JSON.stringify([settings.baseUrl, settings.apiKey, settings.problemDomainId]);
  if (languageCache?.key === key) {
    if (languageCache.data && languageCache.expiresAt > Date.now()) return languageCache.data;
    if (languageCache.pending) return languageCache.pending;
  }
  const cache: LanguageCache = { key, expiresAt: 0 };
  languageCache = cache;
  cache.pending = (async () => {
    try {
      const response = await fetch(hydroUrl(settings.baseUrl, '/api/proctor/languages'), {
        method: 'POST', headers: apiHeaders(settings), body: '{}', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      const result = await response.json().catch(() => null) as HydroEnvelope<Array<{ id: string; name: string }>> | null;
      if (response.status === 404) throw new Error('评测服务语言接口尚未启用，请联系管理员更新服务');
      if (!response.ok || !result?.ok || !Array.isArray(result.data)) throw new Error(result?.message || `评测语言列表请求失败（${response.status}）`);
      const data = result.data.filter(item => typeof item?.id === 'string' && item.id && item.id !== '_')
        .map(item => ({ id: item.id, name: item.name || item.id }));
      cache.data = data; cache.expiresAt = Date.now() + 10_000;
      return data;
    } finally { cache.pending = undefined; }
  })();
  return cache.pending;
}
