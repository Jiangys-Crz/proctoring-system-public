import sharp from 'sharp';

export const PDF_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const PDF_ASSET_MAX_BYTES = 80 * 1024 * 1024;
export const PDF_ASSET_MAX_COUNT = 200;
export type PdfAssetBudget = { bytes: number; count: number };

export class PdfAssetLimitError extends Error {}

export function claimPdfAsset(budget: PdfAssetBudget) {
  if (++budget.count > PDF_ASSET_MAX_COUNT) throw new PdfAssetLimitError('试卷图片数量超过导出限制（200 张）');
}

function chargeBytes(budget: PdfAssetBudget, size: number) {
  budget.bytes += size;
  if (budget.bytes > PDF_ASSET_MAX_BYTES) throw new PdfAssetLimitError('试卷图片总量超过导出限制（80 MB）');
}

/** Read a bounded response instead of allocating an arbitrary attachment body. */
export async function readPdfAsset(response: Response, budget: PdfAssetBudget) {
  if (Number(response.headers.get('content-length')) > PDF_IMAGE_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('试卷图片超过 10 MB');
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      chargeBytes(budget, value.byteLength);
      if (size > PDF_IMAGE_MAX_BYTES) throw new Error('试卷图片超过 10 MB');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export function readInlinePdfAsset(source: string, budget: PdfAssetBudget) {
  const match = source.match(/^data:image\/(?:png|jpeg|webp|gif);base64,([a-z\d+/=]+)$/i);
  if (!match || match[1].length > Math.ceil(PDF_IMAGE_MAX_BYTES / 3) * 4) throw new Error('试卷内嵌图片格式或大小不符合要求');
  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.byteLength > PDF_IMAGE_MAX_BYTES) throw new Error('试卷图片超过 10 MB');
  chargeBytes(budget, buffer.byteLength);
  return buffer;
}

/** Reject vector/document decoders before sharp and embed only metadata-free, single-frame raster output. */
export async function normalizePdfRaster(buffer: Buffer) {
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  const gif = ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  const webp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if ((!png && !jpeg && !gif && !webp) || buffer.byteLength > PDF_IMAGE_MAX_BYTES) throw new Error('试卷图片只支持 PNG、JPEG、GIF 和 WebP');
  const image = sharp(buffer, { limitInputPixels: 25_000_000, animated: false });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || metadata.width > 10_000 || metadata.height > 10_000) throw new Error('试卷图片尺寸超过限制');
  const output = await image.rotate().webp({ quality: 90 }).toBuffer();
  if (output.byteLength > PDF_IMAGE_MAX_BYTES) throw new Error('试卷图片超过 10 MB');
  return `data:image/webp;base64,${output.toString('base64')}`;
}
