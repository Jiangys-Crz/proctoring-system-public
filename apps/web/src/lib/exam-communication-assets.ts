import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { ExamFederation, Prisma } from '@prisma/client';
import sharp from 'sharp';
import { prisma } from './db';
import { getStorageSettings } from './settings';
import { withS3Client } from './s3-client-pool';
import { FederationError, digest, keyHash, openKey, sealKey } from './exam-federation-protocol';
import { contentIdentity, putCommunication } from './exam-communication-entry';
import { CommunicationSnapshotSchema, type AssetSnapshot, type CommunicationWire } from './exam-communication-protocol';
import { settleReads } from './request-admission';

const MAX_ASSET = 10 * 1024 * 1024;
// Match protocol-relative URLs as a whole; never replace just their /api tail
// and accidentally send a locally generated image capability to another host.
const urls = /https?:\/\/[^\s<>"')]+|\/\/[^\s<>"')]+|(?<![A-Za-z0-9:/])\/api\/(?:uploads\/file|qa-assets)\/[^\s<>"')]+/g;
const imageUrl = (id: string, key: string) => `/api/qa-assets/${id}?key=${key}`;
const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
async function readQaImage(objectKey: string, examId: string) {
  if (!objectKey.startsWith(`qa/${examId}/`) || objectKey.includes('\\') || objectKey.includes('\0') || objectKey.split('/').some(x => !x || x === '.' || x === '..')) throw new FederationError('答疑图片路径不属于本场考试');
  const deadlineAt = Date.now() + 5000;
  const controller = new AbortController();
  let source: (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const assertCurrent = () => {
    if (controller.signal.aborted || Date.now() >= deadlineAt) throw new FederationError('答疑图片读取超时');
  };
  const collect = async (stream: AsyncIterable<Uint8Array> & { destroy?: () => void }) => {
    // A lookup can finish after its caller timed out; close any late body too.
    if (controller.signal.aborted) { stream.destroy?.(); assertCurrent(); }
    source = stream;
    assertCurrent();
    let size = 0; const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      assertCurrent();
      size += chunk.byteLength;
      if (size > MAX_ASSET) throw new FederationError('答疑图片超过 10MB');
      chunks.push(chunk);
    }
    assertCurrent();
    return Buffer.concat(chunks, size);
  };
  const read = async () => {
    const settings = await getStorageSettings(); assertCurrent();
    if (settings.provider === 'S3') return withS3Client(settings, async client => {
      assertCurrent();
      const result = await client.send(new GetObjectCommand({ Bucket: settings.s3.bucket, Key: objectKey }), { abortSignal: controller.signal });
      if (!result.Body) throw new FederationError('答疑图片不存在');
      return collect(result.Body as AsyncIterable<Uint8Array> & { destroy?: () => void });
    });
    const root = await realpath(path.resolve(/* turbopackIgnore: true */ process.cwd(), settings.localUploadDir || './uploads')); assertCurrent();
    const full = await realpath(path.join(root, objectKey)); assertCurrent();
    if (!full.startsWith(root + path.sep)) throw new FederationError('答疑图片路径无效');
    const info = await stat(full); assertCurrent();
    if (!info.isFile() || info.size <= 0 || info.size > MAX_ASSET) throw new FederationError('答疑图片不存在或超过 10MB');
    return collect(createReadStream(full));
  };
  try {
    // Bound metadata and body reads independently of an SDK's header timeout.
    // A stalled source must not retain the content slot for every other exam.
    return await Promise.race([read(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new FederationError('答疑图片读取超时')), Math.max(0, deadlineAt - Date.now()));
      timer.unref?.();
    })]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    source?.destroy?.();
  }
}
async function validateImage(buffer: Buffer) {
  if (!buffer.length || buffer.length > MAX_ASSET || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') throw new FederationError('同步图片不是有效的 WebP 图片');
  const metadata = await sharp(buffer, { limitInputPixels: 100_000_000, animated: false }).metadata();
  if (metadata.format !== 'webp' || !metadata.width || !metadata.height || metadata.width > 10000 || metadata.height > 10000) throw new FederationError('同步图片尺寸无效');
}
export type PreparedAssets = { rewrite: (value: string) => string | null; pending: Array<{ snapshot: AssetSnapshot; bytes: Buffer; objectKey: string }>; errors: string[] };
const shared = globalThis as typeof globalThis & { qaImageFailures?: Map<string, number> };
const imageFailures = shared.qaImageFailures ??= new Map<string, number>();
const imageError = '部分答疑图片无法读取，将保留重试；请检查本场考试的图片存储';
/** Read at most one new image before taking any exam/row locks. External URLs are never fetched. */
export async function prepareCommunicationAssets(config: ExamFederation, contents: string[]): Promise<PreparedAssets> {
  const settings = await getStorageSettings();
  const appOrigin = process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).origin : 'http://localhost';
  const locate = (original: string) => {
    let url: URL; try { url = new URL(original.replace(/&amp;/g, '&'), appOrigin); } catch { return null; }
    const own = (original.startsWith('/') && !original.startsWith('//')) || url.origin === appOrigin;
    let objectKey: string | undefined;
    try {
      if (own && url.pathname.startsWith('/api/uploads/file/')) objectKey = decodeURIComponent(url.pathname.slice('/api/uploads/file/'.length));
      else if (settings.provider === 'S3' && settings.s3.publicBaseUrl) {
        const base = new URL(settings.s3.publicBaseUrl.replace(/\/+$/, '') + '/');
        if (url.origin === base.origin && url.pathname.startsWith(base.pathname)) objectKey = decodeURIComponent(url.pathname.slice(base.pathname.length));
      }
    } catch { return null; }
    return { url, own, objectKey: objectKey?.startsWith(`qa/${config.examId}/`) ? objectKey : undefined };
  };
  const references = [...new Set(contents.flatMap(content => content.match(urls) || []))].map(original => ({ original, location: locate(original) }));
  const sourceKeys = [...new Set(references.flatMap(item => item.location?.objectKey ? [item.location.objectKey] : []))];
  const assetIds = [...new Set(references.flatMap(({ location }) => {
    const id = location?.url.pathname.startsWith('/api/qa-assets/') ? location.url.pathname.slice('/api/qa-assets/'.length).toLowerCase() : '';
    return /^[a-f0-9-]{36}$/.test(id) ? [id] : [];
  }))];
  // Avoid one metadata query per Markdown link on every retry.
  const [sources, assets] = await settleReads([
    sourceKeys.length ? prisma.examFederationAsset.findMany({ where: { examId: config.examId, sourceObjectKey: { in: sourceKeys } }, select: { id: true, sourceObjectKey: true, accessKeyCiphertext: true } }) : [],
    assetIds.length ? prisma.examFederationAsset.findMany({ where: { examId: config.examId, id: { in: assetIds } }, select: { id: true, accessKeyHash: true } }) : [],
  ]);
  const bySource = new Map(sources.map(asset => [asset.sourceObjectKey, asset]));
  const byId = new Map(assets.map(asset => [asset.id.toLowerCase(), asset]));
  const replacements = new Map<string, string | null>(); const pending: PreparedAssets['pending'] = []; const errors = new Set<string>();
  let attempted = false;
  for (const [key, until] of imageFailures) if (until <= Date.now()) imageFailures.delete(key);
  for (const { original, location } of references) {
    if (!location) continue;
    if (location.url.pathname.startsWith('/api/qa-assets/')) {
      const id = location.url.pathname.slice('/api/qa-assets/'.length).toLowerCase(), accessKey = location.url.searchParams.get('key') || '';
      if (!/^[a-f0-9-]{36}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(accessKey)) continue;
      const asset = byId.get(id);
      if (asset && asset.accessKeyHash === keyHash(accessKey)) replacements.set(original, imageUrl(asset.id, accessKey));
      else if (location.own) { replacements.set(original, null); errors.add('部分答疑图片引用无效或尚未同步，将保留重试'); }
      continue;
    }
    const objectKey = location.objectKey; if (!objectKey) continue;
    const existing = bySource.get(objectKey);
    if (existing) { replacements.set(original, imageUrl(existing.id, openKey(existing.accessKeyCiphertext))); continue; }
    const prepared = pending.find(item => item.objectKey === objectKey);
    if (prepared) { replacements.set(original, imageUrl(prepared.snapshot.id, prepared.snapshot.accessKey)); continue; }
    replacements.set(original, null);
    const failureKey = `${config.examId}:${objectKey}`;
    if ((imageFailures.get(failureKey) || 0) > Date.now()) { errors.add(imageError); continue; }
    if (attempted) continue;
    attempted = true;
    try {
      const bytes = await readQaImage(objectKey, config.examId); await validateImage(bytes);
      const snapshot: AssetSnapshot = { kind: 'asset', id: randomUUID(), originNodeId: config.nodeId, writerNodeId: config.nodeId, revision: 1,
        sha256: sha(bytes), accessKey: randomBytes(32).toString('base64url'), byteSize: bytes.length, expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString() };
      pending.push({ snapshot, bytes, objectKey }); replacements.set(original, imageUrl(snapshot.id, snapshot.accessKey));
      imageFailures.delete(failureKey);
    } catch {
      // Failure is still an attempt. Back off only this object so healthy
      // images later in the next batch can be prepared without waiting on it.
      if (imageFailures.size >= 512) imageFailures.delete(imageFailures.keys().next().value!);
      imageFailures.set(failureKey, Date.now() + 30_000); errors.add(imageError);
    }
  }
  return { pending, errors: [...errors], rewrite: value => {
    let ready = true;
    const next = value.replace(urls, original => {
      const mapped = replacements.get(original), location = mapped === undefined ? locate(original) : null;
      const ownAsset = location?.own && /^\/api\/qa-assets\/[a-f0-9-]{36}$/i.test(location.url.pathname)
        && /^[A-Za-z0-9_-]{43}$/.test(location.url.searchParams.get('key') || '');
      if (mapped === null || (mapped === undefined && (location?.objectKey || ownAsset))) ready = false;
      return mapped || original;
    });
    return ready ? next : null;
  } };
}
export async function installPreparedAssets(tx: Prisma.TransactionClient, config: ExamFederation, assets: PreparedAssets) {
  for (const { snapshot, bytes, objectKey } of assets.pending) {
    const existing = await tx.examFederationAsset.findUnique({ where: { examId_sourceObjectKey: { examId: config.examId, sourceObjectKey: objectKey } }, select: { id: true } });
    if (existing && existing.id !== snapshot.id) throw new FederationError('答疑图片正在由另一同步任务处理，请稍后重试');
    if (existing) continue;
    await storeCommunicationAsset(tx, config, snapshot, bytes, objectKey);
    await putCommunication(tx, config, snapshot);
  }
}
export async function decodeCommunicationAssets(entries: CommunicationWire[], examId: string) {
  const buffers = new Map<string, Buffer>(); let total = 0;
  for (const entry of entries) if (entry.snapshot.kind === 'asset') {
    const known = await prisma.examFederationContent.findUnique({ where: contentIdentity(examId, 'asset', entry.snapshot.id), select: { payloadHash: true } });
    if (known) { if (known.payloadHash !== digest(entry.snapshot)) throw new FederationError('同步图片元数据冲突'); continue; }
    const encoded = entry.data!;
    const buffer = Buffer.from(encoded, 'base64'); total += buffer.length;
    if (total > MAX_ASSET || buffer.length !== entry.snapshot.byteSize || buffer.toString('base64') !== encoded || sha(buffer) !== entry.snapshot.sha256) throw new FederationError('同步图片内容校验失败');
    await validateImage(buffer); buffers.set(entry.snapshot.id, buffer);
  }
  return buffers;
}
export async function storeCommunicationAsset(tx: Prisma.TransactionClient, config: ExamFederation, value: AssetSnapshot, bytes: Buffer, sourceObjectKey?: string) {
  await tx.examFederationAsset.create({ data: { id: value.id, examId: config.examId, originNodeId: value.originNodeId,
    sha256: value.sha256, accessKeyHash: keyHash(value.accessKey), accessKeyCiphertext: sealKey(value.accessKey),
    bytes: new Uint8Array(bytes), byteSize: bytes.length, expiresAt: new Date(value.expiresAt), sourceObjectKey } });
}
export async function communicationWire(txRows: Array<{ snapshot: unknown; sequence: bigint }>, ceiling: bigint, after: bigint) {
  const entries: CommunicationWire[] = []; let size = 1024, cursor = after, imageBytes = 0;
  for (const row of txRows) {
    const snapshot = CommunicationSnapshotSchema.parse(row.snapshot);
    let data: string | undefined;
    if (snapshot.kind === 'asset') {
      if (imageBytes + snapshot.byteSize > MAX_ASSET && entries.length) break;
      imageBytes += snapshot.byteSize;
      const asset = await prisma.examFederationAsset.findUniqueOrThrow({ where: { id: snapshot.id }, select: { bytes: true } });
      data = Buffer.from(asset.bytes).toString('base64');
    }
    const entry = { snapshot, ...(data ? { data } : {}) }, bytes = Buffer.byteLength(JSON.stringify(entry));
    if (size + bytes > 15 * 1024 * 1024 && entries.length) break;
    size += bytes; entries.push(entry); cursor = row.sequence;
  }
  if (entries.length === txRows.length && txRows.length < 8) cursor = ceiling;
  return { entries, after: cursor.toString() };
}
