import { isIP } from 'node:net';
import type { Prisma } from '@prisma/client';
import { LoginFlowError } from './room-login-policy';

export function normalizeLoginIp(input: string | null | undefined): string | null {
  const trimmed = input?.trim() || '';
  const value = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const first = parseInt(mapped[1], 16), second = parseInt(mapped[2], 16);
  return [first >> 8, first & 255, second >> 8, second & 255].join('.');
}

/** Caddy supplies this header over the backend's loopback-only listener.
 * The IP is never accepted from a request body or from the second camera. */
export function desktopRequestIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return normalizeLoginIp(forwarded.split(',')[0]);
  const real = request.headers.get('x-real-ip');
  if (real) return normalizeLoginIp(real);
  const hostname = new URL(request.url).hostname;
  if (process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return '127.0.0.1';
  return null;
}

export function assertLoginIp(enabled: boolean, boundIp: string | null, incomingIp: string | null) {
  if (!enabled) return;
  if (!incomingIp) throw new LoginFlowError('无法确认电脑端登录 IP，请重新生成登录二维码或联系监考老师', 403);
  if (boundIp && boundIp !== incomingIp) throw new LoginFlowError('该账号已绑定其他登录 IP，请联系监考老师在“登录限制”中解除一次限制后重试', 403);
}

/** Called only during a successful NEW login/reconnect, inside its transaction.
 * Row locking makes an unlock usable by exactly the next successful login. */
export async function bindCandidateLoginIp(tx: Prisma.TransactionClient, examId: string, candidateId: string, incomingIp: string | null) {
  await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${candidateId} FOR UPDATE`;
  const [exam, candidate] = await Promise.all([
    tx.exam.findUnique({ where: { id: examId }, select: { ipLoginRestrictionEnabled: true } }),
    tx.candidate.findUnique({ where: { id: candidateId }, select: { examId: true, loginIp: true } })
  ]);
  if (!exam || !candidate || candidate.examId !== examId) throw new LoginFlowError('考生不存在', 404);
  assertLoginIp(exam.ipLoginRestrictionEnabled, candidate.loginIp, incomingIp);
  // While disabled, record the latest successful login so enabling the switch
  // immediately restricts subsequent logins to that IP.
  if (incomingIp) await tx.candidate.update({ where: { id: candidateId }, data: {
    loginIp: incomingIp, loginIpBoundAt: new Date(), loginIpReleasedAt: null
  } });
}
