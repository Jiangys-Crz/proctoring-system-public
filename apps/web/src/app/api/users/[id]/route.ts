import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db';
import { AuthError, requireSuperAdmin } from '@/lib/auth';
import { digestPasswordForStorage } from '@/lib/password-crypto';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const PatchUserSchema = z.object({
  role: z.enum(['ADMIN', 'SUPER_ADMIN']).optional(),
  nickname: z.string().optional(),
  username: z.string().trim().max(100).optional(),
  realName: z.string().trim().max(100).optional(),
  school: z.string().trim().max(200).optional(),
  numberId: z.string().trim().min(1).max(100).optional(),
  email: z.union([z.string().trim().email(), z.literal('')]).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  password: z.string().min(6).max(200).optional()
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireSuperAdmin(request);
    const { id } = await context.params;
    const input = await parseBody(request, PatchUserSchema);
    const { password, ...fields } = input;
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return fail('用户不存在', 404);
    if (existing.associationImported && existing.associationVerifiedAt &&
      ((fields.realName !== undefined && fields.realName !== existing.realName) || (fields.numberId !== undefined && fields.numberId !== existing.numberId))) return fail('已验证的姓名和学号由官网同步，不能手动修改', 400);
    if (existing.associationImported && !existing.associationVerifiedAt && password) return fail('协会用户须先通过官网验证，才能设置本地密码', 400);
    if (!existing.associationImported && (!fields.username?.trim() && fields.username !== undefined || !fields.realName?.trim() && fields.realName !== undefined)) return fail('本地用户的用户名和姓名不能为空', 400);
    const user = await prisma.user.update({
      where: { id },
      data: {
        ...fields,
        ...(fields.username === '' ? { username: null } : {}),
        ...(fields.realName === '' ? { realName: null } : {}),
        ...(fields.email === '' ? { email: null } : {}),
        ...(password ? { passwordHash: await bcrypt.hash(digestPasswordForStorage(password), 12) } : {})
      },
      select: {
        id: true,
        numberId: true,
        username: true,
        nickname: true,
        realName: true,
        school: true,
        email: true,
        role: true,
        status: true
      }
    });
    return ok(user);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await requireSuperAdmin(_request);
    const { id } = await context.params;
    if (id === currentUser.id) return fail('不能删除当前登录账号', 400);

    await prisma.user.delete({ where: { id } });
    return ok({ deleted: true });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
