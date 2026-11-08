import sharp from 'sharp';
import path from 'node:path';
import { realpath, unlink } from 'node:fs/promises';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getStorageSettings } from './settings';
import { withS3Client } from './s3-client-pool';
import { readStoredImage, StoredImageReadError } from './stored-image-read';
import { processMedia } from './media-processing';
import {
  SCREEN_CONTROL_MAX_DIMENSION, SCREEN_CONTROL_MAX_IMAGE_BYTES, SCREEN_CONTROL_MAX_PIXELS, ScreenControlError,
} from './screen-control-policy';

const ACCEPTED_FORMATS = new Set(['png', 'jpeg', 'webp', 'gif']);

export async function normalizeScreenControlImage(buffer: Buffer) {
  if (!buffer.length || buffer.length > SCREEN_CONTROL_MAX_IMAGE_BYTES) throw new ScreenControlError('每张图片必须有效且不超过 10MB', 413);
  // Acquire once here: callers must not nest image normalization in processMedia.
  // Keep admission outside the decoder catch so saturation remains a retryable 429.
  return processMedia(() => decodeScreenControlImage(buffer));
}

async function decodeScreenControlImage(buffer: Buffer) {
  try {
    const magic = buffer.subarray(0, 8).toString('hex');
    const raster = magic.startsWith('ffd8ff') || magic === '89504e470d0a1a0a' ||
      buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a' ||
      (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP');
    if (!raster) throw new ScreenControlError('图片格式无效');
    const image = sharp(buffer, { limitInputPixels: SCREEN_CONTROL_MAX_PIXELS, failOn: 'warning', animated: false });
    const metadata = await image.metadata();
    if (!metadata.format || !ACCEPTED_FORMATS.has(metadata.format)) throw new ScreenControlError('仅支持 PNG、JPEG、GIF 或 WebP 图片');
    if (!metadata.width || !metadata.height || metadata.width > SCREEN_CONTROL_MAX_DIMENSION || metadata.height > SCREEN_CONTROL_MAX_DIMENSION) {
      throw new ScreenControlError('图片尺寸不能超过 10000 × 10000 像素');
    }
    // Decode the complete first frame and strip metadata. Animated inputs become
    // a static image, preserving the server's fixed five-second slide interval.
    const { data, info } = await image.rotate().webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
    if (data.length > SCREEN_CONTROL_MAX_IMAGE_BYTES) throw new ScreenControlError('转换后的图片超过 10MB', 413);
    return { buffer: data, width: info.width, height: info.height, byteSize: data.length, contentType: 'image/webp' };
  } catch (error) {
    if (error instanceof ScreenControlError) throw error;
    throw new ScreenControlError('图片内容无法解码或像素超过限制，请上传有效图片');
  }
}

function validateImageObjectPath(objectPath: string) {
  if (!objectPath.startsWith('screen-control/') || objectPath.includes('\\')
    || objectPath.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) {
    throw new ScreenControlError('图片存储路径无效', 400);
  }
}

export async function readScreenControlImage(objectPath: string) {
  validateImageObjectPath(objectPath);
  try {
    return await readStoredImage(objectPath, SCREEN_CONTROL_MAX_IMAGE_BYTES);
  } catch (error) {
    if (error instanceof StoredImageReadError) throw new ScreenControlError(error.message, error.status);
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') throw new ScreenControlError('图片文件不存在', 404);
    throw error;
  }
}

/** Uploads that fail before their DB transaction commits must not leave orphaned files. */
export async function removeScreenControlImage(objectPath: string) {
  validateImageObjectPath(objectPath);
  const settings = await getStorageSettings();
  if (settings.provider === 'S3') {
    await withS3Client(settings, client => client.send(new DeleteObjectCommand({ Bucket: settings.s3.bucket, Key: objectPath }), { abortSignal: AbortSignal.timeout(10_000) }));
  } else {
    const root = path.resolve(/* turbopackIgnore: true */ process.cwd(), settings.localUploadDir || './uploads');
    const [realRoot, fullPath] = await Promise.all([realpath(root), realpath(path.join(root, objectPath))]);
    if (!fullPath.startsWith(`${realRoot}${path.sep}`)) throw new ScreenControlError('图片存储路径无效', 403);
    await unlink(fullPath);
  }
}
