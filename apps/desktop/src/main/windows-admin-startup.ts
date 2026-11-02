import path from 'node:path';
import type { App, Dialog } from 'electron';
import { launchWindowsElevated, readClientWindowsElevation, type ElevationLaunchResult, type ElevationStatus } from './windows-elevation';
import { writeStartupDiagnostic } from './startup';

type Runtime = Pick<App, 'isPackaged' | 'getAppPath' | 'getPath' | 'getVersion' | 'releaseSingleInstanceLock' | 'requestSingleInstanceLock'>;

export function windowsSecurityHelper(runtime: Pick<App, 'isPackaged'>, name: 'token-probe' | 'elevate-client') {
  return runtime.isPackaged ? path.join(process.resourcesPath, 'security', `${name}.exe`)
    : path.join(__dirname, '../../native', name === 'token-probe' ? 'windows-token' : 'windows-launcher', process.arch, `${name}.exe`);
}

export async function relaunchWindowsAdministrator(runtime: Runtime, launch = () => launchWindowsElevated(
  windowsSecurityHelper(runtime, 'elevate-client'), process.execPath, runtime.isPackaged ? undefined : runtime.getAppPath()
)): Promise<ElevationLaunchResult | 'replaced'> {
  runtime.releaseSingleInstanceLock();
  let result: ElevationLaunchResult;
  try { result = await launch(); }
  catch (error) {
    writeStartupDiagnostic(runtime, 'elevation-launch-failed', String(error));
    result = 'failed';
  }
  if (result !== 'started' && !runtime.requestSingleInstanceLock()) return 'replaced';
  return result;
}

/** Do this before loading the updater or creating any browser process. */
export async function ensureWindowsAdministrator(runtime: Runtime, dialogs: Pick<Dialog, 'showMessageBox'>, {
  status = () => readClientWindowsElevation(windowsSecurityHelper(runtime, 'token-probe')),
  relaunch = () => relaunchWindowsAdministrator(runtime),
}: { status?: () => Promise<ElevationStatus>; relaunch?: () => Promise<ElevationLaunchResult | 'replaced'> } = {}) {
  const elevation = await status();
  writeStartupDiagnostic(runtime, 'administrator-status', elevation);
  if (elevation === 'elevated') return true;
  if (elevation === 'unavailable') {
    await dialogs.showMessageBox({ type: 'error', title: '管理员权限检测失败', message: '无法确认客户端的管理员权限。',
      detail: '请重新安装完整客户端，并检查安全软件是否隔离了权限检测组件。检测失败不会被当作已授权。', buttons: ['关闭软件'], noLink: true });
    return false;
  }
  let result: ElevationLaunchResult | undefined;
  while (true) {
    const choice = await dialogs.showMessageBox({ type: 'warning', title: '需要管理员权限',
      message: result === 'cancelled' ? '已取消管理员授权，客户端尚未启动。' : result === 'failed' ? '管理员授权组件未能启动。' : '监考客户端需要管理员权限才能运行。',
      detail: result === 'failed' ? '可以关闭软件后右键选择“以管理员身份运行”。若仍然失败，请重新安装完整客户端并检查安全软件。'
        : '点击授权按钮后，请在 Windows 权限窗口中选择“是”或输入管理员账号和密码。授权成功后客户端会自动重新启动。',
      buttons: [result ? '重试管理员授权' : '申请管理员权限', '关闭软件'], defaultId: 0, cancelId: 1, noLink: true });
    if (choice.response !== 0) return false;
    const launched = await relaunch();
    writeStartupDiagnostic(runtime, 'administrator-relaunch', launched);
    if (launched === 'started' || launched === 'replaced') return false;
    result = launched;
  }
}
