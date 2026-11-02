import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { NovaJudgeSubmitStatus } from '../shared/types';
import type { NovaJudgeScope } from './novajudge-policy';
import { assertWindowsSubmitUser, protectWindowsSubmitConfig, windowsPowerShell } from './novajudge-submit-windows';

const OWNER = 'novajudge-proctor-desktop';
const deviceTokenPattern = /^njcli_[A-Za-z0-9_-]{43}$/;
export interface SubmitContext {
  platform: string;
  releaseChannel?: string;
  selectedBackendOrigin?: string;
  backendOrigin?: string;
  scope: NovaJudgeScope | null;
  proctoringKey: string;
}
export interface SubmitLogin {
  scope: NovaJudgeScope;
  backendOrigin: string;
  cookieToken: string;
  proctoringKey: string;
  contestAccessToken?: unknown;
}
interface Grant {
  deviceToken: string;
  loginSource: 'PROCTORING';
  contest: { id: number; title: string };
  user: { username: string; displayName: string | null };
  expiresAt: string;
}
interface OwnedConfig extends Grant {
  baseUrl: string;
  managedBy: typeof OWNER;
  managedInstance: string;
}
type Request = (origin: string, method: 'POST' | 'DELETE', headers: Record<string, string>) => Promise<unknown>;
interface Dependencies {
  home: string;
  bundleDirectory: string;
  /** Isolated integration runs can supply their own application data directory. */
  windowsInstallation?: { localAppData: string; updatePath: boolean };
  context(): SubmitContext;
  changed(status: NovaJudgeSubmitStatus): void;
  request?: Request;
  install?: (origin: string, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}
export function submitServiceError(status: number, body: unknown) {
  const code = (body as { code?: unknown } | null)?.code;
  const error = new Error(`提交服务请求失败（HTTP ${status}）`) as Error & { code?: string };
  if (typeof code === 'string' && ['CLI_DISABLED', 'CONTEST_CHANGED', 'PROCTORING_AUTH_REQUIRED', 'PROCTORING_CLIENT_REQUIRED', 'CONTEST_PASSWORD_REQUIRED'].includes(code)) error.code = code;
  return error;
}

function submitFailureMessage(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'WINDOWS_USER_MISMATCH') return 'submit 需要监考客户端与终端使用同一 Windows 账号。请使用当前桌面账号完成管理员授权后重新登录。网页比赛不受影响。';
  if (code === 'CLI_DISABLED' || code === 'CONTEST_CHANGED') return 'submit 暂不可用：请管理员将当前考试设为 NovaJudge 的命令行比赛，然后重试。网页比赛不受影响。';
  if (code === 'PROCTORING_AUTH_REQUIRED' || code === 'PROCTORING_CLIENT_REQUIRED') return 'submit 监考授权已失效，请重新登录 NovaJudge。网页比赛不受影响。';
  if (code === 'CONTEST_PASSWORD_REQUIRED') return 'submit 缺少有效的私有赛授权，请联系管理员。网页比赛不受影响。';
  return 'submit 准备失败，网页比赛不受影响。可点击“重新准备 submit”重试。';
}

function exactOrigin(value: string) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== value) {
    throw new Error('提交服务地址无效');
  }
  return url.origin;
}

export function submitContextAllows(context: SubmitContext, login: SubmitLogin) {
  try {
    return ['darwin', 'win32'].includes(context.platform) && context.releaseChannel === 'intranet'
      && exactOrigin(login.backendOrigin) === context.selectedBackendOrigin
      && context.backendOrigin === login.backendOrigin
      && context.scope?.origin === exactOrigin(login.scope.origin)
      && context.scope.contestId === login.scope.contestId
      && /^[1-9]\d*$/.test(login.scope.contestId) && Number.isSafeInteger(Number(login.scope.contestId))
      && context.proctoringKey === login.proctoringKey;
  } catch { return false; }
}

function loginIdentity(login: SubmitLogin, now: number) {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(login.cookieToken) || login.cookieToken.length > 8192
    || !/^[A-Za-z0-9_-]{43}$/.test(login.proctoringKey)) throw new Error('监考登录凭据无效');
  let claims: { username?: unknown; contestId?: unknown; role?: unknown; loginSource?: unknown; proctoringKeyHash?: unknown; exp?: unknown };
  try { claims = JSON.parse(Buffer.from(login.cookieToken.split('.')[1], 'base64url').toString('utf8')); }
  catch { throw new Error('监考登录凭据无效'); }
  // These claims restrict a grant returned by the authenticated server. JWT
  // signature verification remains the NovaJudge issuing endpoint's job.
  if (claims.role !== 'TEAM' || claims.loginSource !== 'PROCTORING' || claims.contestId !== Number(login.scope.contestId)
    || typeof claims.username !== 'string' || !claims.username || claims.username.length > 200
    || claims.proctoringKeyHash !== createHash('sha256').update(login.proctoringKey).digest('hex')
    || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now) throw new Error('监考登录与当前比赛不匹配');
  if (login.contestAccessToken !== undefined && login.contestAccessToken !== null
    && (typeof login.contestAccessToken !== 'string' || !login.contestAccessToken || login.contestAccessToken.length > 8192 || /[\r\n]/.test(login.contestAccessToken))) {
    throw new Error('私有赛授权无效');
  }
  return { username: claims.username, expiresAt: claims.exp * 1000 };
}

function validateGrant(value: unknown, login: SubmitLogin, identity: { username: string; expiresAt: number }, now: number): Grant {
  const grant = value as Grant | null;
  if (!grant || !deviceTokenPattern.test(grant.deviceToken) || grant.loginSource !== 'PROCTORING'
    || grant.contest?.id !== Number(login.scope.contestId) || typeof grant.contest.title !== 'string' || !grant.contest.title
    || grant.user?.username !== identity.username || !(grant.user.displayName === null || typeof grant.user.displayName === 'string')
    || typeof grant.expiresAt !== 'string' || !Number.isFinite(Date.parse(grant.expiresAt))
    || Date.parse(grant.expiresAt) <= now || Date.parse(grant.expiresAt) > identity.expiresAt) throw new Error('提交授权与当前比赛或队伍不匹配');
  // Only the narrower submission token is persisted; no JWT or proctor key.
  return { deviceToken: grant.deviceToken, loginSource: grant.loginSource,
    contest: { id: grant.contest.id, title: grant.contest.title },
    user: { username: grant.user.username, displayName: grant.user.displayName }, expiresAt: grant.expiresAt };
}

/** Node's direct HTTP client never follows redirects or sends browser cookies. */
export const requestSubmitGrant: Request = (origin, method, headers) => new Promise((resolve, reject) => {
  const endpoint = method === 'POST' ? '/api/cli/device/proctoring' : '/api/cli/device';
  const url = new URL(endpoint, exactOrigin(origin));
  const body = method === 'POST' ? '{}' : undefined;
  const request = (url.protocol === 'https:' ? https : http).request(url, {
    method, timeout: 5000,
    headers: { Accept: 'application/json', ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
  }, response => {
    const chunks: Buffer[] = []; let size = 0;
    response.on('data', chunk => {
      size += chunk.length;
      if (size > 64 * 1024) response.destroy(new Error('提交服务响应过大'));
      else chunks.push(chunk);
    });
    response.on('error', reject);
    response.on('end', () => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Only known codes are shown. */ }
        reject(submitServiceError(response.statusCode || 0, body)); return;
      }
      if (method === 'DELETE') { resolve(null); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('提交服务响应格式无效')); }
    });
  });
  request.on('timeout', () => request.destroy(new Error('提交服务连接超时')));
  request.on('error', () => reject(new Error('无法连接提交服务')));
  request.end(body);
});

/** Synchronous compare-and-remove avoids deleting a later browser/CLI login. */
export class SubmitConfigStore {
  readonly filename: string;
  constructor(home: string) { this.filename = path.join(home, '.novajudge-submit.json'); }
  readOwned(): OwnedConfig | null {
    try {
      if (!lstatSync(this.filename).isFile()) return null;
      const config = JSON.parse(readFileSync(this.filename, 'utf8')) as OwnedConfig;
      if (config.managedBy !== OWNER || typeof config.managedInstance !== 'string' || !deviceTokenPattern.test(config.deviceToken)
        || config.loginSource !== 'PROCTORING' || exactOrigin(config.baseUrl) !== config.baseUrl) return null;
      return config;
    } catch { return null; }
  }
  write(config: OwnedConfig) {
    if (existsSync(this.filename) && !lstatSync(this.filename).isFile()) throw new Error('submit 配置路径不是普通文件');
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      if (process.platform === 'win32') protectWindowsSubmitConfig(temporary);
      writeFileSync(descriptor, JSON.stringify(config, null, 2) + '\n');
      closeSync(descriptor); descriptor = undefined;
      if (process.platform !== 'win32') chmodSync(temporary, 0o600);
      renameSync(temporary, this.filename);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  remove(config: Pick<OwnedConfig, 'deviceToken' | 'managedInstance'>) {
    const current = this.readOwned();
    if (current?.deviceToken === config.deviceToken && current.managedInstance === config.managedInstance) unlinkSync(this.filename);
  }
}

export class NovaJudgeSubmit {
  private readonly store: SubmitConfigStore;
  private readonly instance = randomUUID();
  private generation = 0;
  private owned: OwnedConfig | null = null;
  private abortInstall: AbortController | null = null;
  private operations = new Set<Promise<void>>();
  private initialized?: Promise<void>;
  private state: NovaJudgeSubmitStatus = { phase: 'idle', message: '' };
  constructor(private readonly dependencies: Dependencies) { this.store = new SubmitConfigStore(dependencies.home); }
  get status() { return { ...this.state }; }
  private set(status: NovaJudgeSubmitStatus) { this.state = status; this.dependencies.changed(this.status); }
  private request(origin: string, method: 'POST' | 'DELETE', headers: Record<string, string>) {
    return (this.dependencies.request || requestSubmitGrant)(origin, method, headers);
  }
  private async revoke(origin: string, token: string) {
    try { await this.request(origin, 'DELETE', { Authorization: `Bearer ${token}` }); } catch { /* Local credentials are cleared even while offline. */ }
  }
  initialize() {
    this.initialized ||= (async () => {
      if (!['darwin', 'win32'].includes(this.dependencies.context().platform)) return;
      // Also clear our stale intranet token when this launch selected public.
      // Ordinary browser/CLI configurations are never touched here.
      const previous = this.store.readOwned();
      if (previous) {
        try { this.store.remove(previous); } finally { await this.revoke(previous.baseUrl, previous.deviceToken); }
      }
    })();
    return this.initialized;
  }
  clearOwnedNow() {
    try { if (this.owned) this.store.remove(this.owned); } catch { /* Normal shutdown also revokes at the server. */ }
  }
  reset(): Promise<void> {
    this.generation++;
    this.abortInstall?.abort(); this.abortInstall = null;
    const previous = this.owned; this.owned = null;
    try { if (previous) this.store.remove(previous); } catch { /* Revoke even if the home directory is no longer writable. */ }
    this.set({ phase: 'idle', message: '' });
    return previous ? this.track(this.revoke(previous.baseUrl, previous.deviceToken)) : Promise.resolve();
  }
  async shutdown() {
    await this.reset();
    await Promise.allSettled([...this.operations, this.initialized]);
  }
  refreshEligibility() {
    const current = this.dependencies.context();
    if (!['darwin', 'win32'].includes(current.platform) || current.releaseChannel !== 'intranet' || current.selectedBackendOrigin !== current.backendOrigin
      || (this.owned && (current.scope?.origin !== this.owned.baseUrl || Number(current.scope.contestId) !== this.owned.contest.id))) void this.reset();
  }
  connect(login: SubmitLogin) {
    return this.track(this.run(login));
  }
  private track(operation: Promise<void>) {
    this.operations.add(operation);
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
    return operation;
  }
  private async run(login: SubmitLogin) {
    const cleanup = this.reset();
    const generation = this.generation;
    const current = () => generation === this.generation && submitContextAllows(this.dependencies.context(), login);
    if (!current()) { await cleanup; return; }
    this.set({ phase: 'installing', message: '正在准备 submit 命令…' });
    let grant: Grant | null = null;
    let issuedToken = '';
    try {
      await Promise.all([cleanup, this.initialize()]);
      if (!current()) return;
      const identity = loginIdentity(login, (this.dependencies.now || Date.now)());
      const headers: Record<string, string> = { Authorization: `Bearer ${login.cookieToken}`, 'x-novajudge-proctor-key': login.proctoringKey };
      if (typeof login.contestAccessToken === 'string') headers['x-contest-access-token'] = login.contestAccessToken;
      const response = await this.request(login.scope.origin, 'POST', headers);
      const token = (response as { deviceToken?: unknown } | null)?.deviceToken;
      if (typeof token === 'string' && deviceTokenPattern.test(token)) issuedToken = token;
      grant = validateGrant(response, login, identity, (this.dependencies.now || Date.now)());
      if (!current()) return;
      const controller = new AbortController(); this.abortInstall = controller;
      await this.install(login.scope.origin, controller.signal);
      if (!current()) return;
      const config: OwnedConfig = { ...grant, baseUrl: login.scope.origin, managedBy: OWNER, managedInstance: this.instance };
      this.store.write(config);
      this.owned = config;
      issuedToken = '';
      this.set({ phase: 'ready', message: 'submit 已就绪：新开终端运行 submit A.cpp，核对后输入 y。' });
    } catch (error) {
      if (current()) this.set({ phase: 'error', message: submitFailureMessage(error) });
    } finally {
      if (generation === this.generation) this.abortInstall = null;
      if (issuedToken) await this.revoke(login.scope.origin, issuedToken);
    }
  }
  private install(origin: string, signal: AbortSignal): Promise<void> {
    if (this.dependencies.install) return this.dependencies.install(origin, signal);
    const directory = this.dependencies.bundleDirectory;
    if (this.dependencies.context().platform === 'win32') {
      const isolated = this.dependencies.windowsInstallation;
      if (!isolated) assertWindowsSubmitUser(this.dependencies.home);
      return new Promise((resolve, reject) => {
        execFile(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', path.join(directory, 'install-windows.ps1'), '-Url', origin, '-SourceDir', directory,
          ...(isolated && !isolated.updatePath ? ['-NoPathUpdate'] : [])], {
          env: { ...process.env, USERPROFILE: this.dependencies.home,
            ...(isolated ? { LOCALAPPDATA: isolated.localAppData } : {}) },
          windowsHide: true, signal, timeout: 30_000, maxBuffer: 64 * 1024,
        }, error => error ? reject(new Error('submit 安装失败')) : resolve());
      });
    }
    return new Promise((resolve, reject) => {
      execFile('/bin/bash', [path.join(directory, 'install-macos.sh'), '--url', origin, '--source', path.join(directory, 'submit-macos')], {
        env: { ...process.env, HOME: this.dependencies.home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, signal, timeout: 30_000, maxBuffer: 64 * 1024,
      }, error => error ? reject(new Error('submit 安装失败')) : resolve());
    });
  }
}
