import { getExternalLoginSettings } from './settings';

export interface ExternalUserInfo {
  userId: number | string;
  userAccount?: string;
  userName?: string;
  realName?: string;
  numberId?: string;
  studentId?: string;
  studentNo?: string;
  studentNumber?: string;
  number?: string;
  email?: string;
  universityName?: string;
  school?: string;
}

interface ExternalLoginResponse {
  code: number;
  msg: string;
  data: ExternalUserInfo | null;
}

export class ExternalLoginError extends Error {
  constructor(message: string, public status = 401) { super(message); }
}

export async function externalPasswordLogin(account: string, credential: string) {
  const settings = await getExternalLoginSettings();
  const endpoint = settings.apiBase.replace(/\/$/, '');
  const appKey = settings.appKey;
  if (!appKey) throw new Error('请先在系统管理中配置协会官网登录 API AppKey');
  const response = await fetch(`${endpoint}/user/external/login`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      appKey,
      loginType: 'password',
      account,
      credential
    })
  });
  const body = (await response.json()) as ExternalLoginResponse;
  if (!response.ok || Number(body.code) !== 200 || !body.data) {
    throw new ExternalLoginError('官网账号或密码验证失败');
  }
  return body.data;
}

export function getExternalNumberId(user: ExternalUserInfo) {
  return `${user.numberId || user.studentId || user.studentNo || user.studentNumber || user.number || ''}`.trim();
}

// universityName is the university; schoolName in the official site denotes a college.
export function getExternalSchool(user: ExternalUserInfo) {
  return `${user.universityName || user.school || ''}`.trim();
}
export function getExternalUserId(user: ExternalUserInfo) {
  return typeof user.userId === 'number' && Number.isSafeInteger(user.userId) && user.userId > 0
    ? String(user.userId) : typeof user.userId === 'string' && /^\d+$/.test(user.userId) && BigInt(user.userId) > 0n ? String(BigInt(user.userId)) : '';
}
