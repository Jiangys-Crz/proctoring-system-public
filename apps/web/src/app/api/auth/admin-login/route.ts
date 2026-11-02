import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { options, fail, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { AuthError, requireTrustedMutation, setSessionCookie } from '@/lib/auth';
import { digestPasswordForStorage, PASSWORD_DIGEST_ALGORITHM } from '@/lib/password-crypto';
import { consumeAdministratorLoginAttempt, consumeAdministratorPasswordAttempt } from '@/lib/login-attempts';
import { UploadSecurityError } from '@/lib/upload-security';

const AdminLoginSchema = z.object({
  username: z.string().trim().min(1).max(191),
  password: z.string().min(1).max(200).optional(),
  passwordDigest: z.string().regex(new RegExp(`^${PASSWORD_DIGEST_ALGORITHM}:[a-f0-9]{128}$`)).optional()
}).refine(input => Boolean(input.password || input.passwordDigest), { message: '缺少密码', path: ['password'] });

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request);
    const input = await parseBody(request, AdminLoginSchema, 16 * 1024);
    await consumeAdministratorLoginAttempt(input.username);
    const user = await prisma.user.findUnique({ where: { username: input.username } });
    if (!user?.passwordHash) return fail('账号或密码错误', 401);
    if (user.status === 'DISABLED') return fail('账号已停用，请联系超级管理员', 403);
    await consumeAdministratorPasswordAttempt(user.id);
    const credential = input.passwordDigest || (input.password ? digestPasswordForStorage(input.password) : '');
    if (!credential) return fail('账号或密码错误', 401);
    const matched = await bcrypt.compare(credential, user.passwordHash);
    if (!matched) return fail('账号或密码错误', 401);
    const response = NextResponse.json({
      ok: true,
      data: {
        id: user.id,
        username: user.username,
        numberId: user.numberId,
        realName: user.realName,
        role: user.role
      }
    });
    await setSessionCookie(response, user);
    return response;
  } catch (error) {
    if (error instanceof AuthError || error instanceof UploadSecurityError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
