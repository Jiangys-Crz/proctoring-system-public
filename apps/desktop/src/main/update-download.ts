import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { net, session, type DownloadItem } from 'electron';
import { validateUpdateFile } from './client-updater';

// Electron uses the system certificate store, including the trusted intranet CA.
export function readUpdateManifest(url: string, timeoutMs = 15_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'error', session: session.fromPartition('client-version-check'), useSessionCookies: false });
    const timer = setTimeout(() => { request.abort(); reject(new Error('客户端版本检查超时，请重试')); }, timeoutMs);
    request.on('error', () => { clearTimeout(timer); reject(new Error('无法连接版本服务器，请检查网络与证书')); });
    request.on('response', response => {
      if (response.statusCode !== 200) { clearTimeout(timer); request.abort(); reject(new Error('版本服务器暂不可用，请重试')); return; }
      let bytes = 0; const chunks: Buffer[] = [];
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 128 * 1024) { request.abort(); clearTimeout(timer); reject(new Error('版本信息过大')); } else chunks.push(Buffer.from(chunk)); });
      response.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('版本信息格式无效')); } });
      response.on('error', () => { clearTimeout(timer); reject(new Error('版本服务器连接中断，请重试')); });
    });
    request.end();
  });
}
export async function matchesUpdateFile(filename: string, file: { size: number; sha512: string }) {
  const info = await stat(filename).catch(() => null);
  if (!info?.isFile() || info.size !== file.size) return false;
  const digest = createHash('sha512');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('base64') === file.sha512;
}
export async function downloadMacInstaller(file: { url: string; size: number; sha512: string }, origin: string, directory: string, progress: (percent: number) => void) {
  validateUpdateFile(file, origin, 'dmg');
  const url = new URL(file.url, origin).href;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, path.basename(new URL(url).pathname));
  if (await matchesUpdateFile(filename, file)) { progress(100); return filename; }
  const temporary = filename + '.partial';
  await rm(temporary, { force: true });
  const downloadSession = session.fromPartition(`client-installer-${randomUUID()}`);
  try {
    await new Promise<void>((resolve, reject) => {
      let item: DownloadItem | undefined, complete = false;
      // Reject redirects and late requests after cancellation. Each download has
      // its own session so retries cannot consume an earlier download event.
      downloadSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: complete || details.url !== url }));
      const finish = (error?: Error) => {
        if (complete) return; complete = true; clearTimeout(timer);
        if (item) downloadSession.removeListener('will-download', received);
        if (error) { item?.cancel(); reject(error); } else resolve();
      };
      const timer = setTimeout(() => finish(new Error('下载超时，请重试')), 15 * 60_000);
      const received = (_event: Electron.Event, candidate: DownloadItem) => {
        if (complete) { _event.preventDefault(); candidate.cancel(); return; }
        item = candidate;
        if (item.getURLChain().some(value => value !== url) || item.getTotalBytes() > file.size) { finish(new Error('更新地址或文件大小已变化，请重试')); return; }
        item.setSavePath(temporary);
        item.on('updated', (_event, state) => {
          if (item!.getReceivedBytes() > file.size || item!.getTotalBytes() > file.size) { finish(new Error('更新文件超出声明大小')); return; }
          if (state === 'interrupted') finish(new Error('下载连接中断，请重试'));
          else progress(Math.min(99, item!.getReceivedBytes() / file.size * 100));
        });
        item.once('done', (_event, state) => finish(state === 'completed' ? undefined : new Error('下载未完成，请重试')));
      };
      downloadSession.once('will-download', received);
      try { downloadSession.downloadURL(url); } catch { finish(new Error('无法启动更新下载')); }
    });
    await chmod(temporary, 0o600);
    if (!await matchesUpdateFile(temporary, file)) throw new Error('安装包校验失败，请重新下载');
    await rename(temporary, filename); progress(100);
    return filename;
  } finally { await rm(temporary, { force: true }); }
}
