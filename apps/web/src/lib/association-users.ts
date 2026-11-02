import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from './db';
import { externalPasswordLogin, getExternalNumberId, getExternalSchool, getExternalUserId } from './cwnupaa';
import { digestPasswordForStorage } from './password-crypto';
import { AuthError } from './auth';

export const AssociationImportSchema = z.object({
  users: z.array(z.object({ realName: z.string().trim().min(1).max(191), numberId: z.string().trim().min(1).max(191) })).min(1).max(2000)
});

export async function importAssociationUsers(users: z.infer<typeof AssociationImportSchema>['users']) {
  const seen = new Set<string>();
  for (const row of users) {
    const key = `${row.realName.toLocaleLowerCase()}\0${row.numberId.toLocaleLowerCase()}`;
    if (seen.has(key)) throw new AuthError(`姓名 ${row.realName} 的学号 ${row.numberId} 重复`, 400);
    seen.add(key);
  }
  return prisma.$transaction(async tx => {
    for (const row of users) {
      const existing = await tx.user.findUnique({ where: { realName_numberId: row } });
      if (existing && !existing.associationImported && existing.passwordHash) throw new AuthError(`姓名 ${row.realName} 的学号 ${row.numberId} 已属于本地用户`, 400);
      const legacy = existing ? null : await tx.user.findMany({ where: { numberId: row.numberId, realName: null, passwordHash: null } });
      const target = existing || (legacy?.length === 1 ? legacy[0] : null);
      // Re-import never resets credentials, status or privileges.
      if (target) await tx.user.update({ where: { id: target.id }, data: { realName: row.realName, associationImported: true } });
      else await tx.user.create({ data: { ...row, associationImported: true, role: 'ADMIN' } });
    }
    return { imported: users.length };
  }, { timeout: 30_000 });
}

export async function loginAssociationAdministrator(account: string, password: string) {
  const external = await externalPasswordLogin(account, password);
  const numberId = getExternalNumberId(external), realName = external.realName?.trim() || '', school = getExternalSchool(external), externalId = getExternalUserId(external);
  if (!numberId || !realName) throw new AuthError('协会账号缺少姓名或学号信息，请检查官网资料及登录接口', 403);
  if (!externalId) throw new AuthError('协会账号身份信息不完整', 403);
  const passwordHash = await bcrypt.hash(digestPasswordForStorage(password), 12);
  return prisma.$transaction(async tx => {
    const bound = await tx.user.findUnique({ where: { associationUserId: externalId } });
    const exact = await tx.user.findUnique({ where: { realName_numberId: { realName, numberId } } });
    if (bound && exact && bound.id !== exact.id) throw new AuthError('官网身份与管理员名单冲突，请联系超级管理员', 403);
    let imported = bound || exact;
    if (!imported) {
      const legacy = await tx.user.findMany({ where: { numberId, realName: null, passwordHash: null, associationUserId: null } });
      if (legacy.length === 1) imported = legacy[0];
    }
    if (imported) {
      await tx.$queryRaw`SELECT id FROM User WHERE id = ${imported.id} FOR UPDATE`;
      imported = await tx.user.findUnique({ where: { id: imported.id } });
    }
    if (!imported || (!imported.associationImported && imported.passwordHash)) throw new AuthError('该姓名和学号尚未被加入协会管理员名单', 403);
    if (imported.status === 'DISABLED') throw new AuthError('账号已停用，请联系超级管理员', 403);
    if (imported.associationUserId && imported.associationUserId !== externalId) throw new AuthError('该管理员记录已绑定其他协会账号', 403);
    return tx.user.update({ where: { id: imported.id }, data: {
      school: school || imported.school, numberId, associationImported: true, associationUserId: externalId, associationVerifiedAt: new Date(), passwordHash,
      username: external.userAccount?.trim() || imported.username,
      nickname: external.userName?.trim() || imported.nickname,
      realName: external.realName?.trim() || imported.realName,
      email: external.email?.trim() || imported.email
    } });
  }, { isolationLevel: 'ReadCommitted' });
}
