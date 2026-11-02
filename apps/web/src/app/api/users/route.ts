import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db';
import { AuthError, requireSuperAdmin } from '@/lib/auth';
import { digestPasswordForStorage } from '@/lib/password-crypto';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const ImportUsersSchema = z.object({
  users: z.array(z.object({
    username: z.string().trim().min(1).max(100),
    realName: z.string().trim().min(1).max(100),
    school: z.string().trim().min(1).max(200),
    numberId: z.string().trim().min(1).max(100),
    email: z.string().trim().email().optional(),
    password: z.string().min(6).max(200),
    status: z.enum(['ACTIVE', 'DISABLED']).default('ACTIVE'),
    role: z.enum(['ADMIN', 'SUPER_ADMIN']).default('ADMIN')
  })).min(1).max(2000)
});

export async function GET() {
  try {
    await requireSuperAdmin();
    const users = await prisma.user.findMany({
      orderBy: [{ role: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        numberId: true,
        username: true,
        nickname: true,
        realName: true,
        school: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        associationImported: true,
        associationVerifiedAt: true
      }
    });
    return ok(users);
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function POST(request: Request) {
  try {
    await requireSuperAdmin(request);
    const input = await parseBody(request, ImportUsersSchema);
    const duplicateFields = [
      ['用户名', input.users.map(user => user.username.toLocaleLowerCase())],
      ['姓名和学号', input.users.map(user => `${user.realName.toLocaleLowerCase()}\0${user.numberId}`)],
      ['邮箱', input.users.map(user => user.email?.toLocaleLowerCase()).filter(Boolean)]
    ] as const;
    for (const [label, values] of duplicateFields) {
      if (new Set(values).size !== values.length) throw new RequestParseError(`导入内容中存在重复${label}`);
    }
    const rows = await Promise.all(input.users.map(async user => ({
      ...user,
      email: user.email || null,
      passwordHash: await bcrypt.hash(digestPasswordForStorage(user.password), 12)
    })));
    const imported = await prisma.$transaction(async tx => {
      const result = [];
      for (const row of rows) {
        const matches = await tx.user.findMany({
          where: { OR: [{ username: row.username }, { realName: row.realName, numberId: row.numberId }, ...(row.email ? [{ email: row.email }] : [])] },
          select: { id: true, associationImported: true }
        });
        if (matches.some(user => user.associationImported)) throw new RequestParseError(`用户 ${row.username} 已属于协会账号，请通过编辑修改`);
        const ids = Array.from(new Set(matches.map(item => item.id)));
        if (ids.length > 1) throw new RequestParseError(`用户 ${row.username} 的用户名、学号或邮箱分别属于不同账号`);
        const data = { username: row.username, realName: row.realName, school: row.school, numberId: row.numberId, email: row.email, passwordHash: row.passwordHash, status: row.status, role: row.role };
        result.push(ids[0] ? await tx.user.update({ where: { id: ids[0] }, data }) : await tx.user.create({ data }));
      }
      return result;
    });
    return ok({ imported: imported.length });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
