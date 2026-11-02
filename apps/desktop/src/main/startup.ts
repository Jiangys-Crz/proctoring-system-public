import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { App } from 'electron';

export function configureWindowsRendering(runtime: Pick<App, 'disableHardwareAcceleration' | 'commandLine'> & Partial<Pick<App, 'getPath'>>, platform = process.platform) {
  if (platform !== 'win32') return;
  // Apply before app readiness or any BrowserWindow. Old Windows graphics
  // drivers can crash Chromium before the login page has painted.
  runtime.disableHardwareAcceleration();
  runtime.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  try {
    if (!runtime.getPath) return;
    const directory = path.join(runtime.getPath('userData'), 'logs');
    mkdirSync(directory, { recursive: true });
    runtime.commandLine.appendSwitch('enable-logging', 'file');
    runtime.commandLine.appendSwitch('log-file', path.join(directory, 'chromium-startup.log'));
  } catch {}
}

export function writeStartupDiagnostic(runtime: Pick<App, 'getPath' | 'getVersion'>, event: string, detail: string) {
  try {
    const directory = path.join(runtime.getPath('userData'), 'logs');
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'startup.log');
    try { if (statSync(file).size > 512 * 1024) writeFileSync(file, ''); } catch {}
    appendFileSync(file, `${new Date().toISOString()} v${runtime.getVersion()} ${process.platform}/${process.arch} ${event}: ${detail}\n`);
  } catch {
    // Logging must not prevent startup on a machine with a damaged profile.
  }
}

export function startupFailureDetail(runtime: Pick<App, 'getPath'>, duringRuntime = false) {
  const message = duringRuntime
    ? '客户端页面进程异常退出，自动恢复未完成。请联系监考老师检查日志并恢复考试；该提示不表示安装包损坏。'
    : '客户端页面未能正常启动，请联系监考老师检查日志及客户端安装。';
  try {
    return `${message}若问题持续，请将此目录中的日志交给监考老师：\n${path.join(runtime.getPath('userData'), 'logs')}\n\n崩溃报告目录：${runtime.getPath('crashDumps')}`;
  } catch {
    return `${message}无法读取客户端用户数据目录，请联系监考老师检查本机文件权限。`;
  }
}
