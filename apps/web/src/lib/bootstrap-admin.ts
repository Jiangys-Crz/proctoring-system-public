import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import { digestPasswordForStorage } from './password-crypto';

export const BOOTSTRAP_ADMIN_MARKER = 'bootstrap.admin.v1';
const DEVELOPMENT_ADMIN_PASSWORD = 'LocalDemoOnly403!';

export function bootstrapAdministratorPassword(environment: { NODE_ENV?: string; BOOTSTRAP_ADMIN_PASSWORD?: string } = process.env) {
  const password = environment.BOOTSTRAP_ADMIN_PASSWORD;
  if (!password && environment.NODE_ENV !== 'production') return DEVELOPMENT_ADMIN_PASSWORD;
  if (!password || password.trim().length < 12 || password.length > 200
    || [DEVELOPMENT_ADMIN_PASSWORD.toLowerCase(), 'change-this-password', 'your-admin-password', 'your-secure-password'].includes(password.trim().toLowerCase())
    || /^(?:change[\s_-]*me|replace[\s_-]*with)/i.test(password.trim())) {
    throw new Error('首次创建超级管理员须设置 BOOTSTRAP_ADMIN_PASSWORD（12 至 200 位，不能使用公开示例密码）');
  }
  return password;
}

/** A persistent deployment marker prevents re-creating even a deliberately deleted admin. */
export async function ensureBootstrapAdministrator(client: Pick<PrismaClient, '$transaction'>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.$transaction(async tx => {
        await tx.systemSetting.upsert({ where: { key: BOOTSTRAP_ADMIN_MARKER },
          update: {}, create: { key: BOOTSTRAP_ADMIN_MARKER, value: { complete: false } },
        });
        await tx.$queryRaw`SELECT \`key\` FROM SystemSetting WHERE \`key\` = ${BOOTSTRAP_ADMIN_MARKER} FOR UPDATE`;
        const marker = await tx.systemSetting.findUnique({ where: { key: BOOTSTRAP_ADMIN_MARKER } });
        if (marker?.value && typeof marker.value === 'object' && !Array.isArray(marker.value)
          && marker.value.complete === true) return false;
        const existing = await tx.user.findUnique({ where: { username: 'admin' }, select: { id: true } });
        if (!existing) {
          const passwordHash = await bcrypt.hash(digestPasswordForStorage(bootstrapAdministratorPassword()), 12);
          await tx.user.create({ data: {
            username: 'admin', nickname: '系统超级管理员', realName: '系统超级管理员',
            role: 'SUPER_ADMIN', passwordHash,
          } });
        }
        await tx.systemSetting.update({ where: { key: BOOTSTRAP_ADMIN_MARKER },
          data: { value: { complete: true } },
        });
        return !existing;
      }, { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 15_000 });
    } catch (error) {
      if (attempt >= 2 || !error || typeof error !== 'object' || !('code' in error)
        || !['P2002', 'P2034'].includes(String(error.code))) throw error;
    }
  }
}
