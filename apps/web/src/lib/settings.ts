import { z } from 'zod';
import { prisma } from './db';
import type { HydroConnectionSettings } from './hydro-settings-contract';
import type { Prisma } from '@prisma/client';
import { createSettingCache } from './setting-cache';

export const StorageSettingsSchema = z.object({
  provider: z.enum(['LOCAL', 'S3']).default('LOCAL'),
  localUploadDir: z.string().default('./uploads'),
  s3: z
    .object({
      endpoint: z.string().url().optional(),
      region: z.string().default('auto'),
      bucket: z.string().optional(),
      accessKeyId: z.string().optional(),
      secretAccessKey: z.string().optional(),
      forcePathStyle: z.boolean().default(true),
      publicBaseUrl: z.string().url().optional()
    })
    .default({ region: 'auto', forcePathStyle: true })
});

export type StorageSettings = z.infer<typeof StorageSettingsSchema>;

export const ExternalLoginSettingsSchema = z.object({
  apiBase: z.string().url().default('https://www.example.org/api'),
  appKey: z.string().default('')
});

export type ExternalLoginSettings = z.infer<typeof ExternalLoginSettingsSchema>;

const HydroBaseUrlSchema = z.string().trim().url().refine((value) => {
  const url = new URL(value);
  return /^https?:\/\//i.test(value) && !/[\\\s?#]/.test(value)
    && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    && url.pathname === '/' && !url.search && !url.hash;
}, '服务地址必须是 HTTP 或 HTTPS 主地址，不能包含账号、空白、子路由、查询参数或片段').transform(value => new URL(value).origin);

/**
 * Hydro is the shared problem-bank and judge service.  Keep its connection
 * details in the local database so changing the OJ does not require changing
 * every exam or rebuilding the web container.
 */
export const HydroSettingsSchema = z.object({
  baseUrl: HydroBaseUrlSchema.default(process.env.HYDRO_PROCTOR_PUBLIC_URL || 'http://localhost'),
  apiKey: z.string().default(process.env.HYDRO_PROCTOR_API_KEY || ''),
  sharedSecret: z.string().default(process.env.HYDRO_PROCTOR_SHARED_SECRET || ''),
  problemDomainId: z.string().trim().min(1).max(100).regex(/^[^\s/\\?#\0]+$/, '题库域 ID 不能包含空白或路径字符').default(process.env.HYDRO_PROCTOR_PROBLEM_DOMAIN || 'Problems'),
  judgeUsername: z.string().trim().default(process.env.HYDRO_PROCTOR_JUDGE_ACCOUNT || 'proctor-judge'),
  judgePassword: z.string().default(process.env.HYDRO_PROCTOR_JUDGE_PASSWORD || '')
});

export type HydroSettings = z.infer<typeof HydroSettingsSchema>;
export const HydroConnectionSettingsSchema = HydroSettingsSchema.pick({ baseUrl: true, apiKey: true, problemDomainId: true });

export const defaultStorageSettings: StorageSettings = {
  provider: 'LOCAL',
  localUploadDir: process.env.PROCTOR_UPLOAD_DIR || './uploads',
  s3: {
    region: 'auto',
    forcePathStyle: true
  }
};

export const defaultExternalLoginSettings: ExternalLoginSettings = {
  apiBase: process.env.CWNUPAA_EXTERNAL_API_BASE || 'https://www.example.org/api',
  appKey: process.env.CWNUPAA_EXTERNAL_APP_KEY || ''
};

export const defaultHydroSettings: HydroSettings = {
  baseUrl: process.env.HYDRO_PROCTOR_PUBLIC_URL || 'http://localhost',
  apiKey: process.env.HYDRO_PROCTOR_API_KEY || '',
  sharedSecret: process.env.HYDRO_PROCTOR_SHARED_SECRET || '',
  problemDomainId: process.env.HYDRO_PROCTOR_PROBLEM_DOMAIN || 'Problems',
  judgeUsername: process.env.HYDRO_PROCTOR_JUDGE_ACCOUNT || 'proctor-judge',
  judgePassword: process.env.HYDRO_PROCTOR_JUDGE_PASSWORD || ''
};

const storageCache = createSettingCache<StorageSettings>();
const externalLoginCache = createSettingCache<ExternalLoginSettings>();
const hydroCache = createSettingCache<HydroSettings>();

export async function getStorageSettings(client: Pick<Prisma.TransactionClient, 'systemSetting'> = prisma) {
  const load = async () => {
    const row = await client.systemSetting.findUnique({ where: { key: 'storage' } });
    return StorageSettingsSchema.parse(row?.value || defaultStorageSettings);
  };
  // Transaction reads retain their own snapshot and never borrow another pool connection.
  return client === prisma ? storageCache.read(load) : load();
}

export async function saveStorageSettings(input: StorageSettings) {
  const value = StorageSettingsSchema.parse(input);
  await prisma.systemSetting.upsert({
    where: { key: 'storage' },
    update: { value },
    create: { key: 'storage', value }
  });
  storageCache.invalidate();
  return value;
}

export async function getExternalLoginSettings() {
  return externalLoginCache.read(async () => {
    const row = await prisma.systemSetting.findUnique({ where: { key: 'externalLogin' } });
    return ExternalLoginSettingsSchema.parse(row?.value || defaultExternalLoginSettings);
  });
}

export async function saveExternalLoginSettings(input: ExternalLoginSettings) {
  const value = ExternalLoginSettingsSchema.parse(input);
  await prisma.systemSetting.upsert({
    where: { key: 'externalLogin' },
    update: { value },
    create: { key: 'externalLogin', value }
  });
  externalLoginCache.invalidate();
  return value;
}

export async function getHydroSettings() {
  return hydroCache.read(async () => {
    const row = await prisma.systemSetting.findUnique({ where: { key: 'hydro' } });
    return HydroSettingsSchema.parse(row?.value || defaultHydroSettings);
  });
}

export async function saveHydroSettings(input: HydroConnectionSettings) {
  const value = HydroSettingsSchema.parse({ ...await getHydroSettings(), ...input });
  await prisma.systemSetting.upsert({
    where: { key: 'hydro' },
    update: { value },
    create: { key: 'hydro', value }
  });
  hydroCache.invalidate();
  return value;
}
