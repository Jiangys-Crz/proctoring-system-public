import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { compareReleaseVersions, DESKTOP_CHANNELS, DESKTOP_TARGETS, isReleaseVersion, type DesktopRelease, type DesktopTarget, type DesktopChannel } from '@cwnupaa/proctor-shared';
import { deletionStorage, queueFileDeletion } from './file-deletion';
import { prisma } from './db';
import { consumeRateLimit, reserveUploadBytes, UploadSecurityError } from './upload-security';

const assetPrefix = 'desktop.asset.';
const activePrefix = 'desktop.active.';
// Network addresses are connection choices, not separate software releases.
export function desktopReleaseChannel(_host: string | null): DesktopChannel { return 'public'; }
export async function isPublishedDesktopVersion(host: string | null, os: string | undefined, version: string | undefined) {
  const releases = await getDesktopReleases(desktopReleaseChannel(host));
  if (!releases.length) return true; // Allows the first deployment to publish its installers.
  const target = os?.startsWith('win32 ') ? 'windows' : os?.startsWith('darwin ') ? 'mac' : null;
  return !!target && releases.some(item => (target === 'mac' ? item.target.startsWith('mac-') : item.target === target) && item.version === version);
}
export const ReleaseArtifactSchema = z.object({
  id: z.string().uuid(), channel: z.enum(DESKTOP_CHANNELS), target: z.enum(DESKTOP_TARGETS), kind: z.enum(['installer', 'update']),
  extension: z.enum(['exe', 'dmg', 'zip']), name: z.string().max(160), version: z.string().refine(isReleaseVersion),
  size: z.number().int().positive().max(1024 ** 3), sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/), createdAt: z.string().datetime(),
});
type ReleaseArtifact = z.infer<typeof ReleaseArtifactSchema>;
const PublishedSchema = z.object({ channel: z.enum(DESKTOP_CHANNELS), target: z.enum(DESKTOP_TARGETS), version: z.string().refine(isReleaseVersion),
  installationMode: z.literal('manual'), notes: z.string().max(5000), publishedAt: z.string().datetime(), installer: ReleaseArtifactSchema, update: ReleaseArtifactSchema });
export const PublishDesktopSchema = z.object({ channel: z.enum(DESKTOP_CHANNELS).default('public'), target: z.enum(DESKTOP_TARGETS), version: z.string().refine(isReleaseVersion),
  installationMode: z.literal('manual').default('manual'), notes: z.string().trim().max(5000).default(''), installerId: z.string().uuid(), updateId: z.string().uuid() });

export function desktopReleaseRoot() {
  // These runtime files live in a persistent volume, outside the web bundle.
  return path.resolve(/*turbopackIgnore: true*/ process.env.DESKTOP_RELEASE_DIR || path.join(process.env.PROCTOR_UPLOAD_DIR || './uploads', 'desktop-releases'));
}
export function artifactPath(asset: Pick<ReleaseArtifact, 'id' | 'extension'>) {
  return path.join(/*turbopackIgnore: true*/ desktopReleaseRoot(), `${z.string().uuid().parse(asset.id)}.${z.enum(['exe', 'dmg', 'zip']).parse(asset.extension)}`);
}
export function assertReleaseRequestOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const allowed = [new URL(request.url).origin];
  if (process.env.APP_BASE_URL) allowed.push(new URL(process.env.APP_BASE_URL).origin);
  if (origin && !allowed.includes(origin)) throw new UploadSecurityError('发布请求来源无效', 403);
}
export function expectedReleaseExtension(target: DesktopTarget, kind: 'installer' | 'update') {
  return target === 'windows' ? 'exe' : kind === 'installer' ? 'dmg' : 'zip';
}
export function validReleaseBytes(extension: string, first: Buffer, last: Buffer) {
  if (extension === 'dmg') return last.length >= 512 && last.subarray(last.length - 512, last.length - 508).toString('ascii') === 'koly';
  if (extension === 'zip') return first.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]));
  if (first.length < 64 || first.subarray(0, 2).toString('ascii') !== 'MZ') return false;
  const pe = first.readUInt32LE(60);
  return pe >= 64 && pe + 4 <= first.length && first.subarray(pe, pe + 4).equals(Buffer.from('PE\0\0'));
}

let uploads = 0;
/** Raw, authenticated streaming avoids buffering installation packages in the proxy or server heap. */
export async function uploadDesktopArtifact(request: Request, userId: string) {
  const query = new URL(request.url).searchParams;
  const target = z.enum(DESKTOP_TARGETS).parse(query.get('target'));
  z.enum(DESKTOP_CHANNELS).parse(query.get('channel') || 'public'); // Accept old upload URLs.
  const channel = 'public' as const;
  const kind = z.enum(['installer', 'update']).parse(query.get('kind'));
  const version = z.string().refine(isReleaseVersion).parse(query.get('version'));
  const extension = expectedReleaseExtension(target, kind);
  const name = `proctor-${version}-unified-${target}.${extension}`;
  const length = Number(request.headers.get('content-length'));
  const limit = 1024 ** 3;
  if (!Number.isSafeInteger(length) || length < 512 || length > limit) throw new UploadSecurityError('安装包需在 512 B 至 1 GiB 之间', 413);
  if (!request.body) throw new UploadSecurityError('没有收到安装包');
  await consumeRateLimit(`desktop-release:${userId}`, 30, 60 * 60_000);
  if (uploads >= 2) throw new UploadSecurityError('安装包上传繁忙，请稍后重试', 429);
  uploads++;
  const id = randomUUID();
  const temporary = path.join(desktopReleaseRoot(), `${id}.partial`);
  const reader = request.body.getReader();
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let bytes = 0, head = Buffer.alloc(0), tail = Buffer.alloc(0), completed = false, timedOut = false;
  const hash = createHash('sha512');
  const timer = setTimeout(() => { timedOut = true; void reader.cancel(); }, 15 * 60_000);
  try {
    // Reserve quota before reading the package. Unsuccessful uploads retain their reservation.
    await reserveUploadBytes('desktop-release-total', length, 40 * 1024 ** 3, `desktop-release:${id}`);
    await mkdir(desktopReleaseRoot(), { recursive: true, mode: 0o700 });
    file = await open(temporary, 'wx', 0o600);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > length || bytes > limit) { await reader.cancel(); throw new UploadSecurityError('安装包大小超出声明', 413); }
      const chunk = Buffer.from(value);
      if (head.length < 1024 ** 2) head = Buffer.concat([head, chunk.subarray(0, 1024 ** 2 - head.length)]);
      tail = Buffer.concat([tail, chunk.subarray(Math.max(0, chunk.length - 512))]).subarray(-512);
      hash.update(chunk);
      // FileHandle.write may perform a short write even on a regular file.
      let offset = 0;
      while (offset < chunk.length) offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten;
    }
    if (timedOut) throw new UploadSecurityError('安装包上传超时', 408);
    if (bytes !== length || !validReleaseBytes(extension, head, tail)) throw new UploadSecurityError('安装包格式或长度无效');
    await file.sync(); await file.close(); file = undefined;
    const asset: ReleaseArtifact = { id, channel, target, kind, version, name, extension, size: bytes, sha512: hash.digest('base64'), createdAt: new Date().toISOString() };
    await rename(temporary, artifactPath(asset));
    try { await prisma.systemSetting.create({ data: { key: assetPrefix + id, value: asset } }); }
    catch (error) { await rm(artifactPath(asset), { force: true }); throw error; }
    completed = true;
    return asset;
  } finally {
    clearTimeout(timer); await file?.close(); await reader.cancel().catch(() => {}); reader.releaseLock(); uploads--;
    if (!completed) await rm(temporary, { force: true });
  }
}

// Retain the newest previously published package for each platform. Legacy
// public/intranet rows and file IDs remain intact so old links keep working.
function unifiedPublished(rows: Array<{ value: unknown }>) {
  const byTarget = new Map<DesktopTarget, z.infer<typeof PublishedSchema>>();
  for (const row of rows) {
    const parsed = PublishedSchema.safeParse(row.value);
    if (!parsed.success) continue;
    const previous = byTarget.get(parsed.data.target);
    const comparison = previous ? compareReleaseVersions(parsed.data.version, previous.version) : 1;
    if (!previous || comparison > 0 || comparison === 0 && parsed.data.publishedAt > previous.publishedAt) byTarget.set(parsed.data.target, parsed.data);
  }
  return [...byTarget.values()];
}

export async function publishDesktopRelease(input: z.infer<typeof PublishDesktopSchema>) {
  return prisma.$transaction(async tx => {
    const key = activePrefix + 'unified.' + input.target;
    await tx.systemSetting.upsert({ where: { key }, create: { key, value: {} }, update: {} });
    await tx.$queryRaw`SELECT \`key\` FROM SystemSetting WHERE \`key\` = ${key} FOR UPDATE`;
    const old = unifiedPublished(await tx.systemSetting.findMany({ where: { key: { startsWith: activePrefix } } })).find(release => release.target === input.target);
    if (old && compareReleaseVersions(input.version, old.version) <= 0) throw new UploadSecurityError('新版本号必须高于已发布版本，已发布包不可覆盖', 409);
    for (const id of [...new Set([input.installerId, input.updateId])].sort()) await tx.$queryRaw`SELECT \`key\` FROM SystemSetting WHERE \`key\` = ${assetPrefix + id} FOR UPDATE`;
    const rows = await tx.systemSetting.findMany({ where: { key: { in: [assetPrefix + input.installerId, assetPrefix + input.updateId] } } });
    const assets = rows.map(row => ReleaseArtifactSchema.parse(row.value));
    const installer = assets.find(asset => asset.id === input.installerId);
    const update = assets.find(asset => asset.id === input.updateId);
    if (!installer || !update || installer.target !== input.target || update.target !== input.target || installer.version !== input.version || update.version !== input.version
      || installer.extension !== expectedReleaseExtension(input.target, 'installer') || update.extension !== installer.extension
      || installer.kind !== 'installer' || installer.id !== update.id) {
      throw new UploadSecurityError('安装包和更新包必须对应同一系统、架构与版本');
    }
    for (const asset of [installer]) {
      const info = await stat(/*turbopackIgnore: true*/ artifactPath(asset)).catch(() => null);
      if (!info || !info.isFile() || info.size !== asset.size) throw new UploadSecurityError('安装包缺失或不完整，无法发布');
    }
    const release = { channel: 'public' as const, target: input.target, version: input.version, installationMode: input.installationMode, notes: input.notes, publishedAt: new Date().toISOString(), installer, update };
    for (const asset of [installer]) await tx.systemSetting.upsert({ where: { key: `desktop.published.${asset.id}` },
      create: { key: `desktop.published.${asset.id}`, value: asset }, update: {} });
    await tx.systemSetting.update({ where: { key }, data: { value: release } });
    return release;
  }, { timeout: 15_000, isolationLevel: 'ReadCommitted' });
}
function publicRelease(release: z.infer<typeof PublishedSchema>, channel: DesktopChannel = 'public'): DesktopRelease {
  const file = (asset: ReleaseArtifact) => ({ id: asset.id, name: asset.name, size: asset.size, sha512: asset.sha512,
    url: `/api/desktop/releases/files/${asset.id}.${asset.extension}` });
  return { channel, target: release.target, version: release.version, installationMode: release.installationMode, notes: release.notes, publishedAt: release.publishedAt,
    installer: file(release.installer), update: file(release.update), feedUrl: `/api/desktop/updates/${channel}/${release.target}/` };
}
export async function getDesktopReleases(channel?: DesktopChannel): Promise<DesktopRelease[]> {
  const rows = await prisma.systemSetting.findMany({ where: { key: { startsWith: activePrefix } } });
  // Preserve the requested channel only in legacy response/feed URLs; the
  // version and installer selected are identical for both network addresses.
  return unifiedPublished(rows).map(release => publicRelease(release, channel || 'public'));
}
export async function getDesktopArtifacts() {
  const [rows, activeRows, published] = await Promise.all([
    prisma.systemSetting.findMany({ where: { key: { startsWith: assetPrefix } }, orderBy: { updatedAt: 'desc' } }),
    prisma.systemSetting.findMany({ where: { key: { startsWith: activePrefix } } }),
    prisma.systemSetting.findMany({ where: { key: { startsWith: 'desktop.published.' } }, select: { key: true } })
  ]);
  const active = new Set(unifiedPublished(activeRows).flatMap(r => [r.installer.id, r.update.id]));
  const released = new Set(published.map(r => r.key.slice('desktop.published.'.length)));
  return rows.map(row => {
    const asset = ReleaseArtifactSchema.parse(row.value);
    return { ...asset, channel: 'public' as const, status: active.has(asset.id) ? 'active' : released.has(asset.id) ? 'historical' : 'unpublished',
      downloadUrl: `/api/settings/desktop-releases/files/${asset.id}` };
  });
}
export async function deleteDesktopArtifacts(ids: string[], userId: string) {
  const observed = await prisma.systemSetting.findMany({ where: { key: { in: ids.map(id => assetPrefix + id) } } });
  const assets = observed.map(row => ReleaseArtifactSchema.parse(row.value));
  const storage = deletionStorage({ provider: 'LOCAL', localUploadDir: desktopReleaseRoot(), s3: { region: 'auto', forcePathStyle: true } });
  return prisma.$transaction(async tx => {
    for (const target of [...new Set(assets.map(a => a.target))].sort()) {
      const key = activePrefix + 'unified.' + target;
      await tx.systemSetting.upsert({ where: { key }, create: { key, value: {} }, update: {} });
      await tx.$queryRaw`SELECT \`key\` FROM SystemSetting WHERE \`key\` = ${key} FOR UPDATE`;
    }
    for (const id of [...new Set(ids)].sort()) await tx.$queryRaw`SELECT \`key\` FROM SystemSetting WHERE \`key\` = ${assetPrefix + id} FOR UPDATE`;
    const activeRows = await tx.systemSetting.findMany({ where: { key: { startsWith: activePrefix } } });
    const current = new Set(unifiedPublished(activeRows).flatMap(r => [r.installer.id, r.update.id]));
    if (ids.some(id => current.has(id))) throw new UploadSecurityError('正在发布的最新版安装包不能删除，请先发布更高版本', 409);
    let removed = 0;
    for (const id of [...new Set(ids)]) {
      const row = await tx.systemSetting.findUnique({ where: { key: assetPrefix + id } });
      if (!row) continue;
      const asset = ReleaseArtifactSchema.parse(row.value);
      // Remove legacy active pointers too, so they cannot resurrect a removed version.
      for (const pointer of activeRows) {
        const release = PublishedSchema.safeParse(pointer.value);
        if (release.success && [release.data.installer.id, release.data.update.id].includes(id)) await tx.systemSetting.delete({ where: { key: pointer.key } });
      }
      await tx.systemSetting.deleteMany({ where: { key: { in: [assetPrefix + id, 'desktop.published.' + id] } } });
      await queueFileDeletion(tx, { kind: 'INSTALLER', objectPath: `${id}.${asset.extension}`, storage, requestedById: userId });
      removed++;
    }
    return { removed };
  }, { timeout: 60_000, isolationLevel: 'ReadCommitted' });
}

export function desktopUpdateMetadata(release: DesktopRelease) {
  return { version: release.version, files: [{ url: release.update.url, sha512: release.update.sha512, size: release.update.size }],
    path: release.update.url, sha512: release.update.sha512, releaseDate: release.publishedAt, releaseNotes: release.notes };
}
export async function getPublishedArtifact(filename: string) {
  if (!/^[a-f0-9-]{36}\.(exe|dmg|zip)$/.test(filename)) return null;
  const id = filename.split('.')[0];
  const row = await prisma.systemSetting.findUnique({ where: { key: `desktop.published.${id}` } });
  const result = ReleaseArtifactSchema.safeParse(row?.value);
  if (!result.success || result.data.id !== id || result.data.extension !== filename.split('.').at(-1)) return null;
  return { ...result.data, path: artifactPath(result.data) };
}
