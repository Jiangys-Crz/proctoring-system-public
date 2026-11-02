import path from 'node:path';
import crypto from 'node:crypto';
import { link, mkdir, rename, unlink, writeFile, realpath, stat } from 'node:fs/promises';
import { PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { optionalEnv } from './env';
import { getStorageSettings, type StorageSettings } from './settings';
import { withS3Client } from './s3-client-pool';

export interface StoredObject {
  objectPath: string;
  url?: string;
  provider: 'LOCAL' | 'S3';
}

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function encodeObjectKey(key: string) {
  return key.split('/').map(encodeURIComponent).join('/');
}

function mediaUrlSecret() {
  const secret = optionalEnv('MEDIA_URL_SECRET', optionalEnv('SESSION_SECRET', 'dev-session-secret-change-me'));
  if (process.env.NODE_ENV === 'production' && secret === 'dev-session-secret-change-me') throw new Error('媒体访问签名密钥未配置');
  return secret;
}

function signObjectKey(key: string, expiresAt: number) {
  return crypto.createHmac('sha256', mediaUrlSecret()).update(`${key}.${expiresAt}`).digest('base64url');
}

function localObjectKey(objectPath: string) {
  if (objectPath.startsWith('/api/uploads/file/')) {
    const raw = objectPath.slice('/api/uploads/file/'.length).split('?')[0] || '';
    return raw.split('/').map(decodeURIComponent).join('/');
  }
  return objectPath;
}

export function signedLocalObjectUrl(objectPath: string, ttlSeconds = 10 * 60) {
  const key = localObjectKey(objectPath);
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const encoded = encodeObjectKey(key);
  return `/api/uploads/file/${encoded}?exp=${expiresAt}&sig=${encodeURIComponent(signObjectKey(key, expiresAt))}`;
}

export function verifySignedLocalObjectUrl(key: string, exp: string | null, sig: string | null) {
  const expiresAt = Number(exp || 0);
  if (!Number.isSafeInteger(expiresAt) || !sig || expiresAt < Math.floor(Date.now() / 1000)) return false;
  const expected = signObjectKey(key, expiresAt);
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export async function publicObjectUrl(objectPath?: string | null, localTtlSeconds = 10 * 60) {
  if (!objectPath) return objectPath;
  if (/^(https?:|data:|blob:)/i.test(objectPath)) {
    return objectPath;
  }

  const settings = await getStorageSettings();
  if (settings.provider === 'S3' && settings.s3.publicBaseUrl) {
    return `${settings.s3.publicBaseUrl.replace(/\/$/, '')}/${encodeObjectKey(objectPath)}`;
  }
  return signedLocalObjectUrl(objectPath, localTtlSeconds);
}

export function validatedStorageKey(prefix: string, filename: string) {
  if (!prefix || prefix.includes('\\') || prefix.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error('存储路径不正确');
  }
  if (!filename || filename === '.' || filename === '..') throw new Error('存储文件名不正确');
  return `${prefix}/${filename}`;
}

/** Delete only a provider-independent key inside the configured upload store. */
export async function deleteStoredObject(key: string, destination?: StorageSettings) {
  if (!key || key.includes('\\') || key.includes('\0') || key.split('/').some(part => !part || part === '.' || part === '..') || /^(?:https?:|data:|blob:)/i.test(key)) {
    throw new Error('存储路径不正确');
  }
  const settings = destination || await getStorageSettings();
  if (settings.provider === 'S3') {
    if (!settings.s3.bucket || !settings.s3.accessKeyId || !settings.s3.secretAccessKey) throw new Error('对象存储未配置完整');
    await withS3Client(settings, client => client.send(new DeleteObjectCommand({ Bucket: settings.s3.bucket, Key: key }), { abortSignal: AbortSignal.timeout(10_000) }));
    return;
  }
  try {
    const root = await realpath(path.resolve(/* turbopackIgnore: true */ process.cwd(), settings.localUploadDir || './uploads'));
    const full = path.join(root, key);
    const resolved = await realpath(full);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('存储路径不正确');
    await unlink(full);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

/** Recheck evidence existence and size without trusting arbitrary URLs or following symlinks. */
export async function storedObjectExists(key: string, expectedSize: number, destination?: StorageSettings) {
  if (!key || key.includes('\\') || key.includes('\0') || key.split('/').some(part => !part || part === '.' || part === '..') || /^(?:https?:|data:|blob:)/i.test(key)) return false;
  const settings = destination || await getStorageSettings();
  try {
    if (settings.provider === 'S3') {
      if (!settings.s3.bucket || !settings.s3.accessKeyId || !settings.s3.secretAccessKey) return false;
      const info = await withS3Client(settings, client => client.send(new HeadObjectCommand({ Bucket: settings.s3.bucket, Key: key }), { abortSignal: AbortSignal.timeout(3000) }));
      return info.ContentLength === expectedSize;
    }
    const root = await realpath(path.resolve(/* turbopackIgnore: true */ process.cwd(), settings.localUploadDir || './uploads'));
    const full = await realpath(path.join(root, key));
    if (!full.startsWith(`${root}${path.sep}`)) return false;
    const info = await stat(full);
    return info.isFile() && info.size === expectedSize;
  } catch { return false; }
}

export async function storeBuffer(buffer: Buffer, options: { filename: string; contentType?: string; prefix?: string; stableName?: boolean; immutable?: boolean }, destination?: StorageSettings) {
  const settings = destination || await getStorageSettings();
  const prefix = options.prefix || 'uploads';
  const filename = options.stableName ? safeName(options.filename) : `${Date.now()}-${crypto.randomUUID()}-${safeName(options.filename)}`;
  const key = validatedStorageKey(prefix, filename);

  if (settings.provider === 'S3') {
    const bucket = settings.s3.bucket;
    const accessKeyId = settings.s3.accessKeyId;
    const secretAccessKey = settings.s3.secretAccessKey;
    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new Error('对象存储已启用，但 bucket/accessKeyId/secretAccessKey 未配置完整');
    }

    await withS3Client(settings, client => client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: options.contentType,
        ...(options.immutable ? { IfNoneMatch: '*' } : {})
      }),
      { abortSignal: AbortSignal.timeout(120_000) }
    )).catch(error => {
      // Match local atomic-link behavior: an immutable retry never rewrites
      // a complete object. Other failures must still reach the caller.
      if (options.immutable && error?.$metadata?.httpStatusCode === 412) return;
      throw error;
    });
    return {
      objectPath: key,
      url: settings.s3.publicBaseUrl ? `${settings.s3.publicBaseUrl.replace(/\/$/, '')}/${key}` : undefined,
      provider: 'S3' as const
    };
  }

  const root = path.resolve(/* turbopackIgnore: true */ process.cwd(), settings.localUploadDir || './uploads');
  const fullPath = path.join(root, key);
  await mkdir(path.dirname(fullPath), { recursive: true, mode: 0o700 });
  // Publish complete files atomically, so a playback request cannot read a
  // half-written retry and a crash cannot replace valid evidence with a prefix.
  const temporaryPath = `${fullPath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, buffer, { mode: 0o600, flag: 'wx' });
    if (options.immutable) {
      try { await link(temporaryPath, fullPath); }
      catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error; }
    } else {
      await rename(temporaryPath, fullPath);
    }
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
  return {
    objectPath: key,
    url: `/api/uploads/file/${key.split('/').map(encodeURIComponent).join('/')}`,
    provider: 'LOCAL' as const
  };
}
