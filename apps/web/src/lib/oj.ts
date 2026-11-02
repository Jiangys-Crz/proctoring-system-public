import crypto from 'node:crypto';
import type { Candidate, Exam } from '@prisma/client';
import { getHydroSettings } from './settings';
import { novaJudgeContestUrl } from './novajudge';

function signedHeaders(body: unknown, secret: string) {
  const timestamp = String(Date.now());
  const payload = `${timestamp}.${JSON.stringify(body)}`;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return {
    'content-type': 'application/json',
    'x-proctor-timestamp': timestamp,
    'x-proctor-signature': signature
  };
}

function apiKeyHeaders(apiKey: string) {
  return { 'x-proctor-api-key': apiKey };
}

export async function requestOjLogin(exam: Exam, _candidate: Candidate) {
  if (exam.platform === 'NOVAJUDGE') return novaJudgeContestUrl(exam);
  const settings = await getHydroSettings();
  const body = {
    contestId: exam.platformContestId,
    // Hydro is only the shared problem bank/judge. Candidate identity and
    // passwords stay in this project; the plugin logs into one shared account.
    account: settings.judgeUsername,
    redirect: `/contest/${exam.platformContestId}`
  };
  const internalBase = process.env.HYDRO_PROCTOR_INTERNAL_BASE_URL || process.env.HYDRO_PROCTOR_BASE_URL;
  const requestBase = new URL(settings.baseUrl).hostname === 'localhost' && internalBase
    ? internalBase.replace(/\/$/, '')
    : settings.baseUrl.replace(/\/$/, '');
  const response = await fetch(`${requestBase}/api/proctor/login-ticket`, {
    method: 'POST',
    headers: { ...signedHeaders(body, settings.sharedSecret), ...apiKeyHeaders(settings.apiKey) },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000)
  });
  const result = (await response.json()) as { ok?: boolean; loginUrl?: string; message?: string };
  if (!response.ok || !result.loginUrl) throw new Error(result.message || '评测服务连接凭证获取失败');
  return result.loginUrl;
}
