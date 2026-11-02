import { z } from 'zod';
import { NextResponse } from 'next/server';
import { requireTrustedMutation, setSessionCookie } from '@/lib/auth';
import { loginAssociationAdministrator } from '@/lib/association-users';
import { AuthError } from '@/lib/auth';
import { ExternalLoginError } from '@/lib/cwnupaa';
import { UploadSecurityError } from '@/lib/upload-security';
import { consumeAdministratorLoginAttempt } from '@/lib/login-attempts';
import { options, fail, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const ExternalLoginSchema = z.object({
  account: z.string().trim().min(1).max(191),
  password: z.string().min(1).max(200)
});

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request);
    const input = await parseBody(request, ExternalLoginSchema, 16 * 1024);
    await consumeAdministratorLoginAttempt(input.account);
    const user = await loginAssociationAdministrator(input.account, input.password);

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
    if (error instanceof AuthError || error instanceof UploadSecurityError || error instanceof ExternalLoginError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
