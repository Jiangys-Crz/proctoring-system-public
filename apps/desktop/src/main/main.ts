import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, net, screen, session, shell, systemPreferences, type WebContents } from 'electron';
import { Windows7ScreenCapture } from './windows7-screen-capture';
import { WindowsUsbEvents } from './windows-usb-events';
import { release as osRelease } from 'node:os';
import { getDesktopInfo, elevationStatus, securityCapabilities, securitySnapshot, peripheralSnapshot, confirmPeripheralBaseline, windowsUsbInventory } from './security';
import { enableDevReload } from './dev-reload';
import { startNetworkDomainMonitor, stopNetworkDomainMonitor, resetNetworkDomainObservations, requestNetworkDomainPermission } from './network-domains';
import { PublisherLifecycle } from './publisher-lifecycle';
import { RendererRecoveryStore } from './renderer-recovery';
import type { RendererRecoveryState } from '../shared/types';
import { openRtmpsRelay } from './rtmps-relay';
import { canRetryRequest, isClientPage, isTrustedClientFrame } from './ipc-policy';
import { ScreenControlWatcher, type ScreenControlIdentity } from './screen-control';
import { readScreenControlImage, readScreenControlState } from './screen-control-network';
import { ScreenControlWindows } from './screen-control-windows';
import { ClientUpdater } from './client-updater';
import { contestDownloadAllowed, contestDownloadFilename } from './contest-download-policy';
import { NsisUpdater } from 'electron-updater';
import { downloadMacInstaller, readUpdateManifest } from './update-download';
import { contestPageRequestAllowed } from './contest-page-policy';
import { referenceLinkUrl, referenceNavigationAllowed, referenceRequestAllowed, referenceIsFile, referenceDownloadAllowed } from './reference-link-policy';
import { startupFailureDetail, writeStartupDiagnostic } from './startup';
import { relaunchWindowsAdministrator } from './windows-admin-startup';
import { novaJudgeClientKey, novaJudgeHeaders, novaJudgeCookie, novaJudgeDownloadAllowed, novaJudgeFileUrl, novaJudgeNavigationAllowed, novaJudgeRequestAllowed, type NovaJudgeScope } from './novajudge-policy';
import { NovaJudgeSubmit, type SubmitLogin } from './novajudge-submit';
import { requestNovaJudgeSubmit } from './novajudge-submit-network';

let mainWindow: BrowserWindow | null = null;
const rendererRecovery = new RendererRecoveryStore();
const screenControlWindows = new ScreenControlWindows(() => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
const screenControlWatcher = new ScreenControlWatcher({
  readState: readScreenControlState,
  readImage: readScreenControlImage,
  display: (value) => screenControlWindows.show(value),
  reportError: (error) => console.warn('[screen-control]', error instanceof Error ? error.message : '读取展示状态失败')
});
ipcMain.on('screen-control:ready', event => screenControlWindows.rendererReady(event.sender));
let allowedHosts = new Set<string>();
// DNS observations live for 30 seconds. Exempt only actual requests from a
// clicked reference during that window, without widening the contest browser.
const referenceDomainApprovals = new Map<string, number>();
let contestScope: { host: string; contestId: string } | null = null;
let contestClientScope: { host: string; origin: string } | null = null;
let novaJudgeScope: NovaJudgeScope | null = null;
let novaJudgeClientAccessKey = '';
let novaJudgeBackendOrigin = '';
let novaJudgeLoginGeneration = 0;
let novaJudgeSubmitLogin: SubmitLogin | null = null;
// key: `${sessionId}:${channel}` —— 不同考生（session）的同名画面通道是不同推流，必须按会话隔离
const rtmpProcesses = new Map<string, ChildProcessWithoutNullStreams>();
// 由渲染进程画面驱动（canvas → JPEG → ffmpeg stdin）的推流进程，同样按会话隔离
const rtmpPipeProcesses = new Map<
  string,
  { child: ChildProcessWithoutNullStreams; fps: number; backpressuredAt: number }
>();
const configuredSessions = new WeakSet<Electron.Session>();
const rendererFile = path.join(__dirname, '../renderer/index.html');
function bundledUpdateOrigin() {
  const config = readFileSync(path.join(__dirname, '../renderer/config.js'), 'utf8');
  const setting = (key: string) => config.match(new RegExp(`window\\.${key}\\s*=\\s*['\"]([^'\"]*)['\"]`))?.[1];
  return setting('PROCTOR_UPDATE_SERVER_URL') || setting('PROCTOR_DEFAULT_SERVER_URL') || 'http://localhost:4031';
}
const novaJudgeSubmit = new NovaJudgeSubmit({
  home: app.getPath('home'),
  bundleDirectory: app.isPackaged ? path.join(process.resourcesPath, 'novajudge-submit') : path.join(__dirname, '../../resources/novajudge-submit'),
  request: requestNovaJudgeSubmit,
  context: () => ({ platform: process.platform, releaseChannel: clientUpdater.status.releaseChannel,
    selectedBackendOrigin: clientUpdater.status.serverOrigin, backendOrigin: novaJudgeBackendOrigin,
    scope: novaJudgeScope, proctoringKey: novaJudgeClientAccessKey }),
  changed: status => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('novajudge-submit:status', status); },
});
function resetNovaJudgeSubmit() {
  novaJudgeLoginGeneration++;
  novaJudgeSubmitLogin = null;
  return novaJudgeSubmit.reset();
}
const clientUpdater = new ClientUpdater({
  version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged,
  origin: bundledUpdateOrigin(),
  backends: app.isPackaged && /window\.PROCTOR_RELEASE_CHANNEL\s*=\s*['"]unified['"]/.test(readFileSync(path.join(__dirname, '../renderer/config.js'), 'utf8')) ? [
    { origin: 'https://proctoring.example.test', channel: 'intranet' },
    { origin: 'https://proctoring.example.org', channel: 'public' },
  ] : undefined,
  channel: /window\.PROCTOR_RELEASE_CHANNEL\s*=\s*['"]intranet['"]/.test(readFileSync(path.join(__dirname, '../renderer/config.js'), 'utf8')) ? 'intranet' : 'public',
  createUpdater: (url) => {
    const updater = new NsisUpdater({ provider: 'generic', url });
    const origin = new URL(url).origin;
    updater.netSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: new URL(details.url).origin !== origin }));
    // Pass the running application's actual location; custom installer paths
    // and per-machine installations must upgrade the existing installation.
    updater.installDirectory = path.dirname(app.getPath('exe'));
    return updater;
  },
  beforeInstall: () => windowMode === 'setup' && !screenControlWatcher.isDisplaying,
  readManifest: readUpdateManifest,
  installManually: async (file, origin, progress) => {
    if (process.platform !== 'darwin') throw new Error('当前系统不支持此安装方式');
    const filename = await downloadMacInstaller(file, origin, path.join(app.getPath('userData'), 'client-updates'), progress);
    if (windowMode !== 'setup' || screenControlWatcher.isDisplaying) throw new Error('请先结束当前考试或屏幕展示');
    const bundle = path.dirname(path.dirname(path.dirname(app.getPath('exe'))));
    const choice = await dialog.showMessageBox({ type: 'info', title: '安装包已下载', message: '请在原安装位置替换旧版本',
      detail: `当前安装位置：${bundle}\n\n客户端将先退出。请打开安装包中的新版客户端，选择“安装并重新打开”，完成后从“应用程序”启动。仅下载或打开安装包不会替换旧版本。`,
      buttons: ['打开安装包并退出', '稍后安装'], defaultId: 0, cancelId: 1 });
    if (choice.response !== 0) throw new Error('安装包已保存在本机。准备安装时，请重新点击更新');
    const error = await shell.openPath(filename);
    if (error) throw new Error('安装包已下载，但无法打开，请重新尝试');
    if (bundle.toLowerCase().endsWith('.app')) shell.showItemInFolder(bundle);
    cleanupMonitoring();
    app.quit();
  },
  changed: (status) => {
    if (status.releaseChannel !== 'intranet' || status.serverOrigin !== novaJudgeBackendOrigin) {
      void resetNovaJudgeSubmit();
    }
    novaJudgeSubmit.refreshEligibility();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('client-update:status', status);
  },
});
const publishers = new PublisherLifecycle<{ channel: RtmpChannel; url: string; pid?: number; fps: number }>();
let rtmpGeneration = 0;
const windows7ScreenCapture = new Windows7ScreenCapture(ffmpegPath);
const windowsUsbEvents = new WindowsUsbEvents(() => app.isPackaged
  ? path.join(process.resourcesPath, 'security/inventory-probe.exe')
  : path.join(__dirname, '../../native/windows-inventory', process.arch, 'inventory-probe.exe'), windowsUsbInventory,
  { diagnostic: detail => writeStartupDiagnostic(app, 'usb-events', detail) });
const appBundleId = 'org.cwnupaa.proctor';
type MacPrivacyPane = 'screen' | 'camera' | 'microphone' | 'accessibility' | 'localNetwork';

const macPrivacyPaneUrls: Record<MacPrivacyPane, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  localNetwork: 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork'
};

const windowsPrivacyPaneUris: Record<'camera' | 'microphone' | 'network', string> = {
  camera: 'ms-settings:privacy-webcam',
  microphone: 'ms-settings:privacy-microphone',
  network: 'ms-settings:network-status'
};
type JsonRequestOptions = { method?: string; body?: unknown; headers?: Record<string, string> };
type JsonResponseBody = { ok?: boolean; data?: unknown; message?: string; code?: string };
type ConnectionProbe = {
  channel: string;
  ok: boolean;
  statusCode?: number;
  elapsedMs: number;
  message?: string;
};
type RtmpChannel = 'DESKTOP_SCREEN' | 'DESKTOP_CAMERA';
type FfmpegDevice = { index: string; name: string };

const ffmpegStaticPath = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('ffmpeg-static') as string | null;
  } catch {
    return null;
  }
})();

function hostFromUrl(value: string) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function ffmpegPath() {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (existsSync(bundled)) return bundled;
  }
  return ffmpegStaticPath || 'ffmpeg';
}

function streamKey(sessionId: string, channel: RtmpChannel) {
  return `${sessionId}_${channel}`;
}

function rtmpUrlFor(mediaBaseUrl: string, sessionId: string, channel: RtmpChannel, token = '') {
  const parsed = new URL(mediaBaseUrl);
  if (!['rtmp:', 'rtmps:'].includes(parsed.protocol)) throw new Error('媒体推流地址必须以 rtmp:// 或 rtmps:// 开头');
  const base = mediaBaseUrl.replace(/\/+$/, '');
  const auth = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${base}/live/${streamKey(sessionId, channel)}${auth}`;
}

function redactMediaUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '***');
    return parsed.toString();
  } catch {
    return value.replace(/([?&]token=)[^&]+/i, '$1***');
  }
}

function ffmpegText(args: string[]) {
  return new Promise<string>((resolve) => {
    execFile(ffmpegPath(), args, { timeout: 5000, windowsHide: true }, (_error, stdout, stderr) => {
      resolve(`${stdout || ''}\n${stderr || ''}`);
    });
  });
}

async function avfoundationVideoDevices() {
  const output = await ffmpegText(['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
  const devices: FfmpegDevice[] = [];
  let inVideoSection = false;
  output.split(/\r?\n/).forEach((line) => {
    if (line.includes('AVFoundation video devices')) inVideoSection = true;
    if (line.includes('AVFoundation audio devices')) inVideoSection = false;
    const match = line.match(/\[(\d+)]\s+(.+)$/);
    if (inVideoSection && match) devices.push({ index: match[1], name: match[2].trim() });
  });
  return devices;
}

async function dshowVideoDevices() {
  const output = await ffmpegText(['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy']);
  const devices: FfmpegDevice[] = [];
  let inVideoSection = false;
  output.split(/\r?\n/).forEach((line) => {
    if (line.includes('DirectShow video devices')) inVideoSection = true;
    if (line.includes('DirectShow audio devices')) inVideoSection = false;
    const match = line.match(/"([^"]+)"/);
    if (inVideoSection && match) devices.push({ index: match[1], name: match[1] });
  });
  return devices;
}

async function ffmpegInputArgs(channel: RtmpChannel, inputFps: number) {
  if (process.platform === 'darwin') {
    const devices = await avfoundationVideoDevices();
    const screenDevice = devices.find((device) => /capture screen|screen/i.test(device.name));
    const cameraDevice = devices.find((device) => !/capture screen|screen/i.test(device.name));
    const device = channel === 'DESKTOP_SCREEN' ? screenDevice : cameraDevice;
    if (!device) throw new Error(channel === 'DESKTOP_SCREEN' ? 'FFmpeg 未找到屏幕采集设备' : 'FFmpeg 未找到摄像头设备');
    if (channel === 'DESKTOP_SCREEN') {
      return ['-f', 'avfoundation', '-framerate', String(inputFps), '-capture_cursor', '1', '-i', `${device.index}:none`];
    }
    return ['-f', 'avfoundation', '-framerate', String(inputFps), '-i', `${device.index}:none`];
  }

  if (process.platform === 'win32') {
    if (channel === 'DESKTOP_SCREEN') {
      return ['-f', 'gdigrab', '-framerate', String(inputFps), '-draw_mouse', '1', '-i', 'desktop'];
    }
    const [camera] = await dshowVideoDevices();
    if (!camera) throw new Error('FFmpeg 未找到摄像头设备');
    return ['-f', 'dshow', '-framerate', String(inputFps), '-i', `video=${camera.name}`];
  }

  if (channel === 'DESKTOP_SCREEN') {
    return ['-f', 'x11grab', '-framerate', String(inputFps), '-video_size', '1920x1080', '-i', process.env.DISPLAY || ':0.0'];
  }
  return ['-f', 'v4l2', '-framerate', String(inputFps), '-video_size', '1920x1080', '-i', '/dev/video0'];
}

function rtmpKey(sessionId: string, channel: RtmpChannel) {
  return `${sessionId}:${channel}`;
}

function killRtmpForChannel(channel: RtmpChannel) {
  // 清理该画面通道下所有会话的残留进程（换考生后旧进程不应继续推流）
  for (const [key, child] of rtmpProcesses) {
    if (key.endsWith(`:${channel}`) && !child.killed) child.kill('SIGTERM');
  }
}

function spawnRtmpFfmpeg(
  url: string,
  channel: RtmpChannel,
  key: string,
  inputFps: number,
  outputFps: string,
  bitrate: string,
  bufsize: string
) {
  return new Promise<{ child: ChildProcessWithoutNullStreams; stderrTail: string }>((resolve, reject) => {
    (async () => {
      const inputArgs = await ffmpegInputArgs(channel, inputFps);
      const relay = new URL(url).protocol === 'rtmps:' ? await openRtmpsRelay(url) : null;
      const args = [
        '-hide_banner',
        '-loglevel',
        'warning',
        ...inputArgs,
        '-vf',
        channel === 'DESKTOP_SCREEN'
          ? 'scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2'
          : 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-tune',
        'zerolatency',
        '-pix_fmt',
        'yuv420p',
        '-r',
        outputFps,
        '-g',
        outputFps,
        '-b:v',
        bitrate,
        '-maxrate',
        bitrate,
        '-bufsize',
        bufsize,
        '-an',
        '-f',
        'flv',
        relay?.url || url
      ];
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(ffmpegPath(), args, { windowsHide: true });
      } catch (error) {
        relay?.stop();
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      let stderrTail = '';
      child.stderr.on('data', (chunk) => {
        const text = String(chunk || '').trim().replace(/([?&]token=)[^&\s]+/gi, '$1***');
        stderrTail = `${stderrTail}\n${text}`.slice(-1200);
        if (text) console.warn(`[rtmp:${key}] ${text}`);
      });
      child.on('error', (error) => {
        relay?.stop();
        console.error(`[rtmp:${key}] spawn error`, error);
        if (rtmpProcesses.get(key) === child) rtmpProcesses.delete(key);
      });
      child.on('exit', () => {
        relay?.stop();
        if (rtmpProcesses.get(key) === child) rtmpProcesses.delete(key);
      });

      const survived = await new Promise<boolean>((resolveSurvived) => {
        const timeout = setTimeout(() => resolveSurvived(child.exitCode === null && !child.killed), 1500);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolveSurvived(false);
        });
        child.once('error', () => {
          clearTimeout(timeout);
          resolveSurvived(false);
        });
      });

      if (!survived) {
        if (rtmpProcesses.get(key) === child) rtmpProcesses.delete(key);
        reject(new Error(stderrTail.trim() || '推流进程已退出'));
        return;
      }
      resolve({ child, stderrTail });
    })().catch((error) => reject(error));
  });
}

async function startRtmpStream(mediaBaseUrl: string, sessionId: string, channel: RtmpChannel, token: string) {
  const key = rtmpKey(sessionId, channel);
  killRtmpForChannel(channel);
  const url = rtmpUrlFor(mediaBaseUrl, sessionId, channel, token);

  // Match WebRTC priorities: readable screen text and lower-bandwidth cameras.
  const attempts: Array<{ inputFps: number; outputFps: string; bitrate: string; bufsize: string }> =
    channel === 'DESKTOP_SCREEN'
      ? [
          { inputFps: 30, outputFps: '30', bitrate: '3000k', bufsize: '6000k' },
          { inputFps: 15, outputFps: '15', bitrate: '3000k', bufsize: '6000k' }
        ]
      : [
          { inputFps: 20, outputFps: '20', bitrate: '450k', bufsize: '900k' },
          { inputFps: 15, outputFps: '15', bitrate: '450k', bufsize: '900k' }
        ];

  let lastError = '';
  let lastChild: ChildProcessWithoutNullStreams | null = null;
  let activeFps = 30;
  for (const attempt of attempts) {
    try {
      const { child } = await spawnRtmpFfmpeg(url, channel, key, attempt.inputFps, attempt.outputFps, attempt.bitrate, attempt.bufsize);
      lastChild = child;
      activeFps = attempt.inputFps;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error || '未知错误');
      console.warn(`[rtmp:${key}] ${attempt.inputFps}fps 尝试失败，尝试更低帧率：${lastError}`);
    }
  }

  if (!lastChild) {
    throw new Error(`FFmpeg ${channel} 推流启动失败：${lastError}`);
  }

  rtmpProcesses.set(key, lastChild);
  return { channel, url: redactMediaUrl(url), pid: lastChild.pid, fps: activeFps };
}

function stopRtmpStreams() {
  for (const child of rtmpProcesses.values()) {
    if (!child.killed) child.kill('SIGTERM');
  }
  rtmpProcesses.clear();
}

/**
 * 渲染进程画面驱动的推流：渲染端把已采集的预览帧（JPEG）通过 IPC 写入 ffmpeg stdin，
 * ffmpeg 负责编码 H.264 并推 RTMP。这样推流画面与客户端实时预览完全同步，
 * 也绕开了 ffmpeg 独立二次采集在应用上下文下的权限/卡死问题。
 */
const RTMP_PIPE_LOG = '/tmp/cwnupaa-rtmp-pipe.log';

function logPipe(key: string, message: string) {
  const sanitized = message.replace(/([?&]token=)[^&\s]+/gi, '$1***');
  const line = `[${new Date().toISOString()}] [${key}] ${sanitized}`;
  console.warn(line);
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.appendFileSync(RTMP_PIPE_LOG, `${line}\n`, { mode: 0o600 });
  } catch {
    // 日志文件写入失败不影响推流
  }
}

function startRtmpPipe(mediaBaseUrl: string, sessionId: string, channel: RtmpChannel, token: string) {
  const url = rtmpUrlFor(mediaBaseUrl, sessionId, channel, token);
  return publishers.start(channel, url, (register) => launchRtmpPipe(url, sessionId, channel, register));
}

async function launchRtmpPipe(url: string, sessionId: string, channel: RtmpChannel, register: (child: ChildProcessWithoutNullStreams) => void) {
  const key = rtmpKey(sessionId, channel);
  const fps = 15;
  const bitrate = channel === 'DESKTOP_SCREEN' ? '3000k' : '450k';
  const bufferSize = channel === 'DESKTOP_SCREEN' ? '6000k' : '900k';
  const relay = new URL(url).protocol === 'rtmps:' ? await openRtmpsRelay(url) : null;
  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    // -re 让 image2pipe 按真实时间节奏读取，保证 HLS 实时更新（否则 ffmpeg 会积压到结束时才冲刷）
    '-re',
    '-f',
    'image2pipe',
    '-framerate',
    String(fps),
    '-c:v',
    'mjpeg',
    '-i',
    '-',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-g',
    String(fps),
    '-b:v',
    bitrate,
    '-maxrate',
    bitrate,
    '-bufsize',
    bufferSize,
    '-an',
    '-f',
    'flv',
    relay?.url || url
  ];
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(ffmpegPath(), args, { windowsHide: true });
  } catch (error) {
    relay?.stop();
    throw error;
  }
  let stderrTail = '';
  logPipe(key, `spawn pid=${child.pid} ffmpeg=${ffmpegPath()} url=${redactMediaUrl(url)} fps=${fps}`);
  child.stderr.on('data', (chunk) => {
    const text = String(chunk || '').trim().replace(/([?&]token=)[^&\s]+/gi, '$1***');
    stderrTail = `${stderrTail}\n${text}`.slice(-1200);
    if (text) logPipe(key, `stderr: ${text}`);
  });
  child.on('error', (error) => {
    relay?.stop();
    logPipe(key, `spawn error: ${error.message}`);
    console.error(`[rtmp-pipe:${key}] spawn error`, error);
    if (rtmpPipeProcesses.get(key)?.child === child) rtmpPipeProcesses.delete(key);
  });
  child.on('exit', (code, signal) => {
    relay?.stop();
    logPipe(key, `exit code=${code} signal=${signal} stderrTail=${stderrTail.slice(-300)}`);
    if (rtmpPipeProcesses.get(key)?.child === child) rtmpPipeProcesses.delete(key);
  });
  child.stdin.on('error', (error) => {
    logPipe(key, `stdin error: ${error.message}`);
    // stdin 关闭后忽略写入错误
  });
  register(child);
  // Register before waiting for readiness so stop/reload can always find it.
  rtmpPipeProcesses.set(key, { child, fps, backpressuredAt: 0 });

  const started = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(child.exitCode === null && !child.killed), 1200);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.once('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
  if (!started) {
    throw new Error(`FFmpeg ${channel} 推流进程启动失败：${stderrTail.trim() || '推流进程已退出'}`);
  }
  if (child.exitCode !== null || child.killed) {
    throw new Error(`FFmpeg ${channel} 推流进程启动后提前退出：${stderrTail.trim() || child.exitCode}`);
  }
  logPipe(key, `画面驱动推流已启动 → ${redactMediaUrl(url)} (${fps}fps)`);
  return { channel, url: redactMediaUrl(url), pid: child.pid, fps };
}

function writeRtmpFrame(sessionId: string, channel: RtmpChannel, buffer: Buffer) {
  const entry = rtmpPipeProcesses.get(rtmpKey(sessionId, channel));
  if (!entry || entry.child.killed || entry.child.exitCode !== null || !entry.child.stdin.writable) return false;
  if (entry.backpressuredAt) {
    // stdin 尚未排空时丢弃新帧，避免长时间考试中 JPEG 在内存里无限堆积。
    return Date.now() - entry.backpressuredAt <= 5000;
  }
  try {
    if (!entry.child.stdin.write(buffer)) {
      entry.backpressuredAt = Date.now();
      entry.child.stdin.once('drain', () => {
        const current = rtmpPipeProcesses.get(rtmpKey(sessionId, channel));
        if (current === entry) current.backpressuredAt = 0;
      });
    }
    return true;
  } catch {
    return false;
  }
}

function stopRtmpPipes() {
  rtmpGeneration += 1;
  rtmpPipeProcesses.clear();
  return publishers.stopAll();
}

function isAllowedUrl(url: string, resourceType = '') {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'devtools:') return process.env.PROCTOR_DEV === '1';
  if (parsed.protocol === 'about:') return parsed.href === 'about:blank';
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') {
    return Boolean(resourceType && !['mainFrame', 'subFrame'].includes(resourceType));
  }
  if (parsed.protocol === 'file:') {
    try {
      const rendererRoot = path.resolve(__dirname, '../renderer');
      const localPath = path.resolve(fileURLToPath(parsed));
      return localPath === rendererRoot || localPath.startsWith(`${rendererRoot}${path.sep}`);
    } catch {
      return false;
    }
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts.has(host)) return false;
  // This policy serves trusted shell API requests too. The guest has its own
  // stricter request handler below, so the monitoring server remains usable.
  if (novaJudgeScope) return parsed.origin === novaJudgeScope.origin
    ? novaJudgeRequestAllowed(url, resourceType, novaJudgeScope)
    : ['xhr', 'fetch'].includes(resourceType) && parsed.pathname.startsWith('/api/client/');
  if (contestClientScope?.host === host && parsed.origin === contestClientScope.origin) {
    return contestPageRequestAllowed(url, resourceType, contestClientScope.origin);
  }
  // The contest webview may render Hydro-hosted images/files, but its top-level
  // page must always remain the standalone contest page from this project.
  if (contestClientScope && (resourceType === 'mainFrame' || resourceType === 'subFrame')) return false;
  // Once the embedded contest page is open, the monitor server is only an API
  // backend. Do not let that origin become a second unrestricted browser.
  if (contestClientScope && host !== contestScope?.host) {
    return (resourceType === 'xhr' || resourceType === 'fetch') && parsed.pathname.startsWith('/api/client/');
  }
  if (!contestScope || contestScope.host !== host) return true;

  const contestPrefix = `/contest/${contestScope.contestId}`;
  return (
    parsed.pathname === contestPrefix ||
    parsed.pathname.startsWith(`${contestPrefix}/`) ||
    parsed.pathname.startsWith('/api/') ||
    parsed.pathname.startsWith('/fs/') ||
    parsed.pathname.startsWith('/file/')
  );
}

function buildServerUrl(baseUrl: string, requestPath: string) {
  const base = new URL(baseUrl);
  const target = new URL(requestPath, `${base.protocol}//${base.host}`);
  if (target.origin !== base.origin) throw new Error('请求地址不属于当前服务器');
  // Requests created by the desktop IPC bridge are API requests, not browser navigations.
  // Health diagnostics are needed while the contest browser is restricted.
  // Keep this exception in IPC so webview navigation retains its own policy.
  const healthProbe = target.pathname === '/api/health' && ['http:', 'https:'].includes(target.protocol) && allowedHosts.has(target.hostname.toLowerCase());
  if (!healthProbe && !isAllowedUrl(target.toString(), 'xhr')) throw new Error(`当前不允许访问该地址：${target.toString()}`);
  return target;
}

function parseJsonResponse(raw: string): JsonResponseBody | null {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

class ServerResponseError extends Error {}

function assertOkResponse(statusCode: number | undefined, body: JsonResponseBody | null) {
  if (body?.code === 'CLIENT_SESSION_REVOKED') throw new ServerResponseError('[CLIENT_SESSION_REVOKED] 会话已注销，请重新登录');
  if (!statusCode || statusCode < 200 || statusCode >= 300 || !body?.ok) {
    throw new ServerResponseError(body?.message || `请求失败：HTTP ${statusCode || 'unknown'}`);
  }
  return body.data;
}

function electronNetJsonRequest(target: URL, options: JsonRequestOptions = {}) {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: options.method || 'GET',
      url: target.toString(), redirect: 'error', useSessionCookies: false
    });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      request.abort();
      finish(() => reject(new Error('请求超时：8000ms')));
    }, 8000);
    request.setHeader('content-type', 'application/json');
    request.setHeader('x-proctor-client', 'desktop');
    Object.entries(options.headers || {}).forEach(([key, value]) => request.setHeader(key, value));
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const data = assertOkResponse(response.statusCode, parseJsonResponse(raw));
          finish(() => resolve(data));
        } catch (error) {
          finish(() => reject(error));
        }
      });
    });
    request.on('error', (error) => finish(() => reject(error)));
    if (payload) request.write(payload);
    request.end();
  });
}

function nodeHttpJsonRequest(target: URL, options: JsonRequestOptions = {}) {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: options.method || 'GET',
        timeout: 8000,
        headers: {
          'content-type': 'application/json',
          'x-proctor-client': 'desktop',
          ...(options.headers || {}),
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {})
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(assertOkResponse(response.statusCode, parseJsonResponse(raw)));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on('timeout', () => {
      request.destroy(new Error('请求超时：8000ms'));
    });
    request.on('error', (error) => reject(error));
    if (payload) request.write(payload);
    request.end();
  });
}

function curlJsonRequest(target: URL, options: JsonRequestOptions = {}) {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const args = [
    '--fail-with-body',
    '--silent',
    '--show-error',
    '--max-time',
    '8',
    '--request',
    options.method || 'GET',
    '--header',
    'content-type: application/json',
    '--header',
    'x-proctor-client: desktop'
  ];
  Object.entries(options.headers || {}).forEach(([key, value]) => {
    args.push('--header', `${key}: ${value}`);
  });
  if (payload) args.push('--data-raw', payload);
  args.push(target.toString());

  return new Promise((resolve, reject) => {
    execFile('curl', args, { timeout: 9000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      try {
        const body = parseJsonResponse(stdout);
        resolve(assertOkResponse(200, body));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

async function probeChannel(channel: string, runner: () => Promise<unknown>): Promise<ConnectionProbe> {
  const startedAt = Date.now();
  try {
    await runner();
    return { channel, ok: true, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return {
      channel,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error || '未知错误')
    };
  }
}

async function diagnoseServer(baseUrl: string, requestPath = '/api/health') {
  const host = hostFromUrl(baseUrl);
  if (host) allowedHosts.add(host);
  const target = buildServerUrl(baseUrl, requestPath);
  return Promise.all([
    probeChannel('electron-net', () => electronNetJsonRequest(target)),
    probeChannel('node-http', () => nodeHttpJsonRequest(target)),
    probeChannel('system-curl', () => curlJsonRequest(target))
  ]);
}

async function jsonRequest(baseUrl: string, requestPath: string, options: JsonRequestOptions = {}) {
  const target = buildServerUrl(baseUrl, requestPath);
  try {
    return await electronNetJsonRequest(target, options);
  } catch (electronError) {
    if (electronError instanceof ServerResponseError || !canRetryRequest(options.method)) throw electronError;
    try {
      return await nodeHttpJsonRequest(target, options);
    } catch (nodeError) {
      if (nodeError instanceof ServerResponseError) throw nodeError;
      try {
        return await curlJsonRequest(target, options);
      } catch (curlError) {
        const first = electronError instanceof Error ? electronError.message : String(electronError || '未知错误');
        const second = nodeError instanceof Error ? nodeError.message : String(nodeError || '未知错误');
        const third = curlError instanceof Error ? curlError.message : String(curlError || '未知错误');
        throw new Error(`Electron net 失败：${first}；Node HTTP 失败：${second}；系统 curl 失败：${third}`);
      }
    }
  }
}

function openRestrictedExternalWindow(rawUrl: string) {
  if (novaJudgeScope) return;
  if (screenControlWatcher.isDisplaying) return;
  if (!mainWindow) return;
  const target = referenceLinkUrl(rawUrl);
  if (!target) return;
  const downloadOnly = referenceIsFile(target);

  const externalWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    parent: mainWindow,
    modal: true,
    show: false,
    autoHideMenuBar: true,
    title: '链接预览（仅允许访问当前链接）',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      safeDialogs: true,
      partition: `external-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }
  });
  const externalSession = externalWindow.webContents.session;
  externalSession.setPermissionCheckHandler(() => false);
  externalSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  externalSession.on('will-download', (event, item) => {
    if (screenControlWatcher.isDisplaying || !referenceDownloadAllowed(item.getURLChain(), target, downloadOnly)) {
      event.preventDefault(); return;
    }
    item.setSaveDialogOptions({ title: '保存考试文件', buttonLabel: '保存',
      defaultPath: path.join(app.getPath('downloads'), contestDownloadFilename(item.getFilename())) });
    item.once('done', () => { if (!externalWindow.isDestroyed()) externalWindow.close(); });
  });
  externalSession.webRequest.onBeforeRequest((details, callback) => {
    // File redirects may lead to a storage service. A download-only window
    // never renders that response or executes page content.
    const cancel = screenControlWatcher.isDisplaying
      || (['mainFrame', 'other'].includes(details.resourceType) && !['GET', 'HEAD'].includes(details.method)) || !(downloadOnly
      ? details.resourceType === 'other' && referenceLinkUrl(details.url) !== null
      : referenceRequestAllowed(details.url, details.resourceType, target));
    if (!cancel) referenceDomainApprovals.set(new URL(details.url).hostname.toLowerCase(), Date.now() + 35_000);
    callback({ cancel });
  });
  externalWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const restrictNavigation = (event: Electron.Event, nextUrl: string) => {
    if (!referenceNavigationAllowed(nextUrl, target)) event.preventDefault();
  };
  externalWindow.webContents.on('will-navigate', restrictNavigation);
  externalWindow.webContents.on('will-redirect', restrictNavigation);
  externalWindow.webContents.on('did-navigate-in-page', (_event, nextUrl, isMainFrame) => {
    // History API and fragment changes do not emit will-navigate. Restore the
    // original document; its request filter also blocks any new document URL.
    if (isMainFrame && !referenceNavigationAllowed(nextUrl, target)) {
      void externalWindow.loadURL(target).catch(() => externalWindow.close());
    }
  });
  externalWindow.webContents.on('context-menu', (event) => event.preventDefault());
  externalWindow.webContents.on('before-input-event', (event, input) => {
    if (screenControlWatcher.isDisplaying) { event.preventDefault(); return; }
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const command = input.control || input.meta;
    if (key === 'f12' || (command && input.shift && ['i', 'j', 'c'].includes(key)) || (input.meta && input.alt && key === 'i')) event.preventDefault();
  });
  externalWindow.webContents.on('devtools-opened', () => externalWindow.webContents.closeDevTools());
  if (downloadOnly) {
    externalWindow.webContents.downloadURL(target);
  } else {
    externalWindow.once('ready-to-show', () => externalWindow.show());
    void externalWindow.loadURL(target).catch(() => externalWindow.close());
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    title: '程序设计算法协会监考客户端',
    show: false,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      webviewTag: true
    }
  });

  const window = mainWindow;
  const showWindow = () => {
    if (window.isDestroyed()) return;
    window.maximize();
    window.show();
  };
  window.once('ready-to-show', showWindow);
  window.webContents.once('did-finish-load', showWindow);
  void window.loadFile(rendererFile).catch(error => {
    writeStartupDiagnostic(app, 'renderer-load-failed', error.message);
    dialog.showErrorBox('监考客户端页面加载失败', startupFailureDetail(app));
  });
  if (process.env.PROCTOR_DEV === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const protectLoginShortcuts = (contents: WebContents, contestGuest = false) => {
    contents.on('before-input-event', (event, input) => {
      if (screenControlWatcher.isDisplaying) { event.preventDefault(); return; }
      if (input.type !== 'keyDown') return;
      const key = input.key.toLowerCase();
      const command = input.control || input.meta;
      const refresh = (command && key === 'r') || key === 'f5';
      const closesClient = (command && (key === 'w' || key === 'q')) || (input.alt && key === 'f4');
      const opensDeveloperTools = key === 'f12' || (command && input.shift && ['i', 'j', 'c'].includes(key)) || (input.meta && input.alt && key === 'i');
      const navigatesAway = (input.alt && ['arrowleft', 'arrowright'].includes(key)) || (input.meta && ['[', ']'].includes(key));
      const changesWindowState = key === 'f11' || (input.meta && ['m', 'h'].includes(key)) || (input.alt && key === ' ');
      if (refresh) {
        event.preventDefault();
        mainWindow?.webContents.send('browser:refresh-shortcut');
        return;
      }
      if (closesClient || opensDeveloperTools || navigatesAway || changesWindowState) event.preventDefault();
    });
    contents.setWindowOpenHandler((details) => {
      if (contestGuest && novaJudgeScope) {
        if (novaJudgeNavigationAllowed(details.url, novaJudgeScope)) void contents.loadURL(details.url);
        // File links with target=_blank can download in the existing guest.
        else if (novaJudgeFileUrl(details.url, novaJudgeScope)) contents.downloadURL(details.url);
        return { action: 'deny' };
      }
      if (contestGuest) openRestrictedExternalWindow(details.url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (contestGuest && novaJudgeScope && novaJudgeFileUrl(url, novaJudgeScope)) {
        event.preventDefault(); contents.downloadURL(url); return;
      }
      if (contestGuest ? !isAllowedUrl(url, 'mainFrame') : !isClientPage(url, rendererFile)) {
        event.preventDefault();
        if (contestGuest) openRestrictedExternalWindow(url);
      }
    });
    contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
      if (contestGuest && novaJudgeScope && isMainFrame && !novaJudgeNavigationAllowed(url, novaJudgeScope)) event.preventDefault();
    });
    contents.on('context-menu', (event) => event.preventDefault());
    if (process.env.PROCTOR_DEV !== '1') {
      contents.on('devtools-opened', () => contents.closeDevTools());
    }
  };
  protectLoginShortcuts(mainWindow.webContents);
  mainWindow.webContents.on('will-attach-webview', (event, preferences, params) => {
    if (params.partition !== 'persist:proctor-oj' || (params.src !== 'about:blank' && (!(contestClientScope || novaJudgeScope) || !isAllowedUrl(params.src, 'mainFrame')))) {
      event.preventDefault();
      return;
    }
    delete preferences.preload;
    preferences.nodeIntegration = false;
    preferences.nodeIntegrationInSubFrames = false;
    preferences.contextIsolation = true;
    preferences.sandbox = true;
    preferences.webSecurity = true;
  });
  mainWindow.webContents.on('did-attach-webview', (_event, guestContents) => protectLoginShortcuts(guestContents, true));
  // A refresh or crashed renderer no longer owns the media it previously started.
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) cleanupMonitoring();
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    cleanupMonitoring();
    writeStartupDiagnostic(app, 'render-process-gone', `${details.reason} exit=${details.exitCode}`);
    if (details.reason === 'clean-exit' || window.isDestroyed()) return;
    const active = windowMode !== 'setup' || screenControlWatcher.isDisplaying;
    if (rendererRecovery.begin(active)) {
      writeStartupDiagnostic(app, 'renderer-recovering', active ? 'restoring original exam session' : 'reloading setup');
      window.webContents.reload();
      return;
    }
    dialog.showErrorBox('监考客户端页面异常', startupFailureDetail(app, true));
  });
  mainWindow.webContents.on('preload-error', (_event, _preload, error) => {
    writeStartupDiagnostic(app, 'preload-failed', error.stack || error.message);
    dialog.showErrorBox('监考客户端组件加载失败', startupFailureDetail(app));
  });
  mainWindow.on('close', (event) => {
    if (windowMode !== 'setup' || screenControlWatcher.isDisplaying) event.preventDefault();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function pickPrimaryScreenSource(sources: Electron.DesktopCapturerSource[]) {
  const primaryDisplayId = String(screen.getPrimaryDisplay().id);
  return (
    sources.find((source) => source.display_id === primaryDisplayId) ||
    sources.find((source) => source.id.startsWith('screen:')) ||
    sources[0]
  );
}

function configureSession(targetSession: Electron.Session) {
  if (configuredSessions.has(targetSession)) return;
  configuredSessions.add(targetSession);
  if (targetSession === session.fromPartition('persist:proctor-oj')) {
    targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: novaJudgeHeaders(details.url, details.requestHeaders, novaJudgeScope, novaJudgeClientAccessKey) });
    });
  }
  targetSession.on('will-download', (event, item, contents) => {
    const embedded = Boolean(contents && mainWindow && contents.hostWebContents?.id === mainWindow.webContents.id
      && targetSession === session.fromPartition('persist:proctor-oj') && !screenControlWatcher.isDisplaying);
    const permitted = novaJudgeScope
      ? novaJudgeDownloadAllowed(contents?.getURL() || '', item.getURLChain(), novaJudgeScope, embedded)
      : contestClientScope && contestDownloadAllowed(contents?.getURL() || '', item.getURLChain(), contestClientScope.origin, embedded);
    if (!permitted) {
      event.preventDefault(); return;
    }
    item.setSaveDialogOptions({ title: '保存考试文件', buttonLabel: '保存',
      defaultPath: path.join(app.getPath('downloads'), contestDownloadFilename(item.getFilename())) });
  });

  const trustedForCapture = (webContents: Electron.WebContents | null, isMainFrame: boolean, url: string) => {
    return Boolean(webContents && isTrustedClientFrame(webContents.id, mainWindow?.webContents.id, isMainFrame, url, rendererFile));
  };

  targetSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    return trustedForCapture(webContents, details.isMainFrame, details.requestingUrl || '') && ['media', 'display-capture'].includes(permission);
  });

  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(trustedForCapture(webContents, details.isMainFrame, details.requestingUrl) && ['media', 'display-capture'].includes(permission));
  });

  targetSession.setDisplayMediaRequestHandler((request, callback) => {
    const trusted = () => {
      try { return Boolean(mainWindow && request.frame === mainWindow.webContents.mainFrame && isClientPage(request.frame.url, rendererFile)); }
      catch { return false; }
    };
    if (!trusted()) {
      callback({});
      return;
    }
    desktopCapturer
      .getSources({
        types: ['screen'],
        thumbnailSize: { width: 320, height: 180 }
      })
      .then((sources) => {
        const source = pickPrimaryScreenSource(sources);
        callback(source && trusted() ? { video: source } : {});
      })
      .catch(() => callback({}));
  });

  targetSession.webRequest.onBeforeRequest((details, callback) => {
    if (novaJudgeScope && targetSession === session.fromPartition('persist:proctor-oj')) {
      callback({ cancel: details.url !== 'about:blank' && !novaJudgeRequestAllowed(details.url, details.resourceType, novaJudgeScope) });
      return;
    }
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame' || details.resourceType === 'xhr') {
      callback({ cancel: !isAllowedUrl(details.url, details.resourceType) });
      return;
    }
    callback({});
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  configureSession(session.defaultSession);
  configureSession(session.fromPartition('persist:proctor-oj'));
  void clientUpdater.checkOnStartup();
  // Remove a previous process's owned token before any new login is possible.
  // Revocation can finish in the background if the old server is offline.
  void novaJudgeSubmit.initialize().catch(() => {});
  createWindow();
  if (process.env.PROCTOR_DEV === '1') enableDevReload();
}).catch(error => {
  writeStartupDiagnostic(app, 'ready-failed', error instanceof Error ? error.stack || error.message : String(error));
  dialog.showErrorBox('监考客户端启动失败', startupFailureDetail(app));
  app.quit();
});

function cleanupMonitoring() {
  void resetNovaJudgeSubmit();
  windows7ScreenCapture.stopAll();
  windowsUsbEvents.stop();
  stopNetworkDomainMonitor();
  stopRtmpStreams();
  void stopRtmpPipes().catch((error) => console.warn('[rtmp] cleanup failed', error));
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
let submitShutdownComplete = false;
let submitShutdownStarted = false;
app.on('before-quit', (event) => {
  // Dock/menu/system quit must not bypass the renderer's final-segment save or
  // the exam exit policy. Explicit approved exits set setup before calling quit.
  if (windowMode !== 'setup' || screenControlWatcher.isDisplaying) {
    event.preventDefault();
    return;
  }
  if (!submitShutdownComplete) {
    event.preventDefault();
    if (!submitShutdownStarted) {
      submitShutdownStarted = true;
      novaJudgeLoginGeneration++;
      novaJudgeSubmitLogin = null;
      novaJudgeScope = null;
      novaJudgeClientAccessKey = '';
      void novaJudgeSubmit.shutdown().finally(() => { submitShutdownComplete = true; app.quit(); });
    }
    return;
  }
  cleanupMonitoring();
  screenControlWindows.dispose();
});
process.on('exit', () => { novaJudgeSubmit.clearOwnedNow(); windowsUsbEvents.stop(); windows7ScreenCapture.stopAll(); screenControlWindows.dispose(); stopNetworkDomainMonitor(); publishers.killAllNow(); stopRtmpStreams(); });

app.on('window-all-closed', () => {
  cleanupMonitoring();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function handleClient(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedClientFrame(event.sender.id, mainWindow?.webContents.id,
      event.senderFrame === mainWindow?.webContents.mainFrame, event.senderFrame?.url || '', rendererFile)) {
      throw new Error('仅客户端主页面可以执行此操作');
    }
    return listener(event, ...args);
  });
}

handleClient('net:json', async (_event, baseUrl: string, requestPath: string, options?: { method?: string; body?: unknown }) => {
  const initialPair = requestPath === '/api/client/pair' && options?.method === 'POST' && !(options.body as { sessionId?: string } | undefined)?.sessionId;
  if (initialPair || requestPath === '/api/client/credential-login') {
    await clientUpdater.checkOnStartup();
    if (!clientUpdater.isCurrent()) throw new Error('请先将监考客户端更新至最新版');
    if (clientUpdater.status.serverOrigin && new URL(baseUrl).origin !== clientUpdater.status.serverOrigin) throw new Error('连接后台已切换，请重新生成登录二维码');
  }
  return jsonRequest(baseUrl, requestPath, options || {});
});
handleClient('client-update:status', () => clientUpdater.status);
handleClient('client-update:check', () => {
  if (windowMode !== 'setup' || screenControlWatcher.isDisplaying) return clientUpdater.status;
  return clientUpdater.check();
});
handleClient('client-update:download', () => {
  if (windowMode !== 'setup' || screenControlWatcher.isDisplaying) throw new Error('请先结束当前考试或屏幕展示，再更新客户端');
  return clientUpdater.download();
});

handleClient('net:diagnose', (_event, baseUrl: string, requestPath?: string) => diagnoseServer(baseUrl, requestPath));
handleClient('app:quit', () => {
  if (screenControlWatcher.isDisplaying) throw new Error('请等待监考老师结束屏幕展示');
  screenControlWatcher.release();
  windowMode = 'setup';
  cleanupMonitoring();
  if (mainWindow) {
    mainWindow.setKiosk(false);
    mainWindow.setFullScreen(false);
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setClosable(true);
  }
  app.quit();
});

handleClient('system:getInfo', () => getDesktopInfo());
handleClient('renderer-recovery:save', (_event, value: RendererRecoveryState | null) => {
  if (!value) void resetNovaJudgeSubmit();
  if (value) buildServerUrl(value.serverUrl, '/api/client/heartbeat');
  rendererRecovery.save(value);
});
handleClient('renderer-recovery:get', () => rendererRecovery.read());
handleClient('renderer-recovery:complete', () => rendererRecovery.restored());

handleClient('desktop:windows7Start', () => {
  if (process.platform !== 'win32' || !/^6\.1(?:\.|$)/.test(osRelease())) throw new Error('当前系统不使用 Windows 7 兼容采集');
  // Physical display bounds include taskbars at every edge, at any DPI.
  const bounds = screen.dipToScreenRect(null, screen.getPrimaryDisplay().bounds);
  return windows7ScreenCapture.start(bounds);
});
handleClient('desktop:windows7Read', (_event, id: string, sequence: number) => windows7ScreenCapture.read(id, sequence));
handleClient('desktop:windows7Stop', (_event, id: string) => windows7ScreenCapture.stop(id));

handleClient('desktop:getSources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 360, height: 220 }
  });
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail.toDataURL()
  }));
});

handleClient('desktop:testScreenCapture', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 80, height: 45 }
    });
    const usableSources = sources.filter((source) => source.id.startsWith('screen:'));
    const status = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : undefined;
    const permitted = !status || status === 'granted';
    return {
      ok: usableSources.length > 0 && permitted,
      sourceCount: usableSources.length,
      status,
      sources: usableSources.map((source) => ({
        id: source.id,
        name: source.name,
        displayId: source.display_id
      })),
      reason: !permitted ? '尚未取得系统屏幕录制权限，请授权并按系统要求重新启动客户端' : usableSources.length ? undefined : '未发现可采集的屏幕源'
    };
  } catch (error) {
    return {
      ok: false,
      sourceCount: 0,
      status: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : undefined,
      reason: error instanceof Error ? error.message : String(error || '屏幕源探测失败')
    };
  }
});

handleClient('permissions:getMacMediaAccessStatus', () => {
  if (process.platform !== 'darwin') return null;
  return {
    camera: systemPreferences.getMediaAccessStatus('camera'),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    screen: systemPreferences.getMediaAccessStatus('screen')
  };
});

handleClient('permissions:getSystemPermissionStatus', () => {
  const mediaStatus =
    process.platform === 'darwin' || process.platform === 'win32'
      ? {
          camera: systemPreferences.getMediaAccessStatus('camera'),
          microphone: systemPreferences.getMediaAccessStatus('microphone'),
          screen: systemPreferences.getMediaAccessStatus('screen')
        }
      : null;
  const accessibility = process.platform === 'darwin' ? systemPreferences.isTrustedAccessibilityClient(false) : true;
  return {
    platform: process.platform,
    media: mediaStatus,
    accessibility,
    bundleId: appBundleId,
    appName: app.getName(),
    execPath: process.execPath,
    isPackaged: app.isPackaged
  };
});

handleClient('permissions:askMacMediaAccess', async (_event, mediaType: 'camera' | 'microphone') => {
  if (process.platform !== 'darwin') return true;
  if (!['camera', 'microphone'].includes(mediaType)) throw new Error('未知的设备权限');
  return systemPreferences.askForMediaAccess(mediaType);
});

handleClient('permissions:openMacPrivacyPane', async (_event, pane: MacPrivacyPane) => {
  if (process.platform !== 'darwin') return false;
  if (!Object.prototype.hasOwnProperty.call(macPrivacyPaneUrls, pane)) throw new Error('未知的系统权限页面');
  await shell.openExternal(macPrivacyPaneUrls[pane]);
  return true;
});

handleClient('permissions:openWindowsPrivacyPane', async (_event, pane: 'camera' | 'microphone' | 'network') => {
  if (process.platform !== 'win32') return false;
  if (!Object.prototype.hasOwnProperty.call(windowsPrivacyPaneUris, pane)) throw new Error('未知的系统权限页面');
  await shell.openExternal(windowsPrivacyPaneUris[pane]);
  return true;
});

handleClient('permissions:promptMacAccessibility', () => {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(true);
});

let adminRelaunch: Promise<boolean> | null = null;
handleClient('app:relaunchAsAdmin', async (event) => {
  if (screenControlWatcher.isDisplaying) throw new Error('屏幕展示期间不能重新启动客户端');
  if (process.platform !== 'win32') return false;
  const elevation = await elevationStatus();
  if (elevation === 'elevated') return true;
  if (elevation === 'unavailable') throw new Error('管理员权限检测失败，请重新安装完整客户端，并检查安全软件是否隔离了权限检测组件。');
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  if (adminRelaunch) return adminRelaunch;
  adminRelaunch = (async () => {
    const result = await relaunchWindowsAdministrator(app);
    if (result === 'started' || result === 'replaced') { windowMode = 'setup'; app.quit(); }
    if (result === 'failed') throw new Error('管理员授权组件无法启动，请重新安装完整客户端或右键选择“以管理员身份运行”。');
    return result === 'started';
  })();
  try { return await adminRelaunch; } finally { adminRelaunch = null; }
});

handleClient('security:snapshot', async (_event, hosts: string[]) => {
  for (const [host, expiry] of referenceDomainApprovals) if (expiry < Date.now()) referenceDomainApprovals.delete(host);
  return securitySnapshot([...(hosts || []), ...referenceDomainApprovals.keys()]);
});
handleClient('security:capabilities', async (_event, hosts: string[]) => securityCapabilities());
handleClient('security:peripherals', async () => peripheralSnapshot());
handleClient('security:watchUsb', (_event, sessionId: string) => {
  if (process.platform !== 'win32') return;
  if (windowMode === 'setup' || typeof sessionId !== 'string' || !sessionId || sessionId.length > 191) throw new Error('请先登录考试再启用 USB 检测');
  return windowsUsbEvents.watch(sessionId);
});
handleClient('security:readUsb', (_event, sessionId: string) => process.platform === 'win32'
  ? windowMode === 'setup' ? { available: false, events: [] } : windowsUsbEvents.read(sessionId)
  : { available: true, events: [] });
handleClient('security:ackUsb', (_event, sessionId: string, ids: string[]) => windowsUsbEvents.acknowledge(sessionId, ids));

handleClient('security:confirmPeripheralBaseline', async () => {
  const readyForLogin = () => windowMode === 'setup' && !screenControlWatcher.isDisplaying
    && rtmpProcesses.size === 0 && rtmpPipeProcesses.size === 0;
  if (!readyForLogin()) throw new Error('请先结束当前考试或屏幕展示，再检测登录设备');
  const fingerprint = await confirmPeripheralBaseline();
  if (!readyForLogin()) throw new Error('客户端状态已改变，请重新检测登录设备');
  return fingerprint;
});

handleClient('permissions:requestNetworkDomain', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('仅客户端权限页面可以申请网络检测权限');
  }
  const result = await requestNetworkDomainPermission();
  if (result.state === 'unavailable' && !result.permissionRequired) {
    openRestrictedExternalWindow('https://www.wireshark.org/download.html');
    return { ...result, message: '已打开网络采集组件的官方安装入口，安装完成后点击卡片重新检测。' };
  }
  return result;
});

handleClient('security:startDomainMonitor', () => startNetworkDomainMonitor());
handleClient('security:stopDomainMonitor', () => stopNetworkDomainMonitor());
handleClient('security:resetDomains', () => resetNetworkDomainObservations());

handleClient('browser:setAllowedHosts', (_event, hosts: string[]) => {
  allowedHosts = new Set((hosts || []).map((item) => hostFromUrl(item) || item.toLowerCase()).filter(Boolean));
});

handleClient('browser:setContestScope', async (_event, baseUrl: string, contestId: string, clientWebUrl?: string, platform?: string, backendOrigin?: string) => {
  void resetNovaJudgeSubmit();
  novaJudgeBackendOrigin = '';
  if (backendOrigin) {
    const backend = new URL(backendOrigin);
    if (['https:', 'http:'].includes(backend.protocol) && backend.origin === backendOrigin) novaJudgeBackendOrigin = backendOrigin;
  }
  const previousNova = novaJudgeScope;
  novaJudgeClientAccessKey = '';
  if (platform === 'NOVAJUDGE') {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !/^[1-9]\d*$/.test(contestId) || !Number.isSafeInteger(Number(contestId))) throw new Error('NovaJudge 考试范围无效');
    novaJudgeScope = { origin: url.origin, contestId };
    contestScope = { host: url.hostname.toLowerCase(), contestId };
    contestClientScope = null;
    allowedHosts.add(contestScope.host);
    // No previous candidate's global/contest login survives a new session.
    await session.fromPartition('persist:proctor-oj').clearStorageData();
    return;
  }
  novaJudgeScope = null;
  if (previousNova) await session.fromPartition('persist:proctor-oj').clearStorageData();
  const host = hostFromUrl(baseUrl);
  if (host && contestId) {
    allowedHosts.add(host);
    contestScope = { host, contestId };
    try {
      const client = new URL(clientWebUrl || '');
      contestClientScope = { host: client.hostname.toLowerCase(), origin: client.origin };
      allowedHosts.add(contestClientScope.host);
    } catch {
      contestClientScope = null;
    }
  } else {
    contestScope = null;
    contestClientScope = null;
  }
});

handleClient('browser:installNovaJudgeLogin', async (_event, login: unknown) => {
  const blocked = () => screenControlWatcher.isDisplaying || windowMode === 'locked';
  if (!novaJudgeScope || blocked()) throw new Error('当前不能登录 NovaJudge');
  const scope = novaJudgeScope;
  void resetNovaJudgeSubmit();
  const generation = novaJudgeLoginGeneration;
  const cookie = novaJudgeCookie(login, scope);
  const key = novaJudgeClientKey(login);
  const target = session.fromPartition('persist:proctor-oj');
  await target.cookies.set(cookie);
  if (novaJudgeScope !== scope || generation !== novaJudgeLoginGeneration || blocked()) {
    await target.cookies.remove(scope.origin, 'user_token');
    throw new Error('考试状态已变化，请稍后重试');
  }
  novaJudgeClientAccessKey = key;
  novaJudgeSubmitLogin = { scope, backendOrigin: novaJudgeBackendOrigin, cookieToken: cookie.value, proctoringKey: key,
    contestAccessToken: (login as { contestAccessToken?: unknown }).contestAccessToken };
  // CLI preparation never blocks or invalidates the successful web login.
  void novaJudgeSubmit.connect(novaJudgeSubmitLogin);
  return `${scope.origin}/contest/${scope.contestId}`;
});
handleClient('novajudge-submit:status', () => novaJudgeSubmit.status);
handleClient('novajudge-submit:retry', () => {
  if (novaJudgeSubmitLogin && !screenControlWatcher.isDisplaying && windowMode !== 'locked') void novaJudgeSubmit.connect(novaJudgeSubmitLogin);
});

let windowMode: 'setup' | 'floating' | 'locked' = 'setup';
handleClient('screen-control:watch', (_event, identity: ScreenControlIdentity) => {
  // Accept only the trusted local client and its configured server. The state
  // itself is always fetched directly by the main process with this session.
  buildServerUrl(identity?.baseUrl, '/api/client/screen-control');
  return screenControlWatcher.watch(identity);
});
handleClient('screen-control:release', () => screenControlWatcher.release());
handleClient('screen-control:isDisplaying', () => screenControlWatcher.isDisplaying);
handleClient('window:mode', async (_event, mode: 'setup' | 'floating' | 'locked' | 'exit') => {
  if (mode === 'exit') {
    if (screenControlWatcher.isDisplaying) throw new Error('请等待监考老师结束屏幕展示');
    screenControlWatcher.release();
    windowMode = 'setup';
    cleanupMonitoring();
    novaJudgeScope = null;
    novaJudgeClientAccessKey = '';
    await novaJudgeSubmit.shutdown();
    app.exit(0);
    return;
  }
  if (mode === 'setup') void resetNovaJudgeSubmit();
  if (!mainWindow || !['setup', 'floating', 'locked'].includes(mode) || mode === windowMode) return;
  windowMode = mode;
  const locked = mode === 'locked';
  const protectedMode = mode !== 'setup';
  if (!protectedMode) windowsUsbEvents.stop();
  // Cheating and USB/peripheral lockdown cover the whole display. Normal exam
  // mode remains a movable, resizable window and backend unlock restores it.
  if (locked) {
    mainWindow.setFullScreen(true);
    mainWindow.setKiosk(true);
  } else {
    mainWindow.setKiosk(false);
    mainWindow.setFullScreen(false);
  }
  mainWindow.setAlwaysOnTop(locked, locked ? 'screen-saver' : 'normal');
  mainWindow.setClosable(!protectedMode);
  mainWindow.setMinimizable(!protectedMode);
  mainWindow.setMovable(true);
  mainWindow.setResizable(true);
});

handleClient('rtmp:stopPipes', () => {
  return stopRtmpPipes();
});

handleClient('rtmp:stop', () => {
  stopRtmpStreams();
  return stopRtmpPipes();
});
