import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import type { Role, User } from '@prisma/client';
import { prisma } from './db';
import { optionalEnv } from './env';
import { isTrustedMutationOrigin } from './request-origin';

const COOKIE_NAME = 'cwnupaa_proctor_session';

function secureCookieEnabled() {
  return optionalEnv('APP_BASE_URL', '').startsWith('https://');
}

export interface SessionPayload {
  sub: string;
  role: Role;
  username?: string | null;
  numberId?: string | null;
  exp: number;
}

function base64url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url');
}

function sign(value: string) {
  const secret = optionalEnv('SESSION_SECRET', 'dev-session-secret-change-me');
  if (process.env.NODE_ENV === 'production' && secret === 'dev-session-secret-change-me') {
    throw new Error('Missing required environment variable: SESSION_SECRET');
  }
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function createSessionToken(user: Pick<User, 'id' | 'role' | 'username' | 'numberId'>) {
  const payload: SessionPayload = {
    sub: user.id,
    role: user.role,
    username: user.username,
    numberId: user.numberId,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  const expected = sign(encoded);
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export async function setSessionCookie(response: NextResponse, user: Pick<User, 'id' | 'role' | 'username' | 'numberId'>) {
  response.cookies.set(COOKIE_NAME, createSessionToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookieEnabled(),
    path: '/',
    maxAge: 60 * 60 * 12
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookieEnabled(),
    path: '/',
    maxAge: 0
  });
}

export async function getCurrentUser() {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const payload = verifySessionToken(token);
  if (!payload) return null;
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  return user?.status === 'ACTIVE' ? user : null;
}

export function requireTrustedMutation(request: Request) {
  if (!isTrustedMutationOrigin(request)) throw new AuthError('请求来源不受信任，请在管理页面重新操作', 403);
}

export async function requireUser(request?: Request) {
  if (request) requireTrustedMutation(request);
  const user = await getCurrentUser();
  if (!user) throw new AuthError('请先登录', 401);
  return user;
}

export async function requireSuperAdmin(request?: Request) {
  const user = await requireUser(request);
  if (user.role !== 'SUPER_ADMIN') throw new AuthError('需要超级管理员权限', 403);
  return user;
}

export class AuthError extends Error {
  constructor(message: string, public status = 401) {
    super(message);
  }
}
