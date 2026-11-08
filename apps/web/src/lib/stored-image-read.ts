import path from 'node:path';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getStorageSettings } from './settings';
import { withS3Client } from './s3-client-pool';

export class StoredImageReadError extends Error {
  constructor(message: string, readonly status = 503) { super(message); }
}

/** Bound headers, metadata and the entire body; close streams even after a late lookup. */
export async function readStoredImage(key: string, maxBytes: number) {
  if (!key || key.includes('\\') || key.includes('\0') || key.split('/').some(part => !part || part === '.' || part === '..')) throw new StoredImageReadError('图片存储路径无效', 400);
  const controller = new AbortController(), deadline = Date.now() + 5000;
  let source: (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => { if (controller.signal.aborted || Date.now() >= deadline) throw new StoredImageReadError('图片读取超时，请稍后重试'); };
  const collect = async (body: AsyncIterable<Uint8Array> & { destroy?: () => void }) => {
    if (controller.signal.aborted) { body.destroy?.(); check(); }
    source = body; check();
    let size = 0; const chunks: Uint8Array[] = [];
    for await (const chunk of body) {
      check(); size += chunk.byteLength;
      if (size > maxBytes) throw new StoredImageReadError('图片文件过大', 413);
      chunks.push(chunk);
    }
    check();
    if (!size) throw new StoredImageReadError('图片文件为空', 404);
    return Buffer.concat(chunks, size);
  };
  const read = async () => {
    const settings = await getStorageSettings(); check();
    if (settings.provider === 'S3') return withS3Client(settings, async client => {
      const result = await client.send(new GetObjectCommand({ Bucket: settings.s3.bucket, Key: key }), { abortSignal: controller.signal });
      if (!result.Body) throw new StoredImageReadError('图片文件不存在', 404);
      if (Number(result.ContentLength) > maxBytes) {
        (result.Body as { destroy?: () => void }).destroy?.();
        throw new StoredImageReadError('图片文件过大', 413);
      }
      return collect(result.Body as AsyncIterable<Uint8Array> & { destroy?: () => void });
    });
    const root = await realpath(path.resolve(/* turbopackIgnore: true */ process.cwd(), settings.localUploadDir || './uploads')); check();
    const file = await realpath(path.join(root, key)); check();
    if (!file.startsWith(root + path.sep)) throw new StoredImageReadError('图片存储路径无效', 403);
    const info = await stat(file); check();
    if (!info.isFile()) throw new StoredImageReadError('图片文件不存在', 404);
    if (info.size > maxBytes) throw new StoredImageReadError('图片文件过大', 413);
    return collect(createReadStream(file));
  };
  try {
    return await Promise.race([read(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new StoredImageReadError('图片读取超时，请稍后重试')), Math.max(0, deadline - Date.now())); timer.unref?.();
    })]);
  } finally { clearTimeout(timer); controller.abort(); source?.destroy?.(); }
}
