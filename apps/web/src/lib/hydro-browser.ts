import type { Candidate, Exam } from '@prisma/client';
import { getHydroSettings } from './settings';

type HydroBrowserExam = Pick<Exam, 'platformBaseUrl' | 'platformContestId'> & Partial<Pick<Exam, 'id' | 'endAt' | 'hydroBrowserApiKey'>>;
type HydroBrowserConnection = { baseUrl: string; apiKey: string };

export class HydroBrowserConnectionError extends Error {}

export function hydroBrowserTarget(baseUrl: string, contestId: string) {
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { throw new Error('请填写有效的 HydroOJ HTTP/HTTPS 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || /[\\\s]/.test(baseUrl) || !/^\/(?:d\/[a-zA-Z0-9_-]+\/?)?$/.test(url.pathname)) {
    throw new Error('HydroOJ 地址只能包含站点及可选的 /d/域ID');
  }
  if (!/^[a-f\d]{24}$/i.test(contestId)) throw new Error('HydroOJ 比赛 ID 必须是 24 位十六进制字符');
  const base = url.origin + url.pathname.replace(/\/$/, '');
  return { origin: url.origin, base, contestId: contestId.toLowerCase() };
}

export function trustedHydroBrowserTarget(exam: HydroBrowserExam, configuredBase: string) {
  const target = hydroBrowserTarget(exam.platformBaseUrl, exam.platformContestId);
  if (!configuredBase || target.origin !== new URL(configuredBase).origin) {
    throw new Error('使用其他 HydroOJ 站点时，请填写该考试的监考插件 API-Key；未填写时须与评测服务使用同一站点');
  }
  return target;
}

/** A separate site receives only its explicitly supplied exam key. */
export function hydroBrowserConnection(exam: HydroBrowserExam, fallback: HydroBrowserConnection): HydroBrowserConnection {
  const target = hydroBrowserTarget(exam.platformBaseUrl, exam.platformContestId);
  const apiKey = exam.hydroBrowserApiKey?.trim();
  if (apiKey) return { baseUrl: target.origin, apiKey };
  trustedHydroBrowserTarget(exam, fallback.baseUrl);
  return fallback;
}

async function nativeRequest(url: string, init: RequestInit) {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(12_000), ...init });
  } catch {
    throw new HydroBrowserConnectionError('HydroOJ 连接失败或超时，正在等待恢复');
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    throw new HydroBrowserConnectionError('HydroOJ 服务暂不可用，请稍后重试');
  }
  return response;
}

async function browserContestRequest(exam: HydroBrowserExam, connection: HydroBrowserConnection,
  payload: { action: 'enable'; examId?: string; endAt?: string } | { action: 'bind'; username: string }
    | { action: 'restrict'; username: string; examId: string; endAt: string }, sid?: string) {
  connection = hydroBrowserConnection(exam, connection);
  const { base, contestId } = trustedHydroBrowserTarget(exam, connection.baseUrl);
  if (!connection.apiKey) throw new Error('请先在系统设置中配置 HydroOJ API-Key');
  const response = await nativeRequest(`${base}/api/proctor/browser-contest/${contestId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json',
      'x-proctor-api-key': connection.apiKey, ...(sid ? { cookie: `sid=${sid}` } : {}) },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => null);
  if (response.status === 409 && result?.code === 'NOT_STARTED') {
    throw new HydroBrowserConnectionError('HydroOJ 比赛尚未开始，正在等待开赛');
  }
  if (response.status === 404) throw new Error('HydroOJ 比赛不存在或插件尚未更新，请检查比赛 ID 和监考插件');
  if (response.status === 403 && payload.action === 'bind') {
    throw new Error('HydroOJ 拒绝监考登录，请检查评测 API-Key 及考生是否以普通选手账号加入本场比赛');
  }
  if (!response.ok || !result?.ok || result.data?.contestId !== contestId) {
    throw new Error('HydroOJ 未确认比赛接入，请检查比赛、监考插件和评测 API-Key');
  }
  return result.data;
}

export async function enableHydroBrowserContest(exam: HydroBrowserExam, connection: HydroBrowserConnection) {
  await browserContestRequest(exam, connection, { action: 'enable', examId: exam.id, endAt: exam.endAt?.toISOString() });
}

const restrictedAccounts = new Map<string, { until: number; pending: Promise<void> }>();
export async function restrictHydroBrowserAccount(exam: Pick<Exam, 'id' | 'platform' | 'platformBaseUrl' | 'platformContestId' | 'endAt'> & Partial<Pick<Exam, 'hydroBrowserApiKey'>>,
  candidate: Pick<Candidate, 'id' | 'examNumber'>) {
  if (exam.platform !== 'HYDRO_BROWSER' || exam.endAt.getTime() <= Date.now()) return;
  const key = JSON.stringify([exam.id, candidate.id, candidate.examNumber, exam.platformBaseUrl, exam.platformContestId, +exam.endAt, exam.hydroBrowserApiKey]);
  const existing = restrictedAccounts.get(key);
  if (existing && existing.until > Date.now()) return existing.pending;
  for (const [id, entry] of restrictedAccounts) if (entry.until <= Date.now()) restrictedAccounts.delete(id);
  const pending = (async () => {
    await browserContestRequest(exam, await getHydroSettings(), {
      action: 'restrict', username: candidate.examNumber, examId: exam.id, endAt: exam.endAt.toISOString(),
    });
  })();
  const entry = { until: Date.now() + 30_000, pending };
  restrictedAccounts.set(key, entry);
  try { await pending; }
  catch (error) { if (restrictedAccounts.get(key) === entry) restrictedAccounts.delete(key); throw error; }
}

export async function loginHydroBrowser(
  exam: HydroBrowserExam, candidate: Pick<Candidate, 'examNumber' | 'password'>, connection: HydroBrowserConnection,
) {
  connection = hydroBrowserConnection(exam, connection);
  const { origin, base, contestId } = trustedHydroBrowserTarget(exam, connection.baseUrl);
  const loginUrl = `${base}/contest/${contestId}`;
  const auth = await nativeRequest(`${origin}/login`, {
    method: 'POST', headers: { accept: 'application/json' },
    body: new URLSearchParams({ uname: candidate.examNumber, password: candidate.password, redirect: loginUrl }),
  });
  const sid = auth.headers.getSetCookie().map(cookie => /^sid=([A-Za-z0-9_-]{16,256});/i.exec(cookie)?.[1]).find(Boolean);
  if (!auth.ok || !sid) {
    throw new Error('HydroOJ 登录失败，请核对考号、密码及 HydroOJ 原生登录设置');
  }
  const { proctoringKey } = await browserContestRequest(exam, connection, { action: 'bind', username: candidate.examNumber }, sid);
  if (typeof proctoringKey !== 'string' || !/^[\w-]{43}$/.test(proctoringKey)) throw new Error('HydroOJ 未返回监考专用访问凭据');
  return { platform: 'HYDRO_BROWSER' as const, loginUrl, proctoringKey, cookie: { name: 'sid' as const, value: sid } };
}
