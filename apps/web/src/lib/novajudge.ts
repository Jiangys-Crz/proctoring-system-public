import type { Candidate, Exam } from '@prisma/client';

type NovaExam = Pick<Exam, 'platformBaseUrl' | 'platformContestId'> & { novaJudgeApiKey?: string | null };

export function novaJudgeOrigin(value: string) {
  let url: URL;
  try { url = new URL(value.includes('://') ? value : `https://${value}`); }
  catch { throw new Error('请输入有效的 NovaJudge 平台域名'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || url.pathname !== '/' || /[\\\s]/.test(value)) {
    throw new Error('NovaJudge 平台域名必须是 HTTP/HTTPS 地址，不能包含路径、账号或查询参数');
  }
  return url.origin;
}

export function novaJudgeContestId(value: string) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('NovaJudge 比赛 ID 必须是有效的正整数');
  }
  return Number(value);
}

export function novaJudgeContestUrl(exam: Pick<NovaExam, 'platformBaseUrl' | 'platformContestId'>) {
  return `${novaJudgeOrigin(exam.platformBaseUrl)}/contest/${novaJudgeContestId(exam.platformContestId)}`;
}

/** The password travels only server-to-server. The desktop installs this token
 * as an HttpOnly cookie; it never appears in a URL, ticket row or Nova page JS. */
export async function loginNovaJudge(exam: NovaExam, candidate: Pick<Candidate, 'examNumber' | 'password'>) {
  const origin = novaJudgeOrigin(exam.platformBaseUrl);
  const contestId = novaJudgeContestId(exam.platformContestId);
  if (!exam.novaJudgeApiKey?.trim()) throw new Error('请填写 NovaJudge 外榜 API Key，以授权监考专用登录');
  let response: Response;
  try {
    response = await fetch(`${origin}/api/cli/login`, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', 'x-api-key': exam.novaJudgeApiKey.trim() },
      body: JSON.stringify({ username: candidate.examNumber, password: candidate.password, contestId, loginSource: 'PROCTORING' }),
    });
  } catch { throw new Error('NovaJudge 连接失败或超时，请联系监考老师检查平台域名'); }
  if (response.status === 401) throw new Error('NovaJudge 考号或密码错误，请确认考生账号属于指定比赛且与监考名单一致');
  if (response.status === 403) throw new Error('NovaJudge 监考登录未获授权，请检查外榜 API Key 是否有效且属于超级管理员');
  if (!response.ok) throw new Error('NovaJudge 登录失败，请检查比赛 ID、账号和平台服务');
  const body = await response.json().catch(() => null);
  if (typeof body?.token !== 'string' || !body.token || body.token.length > 8192
    || body.user?.contestId !== contestId || body.user?.username !== candidate.examNumber || body.user?.role !== 'TEAM'
    || body.loginSource !== 'PROCTORING' || typeof body.proctoringKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.proctoringKey)) {
    throw new Error('NovaJudge 未返回当前比赛的有效选手登录凭据');
  }
  if (body.contestAccessToken != null && (typeof body.contestAccessToken !== 'string'
    || body.contestAccessToken.length > 8192
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body.contestAccessToken))) {
    throw new Error('NovaJudge 返回的比赛授权格式无效');
  }
  return { platform: 'NOVAJUDGE' as const, loginUrl: `${origin}/contest/${contestId}`,
    loginSource: 'PROCTORING' as const, proctoringKey: body.proctoringKey as string,
    ...(body.contestAccessToken ? { contestAccessToken: body.contestAccessToken as string } : {}),
    cookie: { name: 'user_token' as const, value: body.token } };
}

export async function readNovaJudgeArray(exam: NovaExam, kind: 'problems' | 'submissions', signal?: AbortSignal) {
  if (!exam.novaJudgeApiKey?.trim()) throw new Error('请填写 NovaJudge 外榜 API Key');
  const url = `${novaJudgeOrigin(exam.platformBaseUrl)}/api/contests/${novaJudgeContestId(exam.platformContestId)}/${kind}`;
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'error', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      headers: { 'x-api-key': exam.novaJudgeApiKey.trim() } });
  } catch { throw new Error('读取 NovaJudge 外榜数据失败或超时'); }
  if (response.status === 401 || response.status === 403) throw new Error('NovaJudge 外榜 API Key 无效或未启用');
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(body)) throw new Error('NovaJudge 外榜接口返回异常，请检查平台域名和比赛 ID');
  return body as Array<Record<string, unknown>>;
}
