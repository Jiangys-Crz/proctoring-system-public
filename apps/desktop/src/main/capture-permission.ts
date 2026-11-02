import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

export interface CapturePermissionResult { granted: boolean; message: string }
let pending: Promise<CapturePermissionResult> | null = null;

// Only the current OS user and a bounded device count enter this privileged command.
// It never accepts a command, path, or account from the renderer, and installs no daemon.
export function macCaptureDeviceCount(interfaceCount: number, existingDeviceNames: string[]) {
  if (!Number.isSafeInteger(interfaceCount) || interfaceCount < 0) throw new Error('无法确认网络接口数量');
  const existing = existingDeviceNames.map(name => /^bpf(\d{1,3})$/.exec(name))
    .filter((match): match is RegExpExecArray => !!match).map(match => Number(match[1]) + 1);
  // Other applications can occupy every previously authorized BPF device.
  // Include the existing pool, then reserve bounded headroom for our captures.
  return Math.min(256, Math.max(4, ...existing) + Math.min(64, interfaceCount + 4));
}

export function macCapturePermissionScript(uid: number, interfaceCount: number, existingDeviceNames: string[] = []) {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('无法确认当前登录用户');
  const count = macCaptureDeviceCount(interfaceCount, existingDeviceNames);
  const command = [
    'set -eu',
    'capture_index=0',
    `while [ "$capture_index" -lt ${count} ]; do`,
    '  capture_device="/dev/bpf$capture_index"',
    '  [ -c "$capture_device" ] || break',
    // Opening the last clone device creates the next one; count=0 reads no packets.
    '  /bin/dd if="$capture_device" of=/dev/null count=0 2>/dev/null || true',
    `  /usr/sbin/chown ${uid} "$capture_device"`,
    '  /bin/chmod u+rw "$capture_device"',
    '  capture_index=$((capture_index + 1))',
    'done',
    '[ "$capture_index" -gt 0 ]'
  ].join('\n');
  const appleString = (value: string) => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  return `do shell script ${appleString(command)} with administrator privileges with prompt "监考客户端需要允许当前登录用户进行网络检测。重启电脑后可能需要重新授权。"`;
}

export function requestMacCapturePermission(): Promise<CapturePermissionResult> {
  if (pending) return pending;
  if (process.platform !== 'darwin') return Promise.resolve({ granted: false, message: '当前系统不使用 macOS 网络授权。' });
  const uid = process.getuid?.();
  if (!uid) return Promise.resolve({ granted: uid === 0, message: uid === 0 ? '已具有网络检测权限。' : '无法确认当前登录用户。' });
  let devices: string[];
  try { devices = readdirSync('/dev'); }
  catch { return Promise.resolve({ granted: false, message: '无法读取网络检测设备，请重试或联系管理员。' }); }
  const script = macCapturePermissionScript(uid, Object.keys(networkInterfaces()).length, devices);
  pending = new Promise<CapturePermissionResult>((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 120000, maxBuffer: 65536 }, (error, _stdout, stderr) => {
      if (!error) resolve({ granted: true, message: '网络检测授权完成，正在重新检测。' });
      else if (/-128|cancelled|canceled|用户取消/i.test(stderr || error.message)) {
        resolve({ granted: false, message: '已取消网络检测授权，点击“网络检测”可再次申请。' });
      } else {
        console.warn('[capture-permission]', stderr || error.message);
        resolve({ granted: false, message: '网络检测授权未完成，请再次点击卡片并在系统窗口中完成管理员验证。' });
      }
    });
  }).finally(() => { pending = null; });
  return pending;
}
