import http from 'node:http';
import https from 'node:https';
import { net } from 'electron';
import { screenControlImageUrl, type ScreenControlIdentity } from './screen-control';

class ScreenControlResponseError extends Error {}

interface ScreenControlResponse {
  status: number;
  contentType: string;
  buffer: Buffer;
}

function requestElectron(target: URL, token: string, maxBytes: number): Promise<ScreenControlResponse> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url: target.toString(), method: 'GET', redirect: 'error', useSessionCookies: false });
    let settled = false;
    const finish = (error: Error | null, response?: ScreenControlResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(response!);
    };
    const timeout = setTimeout(() => {
      finish(new Error('屏幕控制请求超时'));
      request.abort();
    }, 8000);
    request.setHeader('x-proctor-client', 'desktop');
    request.setHeader('x-proctor-session-token', token);
    request.on('error', (error) => finish(error));
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          finish(new ScreenControlResponseError('屏幕控制文件过大'));
          request.abort();
        } else chunks.push(Buffer.from(chunk));
      });
      response.on('error', (error: Error) => finish(error));
      response.on('end', () => finish(null, {
        status: response.statusCode,
        contentType: String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase(),
        buffer: Buffer.concat(chunks)
      }));
    });
    request.end();
  });
}

function requestNode(target: URL, token: string, maxBytes: number): Promise<ScreenControlResponse> {
  return new Promise((resolve, reject) => {
    // Node does not follow redirects. Never send the desktop token to another origin.
    const request = (target.protocol === 'https:' ? https : http).get(target, {
      timeout: 8000,
      headers: { 'x-proctor-client': 'desktop', 'x-proctor-session-token': token }
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) request.destroy(new ScreenControlResponseError('屏幕控制文件过大'));
        else chunks.push(Buffer.from(chunk));
      });
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        contentType: String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase(),
        buffer: Buffer.concat(chunks)
      }));
    });
    request.on('timeout', () => request.destroy(new Error('屏幕控制请求超时')));
    request.on('error', reject);
  });
}

async function request(target: URL, token: string, maxBytes: number) {
  let response: ScreenControlResponse;
  try { response = await requestElectron(target, token, maxBytes); }
  catch (error) {
    if (error instanceof ScreenControlResponseError) throw error;
    response = await requestNode(target, token, maxBytes);
  }
  if (response.status < 200 || response.status >= 300) throw new ScreenControlResponseError(`屏幕控制请求失败：HTTP ${response.status}`);
  return response;
}

export async function readScreenControlState(identity: ScreenControlIdentity) {
  const target = new URL('/api/client/screen-control', identity.baseUrl);
  target.searchParams.set('sessionId', identity.sessionId);
  const response = await request(target, identity.token, 2 * 1024 * 1024);
  const body = JSON.parse(response.buffer.toString('utf8'));
  if (body?.ok !== true || !body.data) throw new ScreenControlResponseError(body?.message || '屏幕控制状态读取失败');
  return body.data;
}

export function assertScreenControlImage(contentType: string, buffer: Buffer) {
  const png = contentType === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = contentType === 'image/jpeg' && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  const gif = contentType === 'image/gif' && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  const webp = contentType === 'image/webp' && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!png && !jpeg && !gif && !webp) throw new ScreenControlResponseError('屏幕控制仅允许 PNG、JPEG、GIF、WebP 图片');
}

export async function readScreenControlImage(identity: ScreenControlIdentity, image: { id: string; url: string }) {
  const response = await request(screenControlImageUrl(identity, image), identity.token, 10 * 1024 * 1024);
  assertScreenControlImage(response.contentType, response.buffer);
  return `data:${response.contentType};base64,${response.buffer.toString('base64')}`;
}
