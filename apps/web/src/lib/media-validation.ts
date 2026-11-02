import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import ffprobe from 'ffprobe-static';
import { isValidRoomVideoDuration } from '@cwnupaa/proctor-shared';
import { UploadSecurityError } from './upload-security';
import { processMedia } from './media-processing';

const run = promisify(execFile);
/** Decode actual pixels/frames; neither the filename nor client MIME is evidence. */
export async function validateMedia(buffer: Buffer, channel: string, contentType: string, options: { memoryOnly?: boolean } = {}) {
  return processMedia(() => decodeMedia(buffer, channel, contentType, options));
}

async function decodeMedia(buffer: Buffer, channel: string, contentType: string, options: { memoryOnly?: boolean }) {
  if (channel === 'IDENTITY_PHOTO' || (channel === 'EVIDENCE_CLIP' && contentType.startsWith('image/'))) {
    const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    const webp = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    if (!png && !jpeg && !webp) throw new UploadSecurityError('照片格式无效，请上传 JPG、PNG 或 WebP');
    try {
      const image = sharp(buffer, { limitInputPixels: 24_000_000, failOn: 'warning' });
      const meta = await image.metadata();
      if (!['jpeg', 'png', 'webp'].includes(meta.format || '') || !meta.width || !meta.height || meta.width < 160 || meta.height < 120 || (meta.pages || 1) > 1) throw new Error();
      const clean = await image.rotate().jpeg({ quality: 90 }).toBuffer();
      return { buffer: clean, contentType: 'image/jpeg', extension: '.jpg', duration: null };
    } catch { throw new UploadSecurityError('照片内容无效，请上传真实的 JPG、PNG 或 WebP 照片'); }
  }
  const webm = buffer.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  const mp4 = buffer.toString('ascii', 4, 8) === 'ftyp';
  if (!webm && !mp4) throw new UploadSecurityError('视频格式无效，请上传 WebM 或 MP4/MOV');
  // The complete upload already resides in memory. Random-access loopback input
  // avoids writing and reading a second copy of every recording before saving it.
  const memoryOnly = options.memoryOnly !== false;
  const directory = memoryOnly ? null : await mkdtemp(path.join(os.tmpdir(), 'proctor-media-'));
  const memory = memoryOnly ? await memoryMediaInput(buffer) : null;
  const file = memory?.url || path.join(directory!, 'input.media');
  try {
    if (directory) await writeFile(file, buffer, { mode: 0o600 });
    const { stdout } = await run(process.env.FFPROBE_PATH || ffprobe.path, [
      '-v', 'error', '-threads', '1', '-max_alloc', '67108864', '-protocol_whitelist', memory ? 'http,tcp' : 'file', ...(memory ? ['-http_proxy', ''] : []),
      '-f', webm ? 'matroska' : 'mov', ...(mp4 ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []), '-select_streams', 'v:0',
      '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,pkt_duration_time,width,height:format=format_name,duration',
      '-of', 'json', file
    ], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    const result = JSON.parse(stdout) as { frames?: { width?: number; height?: number; best_effort_timestamp_time?: string; pkt_duration_time?: string }[]; format?: { format_name?: string; duration?: string } };
    const frames = result.frames || [];
    if (frames.length < 2 || !frames.every(frame => (frame.width || 0) >= 16 && (frame.height || 0) >= 16 && (frame.width || 0) * (frame.height || 0) <= 24_000_000)) throw new Error();
    let first = Infinity, last = -Infinity, timestampCount = 0;
    for (const frame of frames) {
      const timestamp = Number(frame.best_effort_timestamp_time);
      if (!Number.isFinite(timestamp)) continue;
      first = Math.min(first, timestamp); last = Math.max(last, timestamp); timestampCount++;
    }
    if (timestampCount < 2) throw new Error();
    const duration = last - first + Math.max(0, Number(frames.at(-1)?.pkt_duration_time) || 0);
    if (channel === 'ROOM_VIDEO' && !isValidRoomVideoDuration(duration)) throw new UploadSecurityError('环境视频必须为 3–15 秒的真实视频');
    const format = result.format?.format_name || '';
    const extension = /webm|matroska/.test(format) ? '.webm' : /mov|mp4/.test(format) ? '.mp4' : '';
    if (!extension) throw new Error();
    return { buffer, duration, extension, contentType: extension === '.webm' ? 'video/webm' : 'video/mp4' };
  } catch (error) {
    if (error instanceof UploadSecurityError) throw error;
    throw new UploadSecurityError('视频内容无效或无法解码，请重新录制');
  } finally {
    if (memory) await memory.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

/** FFprobe needs random access for some phone MP4s. Serve only this buffer on a private
 * loopback URL for the duration of decoding; test material never becomes a disk file. */
async function memoryMediaInput(buffer: Buffer) {
  const resource = `/media-${randomBytes(24).toString('hex')}`;
  const server = createServer((request, response) => {
    if (request.url !== resource || !['GET', 'HEAD'].includes(request.method || '')) { response.writeHead(404).end(); return; }
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), buffer.length - 1) : buffer.length - 1;
    if (!Number.isSafeInteger(start) || start < 0 || start > end || end >= buffer.length) { response.writeHead(416).end(); return; }
    response.writeHead(range ? 206 : 200, { 'content-type': 'application/octet-stream',
      'cache-control': 'no-store', 'accept-ranges': 'bytes', 'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${buffer.length}` } : {}) });
    response.end(request.method === 'HEAD' ? undefined : buffer.subarray(start, end + 1));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('临时媒体校验不可用');
  return { url: `http://127.0.0.1:${address.port}${resource}`, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
