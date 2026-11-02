import http from 'node:http';
import https from 'node:https';
import type { ClientUpdateStatus } from '../shared/types';

type Target = 'mac-arm64' | 'mac-x64' | 'windows';
interface UpdateFile { url: string; sha512: string; size: number }
interface NativeFile { url: string; sha512: string; size?: number }
interface Release { channel: string; target: Target; version: string; installationMode: 'manual'; notes: string; update: UpdateFile; feedUrl: string }
interface NativeUpdater {
  autoDownload: boolean; autoInstallOnAppQuit: boolean; allowDowngrade: boolean; disableDifferentialDownload: boolean;
  on(name: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<null | { updateInfo: { version: string; files: NativeFile[]; packages?: unknown }; isUpdateAvailable: boolean }>;
  downloadUpdate(): Promise<unknown>; quitAndInstall(silent?: boolean, restart?: boolean): void;
}
interface Dependencies {
  version: string; platform: string; arch: string; packaged: boolean; origin: string; channel: 'public' | 'intranet';
  backends?: ReadonlyArray<{ origin: string; channel: 'public' | 'intranet' }>;
  createUpdater(feed: string): NativeUpdater;
  beforeInstall(): boolean;
  changed(status: ClientUpdateStatus): void;
  readManifest?(url: string, timeoutMs?: number): Promise<any>;
  installManually?(file: UpdateFile, origin: string, progress: (percent: number) => void): Promise<void>;
}
export function trustedUpdateOrigin(value: string, packaged: boolean) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('更新地址必须是服务器主地址');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !packaged && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('自动更新需要可信的 HTTPS 服务器地址，请联系管理员配置');
  }
  return url.origin;
}
export function updaterTarget(platform: string, arch: string): Target | null {
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return platform === 'win32' && ['x64', 'ia32', 'arm64'].includes(arch) ? 'windows' : null;
}
const versionPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
export function validateUpdateFile(file: NativeFile, origin: string, extension: string): asserts file is UpdateFile {
  const url = new URL(file?.url, origin);
  if (url.origin !== origin || url.search || url.hash || url.username || url.password
    || !new RegExp(`^/api/desktop/releases/files/[a-f0-9-]{36}\\.${extension}$`).test(url.pathname)
    || !/^[A-Za-z0-9+/]{86}==$/.test(file?.sha512 || '') || !Number.isSafeInteger(file?.size) || (file.size || 0) < 512 || (file.size || 0) > 1024 ** 3) throw new Error('更新包地址或校验信息无效');
}
function readManifest(url: string, timeoutMs = 15_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).get(url, { timeout: timeoutMs, headers: { Accept: 'application/json' } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('无法读取客户端版本，请检查服务器连接')); return; }
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', chunk => { size += chunk.length; if (size > 128 * 1024) { response.destroy(); reject(new Error('客户端版本信息过大')); } else chunks.push(chunk); });
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('客户端版本信息格式无效')); } });
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('客户端版本检查超时，请重试')));
    req.on('error', reject);
  });
}

/** The renderer sees progress only; it never supplies a feed, installer path or executable command. */
export class ClientUpdater {
  private state: ClientUpdateStatus;
  private updater?: NativeUpdater;
  private release?: Release;
  private checking?: Promise<ClientUpdateStatus>;
  private downloading?: Promise<void>;
  private startupCheck?: Promise<ClientUpdateStatus>;
  constructor(private dependencies: Dependencies) {
    this.state = { phase: 'checking', required: true, currentVersion: dependencies.version, message: '正在检查客户端版本…', percent: 0 };
  }
  get status() { return { ...this.state }; }
  isCurrent() { return this.state.phase === 'current'; }
  checkOnStartup(): Promise<ClientUpdateStatus> {
    this.startupCheck ||= this.check();
    return this.startupCheck.then(() => this.status);
  }
  private set(patch: Partial<ClientUpdateStatus>) { this.state = { ...this.state, ...patch }; this.dependencies.changed(this.status); }
  check(): Promise<ClientUpdateStatus> {
    if (this.downloading) return Promise.resolve(this.status);
    if (this.checking) return this.checking;
    this.checking = this.runCheck().finally(() => { this.checking = undefined; });
    return this.checking;
  }
  private async runCheck() {
    this.release = undefined;
    this.set({ phase: 'checking', required: true, percent: 0, latestVersion: undefined, notes: '', message: '正在检查客户端版本…' });
    try {
      if (!this.dependencies.packaged) {
        // Development skips release downloads, but still selects the configured
        // backend identity used by login and intranet-only submit authorization.
        const origin = trustedUpdateOrigin(this.dependencies.origin, false);
        this.set({ phase: 'current', required: false, serverOrigin: origin,
          releaseChannel: this.dependencies.channel, message: `开发运行 · v${this.dependencies.version}` });
        return this.status;
      }
      const target = updaterTarget(this.dependencies.platform, this.dependencies.arch);
      if (!target) throw new Error('当前系统暂不支持客户端自动更新');
      const backends = this.dependencies.backends || [{ origin: this.dependencies.origin, channel: this.dependencies.channel }];
      let selected: { origin: string; channel: 'public' | 'intranet' } | undefined;
      let manifest: any;
      for (const backend of backends) {
        const origin = trustedUpdateOrigin(backend.origin, true);
        try {
          manifest = await (this.dependencies.readManifest || readManifest)(origin + `/api/desktop/releases?channel=${backend.channel}`, backends.length > 1 ? (backend.channel === 'intranet' ? 5000 : 10_000) : 15_000);
          if (!manifest?.ok || !Array.isArray(manifest.data)) throw new Error('版本服务暂不可用');
          selected = { origin, channel: backend.channel }; break;
        } catch (error) { if (backends.length === 1) throw error; }
      }
      if (!selected) throw new Error('内网和公网后台均无法连接，请检查网络与 HTTPS 证书后重试');
      const { origin, channel } = selected;
      if (origin !== this.state.serverOrigin || channel !== this.state.releaseChannel) this.updater = undefined;
      this.set({ serverOrigin: origin, releaseChannel: channel });
      if (!manifest?.ok || !Array.isArray(manifest.data)) throw new Error('客户端版本服务暂时不可用，请重试');
      const release: Release | undefined = manifest.data.find((item: Release) => item.channel === channel && item.target === target);
      if (!release) throw new Error('管理员尚未发布当前系统的客户端，请联系监考老师');
      if (!versionPattern.test(release.version) || release.feedUrl !== `/api/desktop/updates/${channel}/${target}/`) throw new Error('服务器版本信息无效');
      if (release.installationMode !== 'manual') throw new Error('服务器安装方式无效');
      validateUpdateFile(release.update, origin, target === 'windows' ? 'exe' : 'dmg');
      this.release = release;
      if (release.version === this.dependencies.version) this.set({ phase: 'current', required: false, latestVersion: release.version, message: `已是最新版本 · v${release.version}`, notes: '' });
      else this.set({ phase: 'available', required: true, latestVersion: release.version, notes: typeof release.notes === 'string' ? release.notes.slice(0, 5000) : '', message: `请更新至 v${release.version} 后登录考试。${target !== 'windows' ? '下载后请打开 Mac 安装包中的新版客户端，选择“安装并重新打开”，再从“应用程序”启动。仅下载不会更新旧应用。' : '下载后会打开安装向导，请保留原安装路径并完成安装。'}` });
    } catch (error) { this.set({ phase: 'error', required: true, message: error instanceof Error ? error.message : '版本检查失败，请重试' }); }
    return this.status;
  }
  download(): Promise<void> {
    if (this.downloading) return this.downloading;
    this.downloading = this.runDownload().finally(() => { this.downloading = undefined; });
    return this.downloading;
  }
  private async runDownload() {
    try {
      await this.check();
      if (this.state.phase === 'current') return;
      if (this.state.phase !== 'available' || !this.release) throw new Error(this.state.message);
      if (!this.dependencies.beforeInstall()) throw new Error('请先结束当前考试，再更新客户端');
      const origin = trustedUpdateOrigin(this.state.serverOrigin || this.dependencies.origin, this.dependencies.packaged);
      const release = this.release;
      if (release.target !== 'windows') {
        if (!this.dependencies.installManually) throw new Error('当前客户端不支持此安装方式');
        this.set({ phase: 'downloading', required: true, percent: 0, message: '正在下载最新版，完成后将打开安装包…' });
        await this.dependencies.installManually(release.update, origin, percent => this.set({ percent, message: '正在下载最新版，完成后将打开安装包…' }));
        this.set({ phase: 'installing', percent: 100, message: '下载及校验完成，请在安装窗口完成安装后重新打开客户端' });
        return;
      }
      const updater = this.updater || this.dependencies.createUpdater(origin + release.feedUrl);
      const first = !this.updater;
      this.updater = updater;
      updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
      updater.allowDowngrade = true; updater.disableDifferentialDownload = true;
      if (first) updater.on('error', () => {
        if (this.updater === updater) this.set({ phase: 'error', required: true, message: '更新下载或签名校验失败，请重新检查；如持续失败，请联系管理员' });
      });
      if (first) updater.on('download-progress', (progress: { percent: number }) => {
          if (this.updater === updater) this.set({ phase: 'downloading', percent: Math.max(0, Math.min(100, progress.percent || 0)), message: '正在下载最新版，完成后将打开安装向导…' });
      });
      const result = await updater.checkForUpdates();
      if (!result || !result.isUpdateAvailable || result.updateInfo.version !== release.version || result.updateInfo.packages || result.updateInfo.files.length !== 1) throw new Error('版本已变化，请重新检查更新');
      const file = result.updateInfo.files[0];
      validateUpdateFile(file, origin, 'exe');
      if (new URL(file.url, origin).href !== new URL(release.update.url, origin).href || file.sha512 !== release.update.sha512 || file.size !== release.update.size) throw new Error('更新信息已变化，请重新检查更新');
      this.set({ phase: 'downloading', required: true, percent: 0, message: '正在下载最新版，完成后将打开安装向导…' });
      await updater.downloadUpdate();
      if (!this.dependencies.beforeInstall()) throw new Error('当前有考试或屏幕展示，暂不能安装更新');
      this.set({ phase: 'installing', percent: 100, message: '下载及校验完成，正在打开安装向导，请完成安装后启动客户端' });
      updater.quitAndInstall(false, true);
    } catch (error) {
      this.set({ phase: 'error', required: true, message: error instanceof Error ? error.message : '更新失败，请重试' });
      throw new Error(this.state.message);
    }
  }
}
