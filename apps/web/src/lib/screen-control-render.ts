import { createHash } from 'node:crypto';
import sharp, { type CreateText, type OverlayOptions } from 'sharp';
import { processMedia } from './media-processing';
import { SCREEN_CONTROL_MAX_IMAGE_BYTES, SCREEN_CONTROL_MAX_PIXELS, ScreenControlError } from './screen-control-policy';
import { resolveScreenText, type ScreenImageTemplate, type ScreenTextValues } from './screen-control-template';

function escapeMarkup(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** The editor preview and legacy desktop image route use this same renderer. */
export async function renderScreenControlImage(source: Buffer, template: ScreenImageTemplate, values: ScreenTextValues) {
  if (!template.blocks.length) return source;
  return processMedia(async () => {
    const metadata = await sharp(source, { limitInputPixels: SCREEN_CONTROL_MAX_PIXELS }).metadata();
    const width = metadata.width!, height = metadata.height!;
    const overlays: OverlayOptions[] = [];
    for (const block of template.blocks) {
      const text = resolveScreenText(block.content, values).trim();
      if (!text) continue;
      const left = Math.min(width - 1, Math.round(width * block.x / 100));
      const top = Math.min(height - 1, Math.round(height * block.y / 100));
      const boxWidth = Math.max(1, Math.min(width - left, Math.round(width * block.width / 100)));
      const boxHeight = Math.max(1, Math.min(height - top, Math.round(height * block.height / 100)));
      const fontSize = Math.max(1, block.fontSize * width / 1000);
      const options: CreateText = {
        text: `<span foreground="${block.color}"${block.bold ? ' weight="bold"' : ''}>${escapeMarkup(text)}</span>`,
        font: `${block.fontFamily === 'SERIF' ? 'serif' : 'sans-serif'} ${fontSize.toFixed(2)}`,
        width: boxWidth, height: boxHeight, align: block.alignment, rgba: true, wrap: 'word-char',
      };
      // Pango measures real glyphs (including Chinese) and shrinks overflowing
      // text to the box. Never enlarge beyond the administrator's chosen size.
      let rendered = await sharp({ text: options }).png().toBuffer({ resolveWithObject: true });
      if ((rendered.info.textAutofitDpi || 72) > 72) {
        rendered = await sharp({ text: { ...options, height: undefined, dpi: 72 } }).png().toBuffer({ resolveWithObject: true });
      }
      const renderedWidth = Math.min(boxWidth, rendered.info.width);
      const renderedHeight = Math.min(boxHeight, rendered.info.height);
      const clipped = await sharp(rendered.data).extract({ left: 0, top: 0, width: renderedWidth, height: renderedHeight }).png().toBuffer();
      const offset = block.alignment === 'center' ? Math.round((boxWidth - renderedWidth) / 2) : block.alignment === 'right' ? boxWidth - renderedWidth : 0;
      overlays.push({ input: clipped, left: left + offset, top });
    }
    if (!overlays.length) return source;
    const image = sharp(source, { limitInputPixels: SCREEN_CONTROL_MAX_PIXELS }).composite(overlays);
    let buffer = await image.clone().webp({ quality: 90 }).toBuffer();
    if (buffer.length > SCREEN_CONTROL_MAX_IMAGE_BYTES) buffer = await image.clone().webp({ quality: 75 }).toBuffer();
    if (buffer.length > SCREEN_CONTROL_MAX_IMAGE_BYTES) throw new ScreenControlError('合成后的图片超过 10MB，请缩小原图', 413);
    return buffer;
  });
}

// Bound retained image data and deduplicate concurrent downloads. Authorization
// is checked by the routes before this cache, and all resolved text is in its key.
const shared = globalThis as typeof globalThis & { screenImageCache?: {
  entries: Map<string, { buffer: Buffer; expires: number }>;
  pending: Map<string, Promise<Buffer>>;
  bytes: number;
} };
const cache = shared.screenImageCache ??= { entries: new Map(), pending: new Map(), bytes: 0 };

export async function cachedScreenControlImage(
  image: { objectPath: string }, template: ScreenImageTemplate, values: ScreenTextValues, read: () => Promise<Buffer>,
) {
  const key = createHash('sha256').update(JSON.stringify([
    image.objectPath, template, template.blocks.map(block => resolveScreenText(block.content, values)),
  ])).digest('hex');
  const hit = cache.entries.get(key);
  if (hit && hit.expires > Date.now()) return hit.buffer;
  if (hit) { cache.entries.delete(key); cache.bytes -= hit.buffer.length; }
  const pending = cache.pending.get(key);
  if (pending) return pending;
  // Keep simultaneous source reads bounded as well as decoder work.
  if (cache.pending.size >= 32) throw new ScreenControlError('图片生成繁忙，请稍后重试', 429);
  const operation = (async () => {
    const buffer = await renderScreenControlImage(await read(), template, values);
    while (cache.entries.size && (cache.entries.size >= 128 || cache.bytes + buffer.length > 64 * 1024 * 1024)) {
      const oldest = cache.entries.keys().next().value!;
      cache.bytes -= cache.entries.get(oldest)!.buffer.length;
      cache.entries.delete(oldest);
    }
    cache.entries.set(key, { buffer, expires: Date.now() + 300_000 });
    cache.bytes += buffer.length;
    return buffer;
  })();
  cache.pending.set(key, operation);
  try { return await operation; }
  finally { cache.pending.delete(key); }
}
