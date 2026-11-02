import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { windowsPowerShell, windowsUtf8Output } from './windows-system-command';

export interface ProcessIdentity { pid: number; name: string; executable?: string; command?: string }
export interface ExecutableProof { canonicalPath: string; uid: number; mode: number; sha256: string }
export interface ProcessPolicyDependencies {
  inspect(file: string): Promise<ExecutableProof>;
  signer(file: string, platform: string): Promise<string>;
  hashes: Record<string, string>;
}

const windowsSystem = new Set(['svchost.exe', 'services.exe', 'wininit.exe', 'winlogon.exe', 'csrss.exe', 'lsass.exe', 'dwm.exe', 'conhost.exe', 'explorer.exe', 'runtimebroker.exe', 'taskhostw.exe', 'audiodg.exe', 'ctfmon.exe', 'fontdrvhost.exe', 'dllhost.exe', 'sihost.exe', 'spoolsv.exe', 'wmiprvse.exe', 'searchhost.exe', 'searchindexer.exe', 'startmenuexperiencehost.exe', 'shellexperiencehost.exe', 'textinputhost.exe', 'securityhealthservice.exe', 'securityhealthsystray.exe', 'msmpeng.exe', 'nissrv.exe']);
const macSystem = new Set(['launchd', 'kernel_task', 'WindowServer', 'Finder', 'Dock', 'loginwindow', 'SystemUIServer', 'ControlCenter', 'NotificationCenter', 'coreaudiod', 'cfprefsd', 'distnoted', 'mds', 'mdworker', 'mdworker_shared', 'trustd', 'securityd', 'lsd', 'notifyd', 'bluetoothd', 'powerd', 'runningboardd', 'sharingd', 'tccd', 'rapportd']);
const linuxSystem = new Set(['systemd', 'systemd-journald', 'systemd-logind', 'systemd-resolved', 'systemd-udevd', 'dbus-daemon', 'dbus-broker', 'NetworkManager', 'Xorg', 'Xwayland', 'gnome-shell', 'gnome-session-binary', 'pipewire', 'wireplumber', 'pulseaudio', 'accounts-daemon', 'polkitd', 'sshd']);
const ideNames = new Set(['code.exe', 'code', 'electron', 'code helper', 'code helper (renderer)', 'code helper (gpu)', 'code helper (plugin)', 'idea64.exe', 'idea', 'pycharm64.exe', 'pycharm', 'clion64.exe', 'clion', 'rider64.exe', 'rider', 'goland64.exe', 'goland', 'eclipse.exe', 'eclipse']);
function certificateSubject(value: string, attribute: string) {
  const match = new RegExp('(?:^|,\\s*)' + attribute + '=(?:"([^"]+)"|([^,]+))', 'i').exec(value);
  return (match?.[1] || match?.[2] || '').trim();
}
function windowsPublisher(signature: string, vendor: 'Microsoft' | 'JetBrains' | 'Eclipse') {
  const organization = certificateSubject(signature, 'O'), name = certificateSubject(signature, 'CN');
  if (vendor === 'Microsoft') return organization === 'Microsoft Corporation' && ['Microsoft Corporation', 'Microsoft Windows', 'Microsoft Windows Publisher'].includes(name);
  if (vendor === 'JetBrains') return organization === 'JetBrains s.r.o.' && name === 'JetBrains s.r.o.';
  return organization === 'Eclipse Foundation, Inc.' && name === 'Eclipse Foundation, Inc.';
}

function canonicalKey(value: string, platform: string) { return platform === 'win32' ? path.win32.normalize(value).toLowerCase() : path.posix.normalize(value); }
function within(file: string, root: string, platform: string) {
  const separator = platform === 'win32' ? '\\' : '/';
  return canonicalKey(file, platform).startsWith(canonicalKey(root, platform).replace(/[\\/]+$/, '') + separator);
}

// Administrative hashes pin unsigned tools (including Linux versions) to an
// exact executable and location. They are bundled with the installed client.
export async function trustedProcessExecutable(entry: ProcessIdentity, platform: string, deps: ProcessPolicyDependencies): Promise<boolean> {
  if (!entry.executable) return platform === 'win32' && [0, 4].includes(entry.pid) && ['system', 'system idle process', 'idle'].includes(entry.name.toLowerCase());
  const rawName = (platform === 'win32' ? path.win32 : path.posix).basename(entry.executable);
  const named = platform === 'win32' ? windowsSystem.has(rawName.toLowerCase()) || ideNames.has(rawName.toLowerCase())
    : platform === 'darwin' ? macSystem.has(rawName) || ideNames.has(rawName.toLowerCase()) : linuxSystem.has(rawName);
  if (!named && !Object.keys(deps.hashes).some(file => canonicalKey(file, platform) === canonicalKey(entry.executable!, platform))) return false;
  try {
    const proof = await deps.inspect(entry.executable);
    const parser = platform === 'win32' ? path.win32 : path.posix;
    const executableName = parser.basename(proof.canonicalPath);
    const name = platform === 'win32' ? executableName.toLowerCase() : executableName;
    const key = canonicalKey(proof.canonicalPath, platform);
    const pinned = Object.entries(deps.hashes).find(([file]) => canonicalKey(file, platform) === key)?.[1];
    if (pinned && /^[a-f0-9]{64}$/i.test(pinned) && pinned.toLowerCase() === proof.sha256.toLowerCase()) return true;
    if (platform === 'win32') {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const systemPath = ['System32', 'SysWOW64'].some(folder => within(key, path.win32.join(systemRoot, folder), platform)) || key === canonicalKey(path.win32.join(systemRoot, 'explorer.exe'), platform);
      if (windowsSystem.has(name) && systemPath) return windowsPublisher(await deps.signer(proof.canonicalPath, platform), 'Microsoft');
      const vendor = name === 'code.exe' ? 'Microsoft' : /^(?:idea|pycharm|clion|rider|goland)64\.exe$/.test(name) ? 'JetBrains' : name === 'eclipse.exe' ? 'Eclipse' : null;
      const installed = ['C:\\Program Files', 'C:\\Program Files (x86)'].some(root => within(key, root, platform));
      return Boolean(vendor && installed && windowsPublisher(await deps.signer(proof.canonicalPath, platform), vendor));
    }
    const rootOwned = proof.uid === 0 && !(proof.mode & 0o022);
    if (platform === 'darwin') {
      if (rootOwned && macSystem.has(name) && ['/System/', '/usr/libexec/', '/usr/sbin/', '/sbin/'].some(root => within(key, root, platform))) {
        // The real probe applies the designated Apple anchor requirement; an
        // Apple-looking Identifier alone does not grant platform trust.
        return (await deps.signer(proof.canonicalPath, platform)).startsWith('VerifiedAppleAnchor=1\n');
      }
      if (!ideNames.has(name.toLowerCase()) || !within(key, '/Applications', platform)) return false;
      const signature = await deps.signer(proof.canonicalPath, platform);
      const identifier = /^Identifier=(.+)$/m.exec(signature)?.[1] || '';
      const team = /^TeamIdentifier=(.+)$/m.exec(signature)?.[1] || '';
      if (name.toLowerCase().startsWith('code') || name === 'Electron') return team === 'UBF8T346G9' && /^com\.microsoft\.VSCode(?:\.|$)/.test(identifier);
      const jetbrains = /^(idea|pycharm|clion|rider|goland)$/i.exec(name)?.[1].toLowerCase();
      const products: Record<string, string> = { idea: 'intellij', pycharm: 'pycharm', clion: 'CLion', rider: 'rider', goland: 'goland' };
      return Boolean(jetbrains && team === '2ZEFAR8TH3' && new RegExp('^com\\.jetbrains\\.' + products[jetbrains] + '(?:\\.|$)', 'i').test(identifier));
      // Eclipse and unsigned tools use explicit administrative SHA-256 pins.

    }
    // Linux has no general code-signing authority: root-owned system binaries
    // are narrowly named; all IDEs and tools require the packaged SHA-256 pins.
    return rootOwned && linuxSystem.has(name) && ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/libexec'].some(root => within(key, root, platform));
  } catch { return false; }
}

function command(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => execFile(command, args, { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
}
const proofs = new Map<string, { stamp: string; proof: ExecutableProof }>();
const pendingSigners = new Map<string, Promise<string>>();
const signers = new Map<string, { stamp: string; signer: string }>();
export function installedProcessPolicy(manifestFile: string): ProcessPolicyDependencies {
  let hashes: Record<string, string> = {};
  try {
    const value = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (value.version === 1 && value.executables && typeof value.executables === 'object' && !Array.isArray(value.executables)) hashes = value.executables;
  } catch { /* A missing manifest never permits unsigned programs. */ }
  const inspect = async (file: string) => {
    const canonicalPath = realpathSync(file);
    const stat = statSync(canonicalPath);
    if (!stat.isFile()) throw new Error('进程文件不可验证');
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const prior = proofs.get(canonicalPath);
    if (prior?.stamp === stamp) return prior.proof;
    const pinned = Object.keys(hashes).some(file => canonicalKey(file, process.platform) === canonicalKey(canonicalPath, process.platform));
    const proof = { canonicalPath, uid: stat.uid, mode: stat.mode, sha256: pinned ? createHash('sha256').update(readFileSync(canonicalPath)).digest('hex') : '' };
    proofs.set(canonicalPath, { stamp, proof });
    return proof;
  };
  const signer = async (file: string, platform: string) => {
    const stat = statSync(file);
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (signers.get(file)?.stamp === stamp) return signers.get(file)!.signer;
    const key = `${platform}:${file}:${stamp}`;
    if (pendingSigners.has(key)) return pendingSigners.get(key)!;
    const pending = (async () => {
    let signer = '';
    if (platform === 'win32') {
      const quoted = "'" + file.replace(/'/g, "''") + "'";
      const script = `${windowsUtf8Output}\n$ErrorActionPreference = 'Stop'\n` +
        `if ((Get-Command Get-AuthenticodeSignature).Parameters.ContainsKey('LiteralPath')) { $s = Get-AuthenticodeSignature -LiteralPath ${quoted} } ` +
        `else { $s = Get-AuthenticodeSignature -FilePath ([System.Management.Automation.WildcardPattern]::Escape(${quoted})) }; ` +
        `if ($s.Status -ne 'Valid') { exit 1 }; $s.SignerCertificate.Subject`;
      const result = await command(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', script]);
      signer = result.stdout.trim();
    } else if (platform === 'darwin') {
      const system = ['/System/', '/usr/libexec/', '/usr/sbin/', '/sbin/'].some(root => within(file, root, platform));
      await command('/usr/bin/codesign', ['--verify', '--strict', '-R=' + (system ? 'anchor apple' : 'anchor apple generic'), file]);
      const result = await command('/usr/bin/codesign', ['-dv', '--verbose=4', file]);
      signer = (system ? 'VerifiedAppleAnchor=1\n' : '') + result.stderr;
      if (!system && !/^TeamIdentifier=[A-Z0-9]+$/m.test(signer)) throw new Error('缺少可信签名');
    }
    signers.set(file, { stamp, signer });
    return signer;
    })();
    pendingSigners.set(key, pending);
    try { return await pending; }
    finally { if (pendingSigners.get(key) === pending) pendingSigners.delete(key); }
  };
  return { inspect, signer, hashes };
}
