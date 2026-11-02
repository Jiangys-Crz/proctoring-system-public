import { net, session } from 'electron';
import { submitServiceError } from './novajudge-submit';

/** Uses OS certificate trust (including the intranet CA), without cookies or redirects. */
export function requestNovaJudgeSubmit(origin: string, method: 'POST' | 'DELETE', headers: Record<string, string>): Promise<unknown> {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.origin !== origin || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    return Promise.reject(new Error('提交服务地址无效'));
  }
  const url = origin + (method === 'POST' ? '/api/cli/device/proctoring' : '/api/cli/device');
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method, redirect: 'error', session: session.fromPartition('novajudge-submit'), useSessionCookies: false });
    const timer = setTimeout(() => { request.abort(); reject(new Error('提交服务连接超时')); }, 5000);
    const fail = (message: string) => { clearTimeout(timer); request.abort(); reject(new Error(message)); };
    request.setHeader('Accept', 'application/json');
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
    if (method === 'POST') request.setHeader('Content-Type', 'application/json');
    request.on('redirect', () => fail('提交服务不允许跳转'));
    request.on('error', () => { clearTimeout(timer); reject(new Error('无法连接提交服务，请检查网络和证书')); });
    request.on('response', response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) fail('提交服务响应过大');
        else chunks.push(Buffer.from(chunk));
      });
      response.on('error', () => fail('提交服务连接中断'));
      response.on('end', () => {
        clearTimeout(timer);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Never show raw server content. */ }
          reject(submitServiceError(response.statusCode, body)); return;
        }
        if (method === 'DELETE') { resolve(null); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('提交服务响应格式无效')); }
      });
    });
    request.end(method === 'POST' ? '{}' : undefined);
  });
}
