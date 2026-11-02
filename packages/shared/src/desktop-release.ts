export const DESKTOP_TARGETS = ['mac-arm64', 'mac-x64', 'windows'] as const;
export type DesktopTarget = typeof DESKTOP_TARGETS[number];
export const DESKTOP_CHANNELS = ['public', 'intranet'] as const;
export type DesktopChannel = typeof DESKTOP_CHANNELS[number];
export interface DesktopReleaseFile { id: string; name: string; size: number; sha512: string; url: string }
export interface DesktopRelease {
  channel: DesktopChannel; target: DesktopTarget; version: string; notes: string; publishedAt: string; installationMode: 'manual';
  installer: DesktopReleaseFile; update: DesktopReleaseFile; feedUrl: string;
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
