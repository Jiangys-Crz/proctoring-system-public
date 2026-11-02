import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { options, fail, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { requireTrustedMutation, setSessionCookie } from '@/lib/auth';
import { loginAssociationAdministrator } from '@/lib/association-users';
import { AuthError } from '@/lib/auth';
import { ExternalLoginError } from '@/lib/cwnupaa';
import { UploadSecurityError } from '@/lib/upload-security';
import { consumeAdministratorLoginAttempt, consumeAdministratorPasswordAttempt } from '@/lib/login-attempts';
import { digestPasswordForStorage, PASSWORD_DIGEST_ALGORITHM } from '@/lib/password-crypto';

const LoginSchema = z
  .object({
    account: z.string().trim().min(1).max(191),
    passwordDigest: z.string().regex(new RegExp(`^${PASSWORD_DIGEST_ALGORITHM}:[a-f0-9]{128}$`)).optional(),
    password: z.string().min(1).max(200).optional()
  })
  .refine((input) => Boolean(input.passwordDigest || input.password), {
    message: '缺少密码',
    path: ['password']
  });

function publicUser(user: {
  id: string;
  username: string | null;
  numberId: string | null;
  realName: string | null;
  role: 'ADMIN' | 'SUPER_ADMIN';
}) {
  return {
    id: user.id,
    username: user.username,
    numberId: user.numberId,
    realName: user.realName,
    role: user.role
  };
}

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request);
    const input = await parseBody(request, LoginSchema, 16 * 1024);
    await consumeAdministratorLoginAttempt(input.account);
    const identified = await prisma.user.findUnique({ where: { username: input.account } })
      || await prisma.user.findUnique({ where: { email: input.account } });
    const matches = identified ? [identified] : await prisma.user.findMany({ where: {
      numberId: input.account
    } });

    if (matches.length > 1 && !input.password) return fail('该学号对应多个用户，请使用用户名或邮箱登录', 400);
    // Ambiguous local records must be resolved by the verified official identity.
    const internal = matches.length === 1 ? matches[0] : undefined;
    if (internal?.passwordHash) {
      if (internal.status === 'DISABLED') return fail('账号已停用，请联系超级管理员', 403);
      await consumeAdministratorPasswordAttempt(internal.id);
      const credential = input.passwordDigest || (input.password ? digestPasswordForStorage(input.password) : '');
      const matched = await bcrypt.compare(credential, internal.passwordHash);
      if (!matched && (!internal.associationImported || !input.password)) return fail('账号或密码错误', 401);
      if (!matched) {
        const user = await loginAssociationAdministrator(input.account, input.password!);
        const response = NextResponse.json({ ok: true, data: publicUser(user) });
        await setSessionCookie(response, user);
        return response;
      }

      const response = NextResponse.json({ ok: true, data: publicUser(internal) });
      await setSessionCookie(response, internal);
      return response;
    }

    if (!input.password) return fail('INTERNAL_ACCOUNT_NOT_FOUND', 404);

    const user = await loginAssociationAdministrator(input.account, input.password);

    const response = NextResponse.json({ ok: true, data: publicUser(user) });
    await setSessionCookie(response, user);
    return response;
  } catch (error) {
    if (error instanceof AuthError || error instanceof UploadSecurityError || error instanceof ExternalLoginError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
