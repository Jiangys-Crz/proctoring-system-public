import crypto from 'node:crypto';
import type { ClientSession } from '@prisma/client';
import { prisma } from './db';

export type ClientSide = 'DESKTOP' | 'MINIPROGRAM';

const TOKEN_BYTES = 32;

export function createClientSessionToken() {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashClientSessionToken(token) };
}

export function hashClientSessionToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function clientSessionTokenFromRequest(request: Request) {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer || request.headers.get('x-proctor-session-token') || '';
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function expectedHash(session: Pick<ClientSession, 'desktopTokenHash' | 'miniProgramTokenHash'>, side: ClientSide) {
  return side === 'DESKTOP' ? session.desktopTokenHash : session.miniProgramTokenHash;
}

export function verifyClientTokenForSession(
  request: Request,
  session: Pick<ClientSession, 'desktopTokenHash' | 'miniProgramTokenHash'> & { revokedAt?: Date | null },
  side: ClientSide
) {
  return verifyClientTokenValueForSession(clientSessionTokenFromRequest(request), session, side);
}

export function verifyClientTokenValueForSession(
  token: string,
  session: Pick<ClientSession, 'desktopTokenHash' | 'miniProgramTokenHash'> & { revokedAt?: Date | null },
  side: ClientSide
) {
  if (session.revokedAt) return false;
  const hash = expectedHash(session, side);
  if (!token || !hash) return false;
  return safeEqual(hashClientSessionToken(token), hash);
}

export function verifyClientTokenForAnySide(
  request: Request,
  session: Pick<ClientSession, 'desktopTokenHash' | 'miniProgramTokenHash'>
) {
  return verifyClientTokenForSession(request, session, 'DESKTOP') || verifyClientTokenForSession(request, session, 'MINIPROGRAM');
}

export async function requireClientSession<T extends boolean | 'contest-summary' = false>(
  request: Request,
  sessionId: string,
  side: ClientSide,
  includeExam?: T
) {
  const session = await prisma.clientSession.findUnique({
    where: { id: sessionId },
    include: includeExam
      ? { exam: { include: { problems: {
          orderBy: { order: 'asc' },
          // Polls need score/visibility metadata, not statements, attachments or
          // private judge configuration. Authentication still reads fresh rows.
          ...(includeExam === 'contest-summary' ? { select: {
            id: true, order: true, title: true, scorePercent: true,
            problemType: true, score: true, hydroScore: true, updatedAt: true,
          } } : {}),
        } } }, candidate: true }
      : undefined
  });
  if (!session) return { ok: false as const, status: 404, message: '客户端会话不存在' };
  if (!verifyClientTokenForSession(request, session, side)) {
    return { ok: false as const, status: 401, message: '客户端会话令牌无效或已过期' };
  }
  return { ok: true as const, session };
}

export function publicClientSession<T extends Partial<ClientSession> | null | undefined>(session: T) {
  if (!session) return session;
  const { desktopTokenHash: _desktopTokenHash, miniProgramTokenHash: _miniProgramTokenHash, monitoringAlertState: _monitoringAlertState, ...safeSession } = session;
  return safeSession;
}
