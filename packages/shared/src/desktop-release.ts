export const DESKTOP_TARGETS = ['mac-arm64', 'mac-x64', 'windows', 'windows-x64', 'windows-arm64'] as const;
export type DesktopTarget = typeof DESKTOP_TARGETS[number];
export const DESKTOP_CHANNELS = ['public', 'intranet'] as const;
export type DesktopChannel = typeof DESKTOP_CHANNELS[number];
export const DESKTOP_FIXED_RUNTIME = 'wx-webview2-109' as const;
export const DESKTOP_MAC_RUNTIME = 'wx-wkwebview' as const;
export const DESKTOP_RELEASE_RUNTIMES = [DESKTOP_FIXED_RUNTIME, DESKTOP_MAC_RUNTIME] as const;
export type DesktopReleaseRuntime = typeof DESKTOP_RELEASE_RUNTIMES[number];
export function isDesktopReleaseRuntime(value: unknown): value is DesktopReleaseRuntime {
  return DESKTOP_RELEASE_RUNTIMES.includes(value as DesktopReleaseRuntime);
}
export function isSplitWindowsDesktopTarget(target: DesktopTarget): target is 'windows-x64' | 'windows-arm64' {
  return target === 'windows-x64' || target === 'windows-arm64';
}
export function isWindowsDesktopTarget(target: DesktopTarget): target is 'windows' | 'windows-x64' | 'windows-arm64' {
  return target === 'windows' || isSplitWindowsDesktopTarget(target);
}
export function supportsDesktopReleaseRuntime(target: DesktopTarget, runtime?: DesktopReleaseRuntime) {
  if (!runtime) return !isSplitWindowsDesktopTarget(target);
  return runtime === DESKTOP_FIXED_RUNTIME ? isWindowsDesktopTarget(target) : !isWindowsDesktopTarget(target);
}
export interface DesktopReleaseFile { id: string; name: string; size: number; sha512: string; url: string }
export interface DesktopRelease {
  channel: DesktopChannel; target: DesktopTarget; version: string; notes: string; publishedAt: string; installationMode: 'manual';
  installer: DesktopReleaseFile; update: DesktopReleaseFile; feedUrl: string; runtime?: DesktopReleaseRuntime;
}
export function desktopTarget(platform: string, arch: string): DesktopTarget | null {
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'win32' && ['x64', 'ia32', 'arm64'].includes(arch)) return 'windows';
  return null;
}
export function isDesktopTarget(value: unknown): value is DesktopTarget {
  return DESKTOP_TARGETS.includes(value as DesktopTarget);
}
export function isReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value);
}
export function compareReleaseVersions(a: string, b: string) {
  if (!isReleaseVersion(a) || !isReleaseVersion(b)) throw new Error('版本号应为 x.y.z');
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
