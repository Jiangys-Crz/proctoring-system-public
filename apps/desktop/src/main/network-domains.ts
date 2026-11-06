import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces, release } from 'node:os';
import { join } from 'node:path';
import { DomainWindow, normalizeDomain, parseDnsCapture, parseTsharkDomains, parseWindowsDnsCache } from './network-domain-data';
import { requestMacCapturePermission } from './capture-permission';
import type { NetworkDomainStatus } from '../shared/types';
import { windowsPowerShell, windowsSystemCommand } from './windows-system-command';

const observations = new DomainWindow();
let status: NetworkDomainStatus = { state: 'idle', message: '尚未检测整机外部域名采集能力' };
const captures = new Set<ChildProcessWithoutNullStreams>();
let cacheTimer: NodeJS.Timeout | null = null;
let starting: Promise<NetworkDomainStatus> | null = null;
let generation = 0;

function run(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { timeout: 6000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}

function tsharkPath() {
  const candidates = process.platform === 'win32'
    ? [join(process.env.ProgramFiles || 'C:\\Program Files', 'Wireshark', 'tshark.exe')]
    : ['/Applications/Wireshark.app/Contents/MacOS/tshark', '/opt/homebrew/bin/tshark', '/usr/local/bin/tshark', '/usr/bin/tshark'];
  return candidates.find(existsSync);
}

function localSourceFilter() {
  const addresses = Object.values(networkInterfaces()).flatMap((entries) => entries || [])
    .map((entry) => entry.address.split('%')[0]);
  if (!addresses.length) throw new Error('没有可用的本机网络接口');
  return `(${[...new Set(addresses)].map((address) => `src host ${address}`).join(' or ')})`;
}

function macCaptureInterfaces() {
  // Link-local-only AWDL/LLW and idle tunnel interfaces do not carry the
  // machine's external DNS requests. Opening all of them exhausts BPF devices
  // (and makes one unrelated interface failure block the entire check).
  const interfaces = Object.entries(networkInterfaces())
    .filter(([name, addresses]) => name === 'lo0' || addresses?.some((entry) =>
      !entry.internal && !/^fe80:/i.test(entry.address) && !entry.address.startsWith('169.254.')
    ))
    .map(([name]) => name);
  return interfaces.sort((left, right) => {
    const priority = (name: string) => name === 'lo0' ? 2 : /^en\d+$/.test(name) ? 0 : 1;
    return priority(left) - priority(right);
  });
}

async function startCapture(command: string, args: string[], tshark: boolean, current: number) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'pipe' });
    captures.add(child);
    let pending = '';
    let ready = false;
    let ended = false;
    let stderr = '';
    let readyTimer: NodeJS.Timeout | null = null;
    const timeout = setTimeout(() => fail(new Error('域名采集启动超时')), 5000);
    const fail = (error: Error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timeout);
      if (readyTimer) clearTimeout(readyTimer);
      if (!child.killed) child.kill();
      captures.delete(child);
      if (!ready) reject(error);
      else if (generation === current) status = { state: 'unavailable', message: '网络采集中断，请点击“网络检测”重新申请或检测权限。', permissionRequired: /permission|permitted|denied/i.test(error.message) };
    };
    child.on('error', fail);
    child.on('exit', () => fail(new Error(stderr.trim().slice(-600) || '采集程序已退出')));
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
      if (/permission denied|operation not permitted|don't have permission|access.*denied/i.test(stderr)) {
        fail(new Error(stderr.trim()));
        return;
      }
      if (!ready && !readyTimer && /listening on|Capturing on|Capture started/i.test(stderr)) {
        // tshark may print 'Capturing on' before failing its permission check.
        readyTimer = setTimeout(() => {
          if (child.exitCode !== null || child.killed || generation !== current) {
            fail(new Error('采集启动已取消'));
            return;
          }
          ready = true;
          clearTimeout(timeout);
          resolve();
        }, 300);
      }
    });
    child.stdout.on('data', (chunk) => {
      if (generation !== current) return;
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      if (pending.length > 65536) pending = '';
      for (const line of lines) observations.add(tshark ? parseTsharkDomains(line) : parseDnsCapture(line));
    });
  });
}

async function startWindowsCache(current: number) {
  const script = "Get-DnsClientCache -ErrorAction Stop | Where-Object { $_.Type -in 1,28,5 -and $_.Status -eq 0 } | Select-Object -ExpandProperty Entry | ConvertTo-Json -Compress";
  let previous = new Set<string>();
  let first = true;
  let useLegacyIpconfig = /^6\.1(?:\.|$)/.test(release());
  const readNames = async () => {
    if (!useLegacyIpconfig) {
      try {
        const output = await run(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', script]);
        const parsed = output.trim() ? JSON.parse(output) : [];
        return (Array.isArray(parsed) ? parsed : [parsed]).map((name) => normalizeDomain(String(name))).filter(Boolean);
      } catch {
        // Windows 7 does not provide Get-DnsClientCache. Its ipconfig output is
        // localized, so parse only colon-delimited values that are valid domains.
        useLegacyIpconfig = true;
      }
    }
    return parseWindowsDnsCache(await run(windowsSystemCommand('ipconfig.exe'), ['/displaydns']));
  };
  const poll = async () => {
    if (generation !== current) return;
    const names = new Set<string>(await readNames());
    if (generation !== current) return;
    if (!first) observations.add([...names].filter((domain) => !previous.has(domain)).map((domain) => ({ domain, source: 'DNS 缓存新增' })));
    previous = names;
    first = false;
  };
  await poll(); // Existing cached names predate monitoring and must never be reported as new visits.
  if (generation !== current) return;
  const tick = async () => {
    try { await poll(); }
    catch { if (generation === current) status = { state: 'unavailable', message: '无法读取系统 DNS 缓存；请检查权限或安装 Wireshark/Npcap 后重试。' }; }
    if (generation === current) cacheTimer = setTimeout(tick, 3000);
  };
  cacheTimer = setTimeout(tick, 3000);
  status = { state: 'limited', message: '网络检测已授权' };
}

export function getNetworkDomainStatus(): NetworkDomainStatus { return { ...status }; }

export function stopNetworkDomainMonitor() {
  generation += 1;
  starting = null;
  if (cacheTimer) clearTimeout(cacheTimer);
  cacheTimer = null;
  for (const child of captures) if (!child.killed) child.kill();
  captures.clear();
  observations.clear();
  status = { state: 'idle', message: '整机外部域名采集未启动' };
}

export async function startNetworkDomainMonitor(): Promise<NetworkDomainStatus> {
  if (starting) return starting;
  if (status.state === 'limited' || status.state === 'ready') return getNetworkDomainStatus();
  stopNetworkDomainMonitor();
  const current = generation;
  const pending = (async () => {
    try {
      const tshark = tsharkPath();
      let packetCaptureStarted = false;
      if (tshark) try {
        const listing = await run(tshark, ['-D']);
        if (generation !== current) return getNetworkDomainStatus();
        const interfaces = listing.split(/\r?\n/).filter((line) => !/extcap|sshdump|ciscodump|randpkt|udpdump|wifidump/i.test(line))
          .map((line) => line.match(/^\d+\. (\S+)/)?.[1]).filter((name): name is string => Boolean(name));
        if (!interfaces.length) throw new Error('未找到可采集的网络接口');
        const selected = process.platform === 'darwin'
          ? interfaces.filter((name) => Object.hasOwnProperty.call(networkInterfaces(), name))
          : interfaces.includes('any') ? ['any'] : interfaces;
        if (!selected.length) throw new Error('没有可用的本机网络接口');
        await startCapture(tshark, [
          ...selected.flatMap((name) => ['-i', name]), '-p', '-n', '-l',
          '-f', `${localSourceFilter()} and (port 53 or tcp or udp port 443)`,
          '-Y', '(dns.flags.response == 0) or tls.handshake.extensions_server_name or http.host',
          '-T', 'fields', '-e', 'dns.qry.name', '-e', 'tls.handshake.extensions_server_name', '-e', 'http.host'
        ], true, current);
        if (generation === current) status = { state: 'ready', message: '网络检测已授权' };
        packetCaptureStarted = true;
      } catch (error) {
        if (generation !== current) return getNetworkDomainStatus();
        // A broken optional Wireshark/Npcap installation must not suppress
        // the same built-in fallback used when Wireshark is absent.
        console.warn('[network-domains] Wireshark unavailable; trying built-in capture', error instanceof Error ? error.message : String(error));
        for (const child of captures) if (!child.killed) child.kill();
        captures.clear();
      }
      if (generation !== current) return getNetworkDomainStatus();
      if (packetCaptureStarted) return getNetworkDomainStatus();
      if (process.platform === 'win32') {
        await startWindowsCache(current);
      } else {
        const command = ['/usr/sbin/tcpdump', '/usr/bin/tcpdump'].find(existsSync);
        if (!command) throw new Error('未安装 tcpdump 或 Wireshark');
        // Darwin's 'any'/pktap needs permission to create a virtual interface even
        // after BPF access is granted. Capture each existing interface instead.
        const interfaces = process.platform === 'darwin' ? macCaptureInterfaces() : ['any'];
        if (!interfaces.some((name) => name !== 'lo0')) throw new Error('没有可用的外部网络接口');
        let externalStarted = 0;
        let failed = 0;
        let firstError: unknown;
        for (const name of interfaces) {
          if (generation !== current) return getNetworkDomainStatus();
          try {
            await startCapture(command, ['-i', name, '-p', '-n', '-l', '-s', '1500', `${localSourceFilter()} and udp dst port 53`], false, current);
            if (name !== 'lo0') externalStarted += 1;
          } catch (error) {
            firstError ??= error;
            failed += 1;
          }
        }
        if (!externalStarted) throw firstError ?? new Error('外部网络接口采集未启动');
        if (generation === current) status = {
          state: 'limited',
          message: failed ? `网络检测部分可用：${failed} 个接口采集失败` : '网络检测已授权'
        };
      }
    } catch (error) {
      console.warn('[network-domains]', error instanceof Error ? error.message : String(error));
      if (generation === current) {
        stopNetworkDomainMonitor();
        const permissionRequired = /permission|permitted|denied|权限/i.test(error instanceof Error ? error.message : String(error));
        status = {
          state: 'unavailable', permissionRequired,
          message: permissionRequired
            ? '缺少网络检测权限，点击此卡片发起系统授权。'
            : '网络采集工具未就绪，点击此卡片重新检测或打开安装入口。'
        };
      }
    }
    return getNetworkDomainStatus();
  })().finally(() => { if (starting === pending) starting = null; });
  starting = pending;
  return pending;
}

export function networkRemotes(allowedHosts: string[]) { return observations.snapshot(allowedHosts); }
export function resetNetworkDomainObservations() { observations.clear(); }

let requestingPermission: Promise<NetworkDomainStatus> | null = null;
export function requestNetworkDomainPermission(): Promise<NetworkDomainStatus> {
  if (requestingPermission) return requestingPermission;
  requestingPermission = (async () => {
    const currentStatus = await startNetworkDomainMonitor();
    if (currentStatus.state !== 'unavailable' || process.platform !== 'darwin' || !currentStatus.permissionRequired) return currentStatus;
    const current = generation;
    const result = await requestMacCapturePermission();
    if (generation !== current) return getNetworkDomainStatus();
    if (!result.granted) {
      status = { state: 'unavailable', permissionRequired: true, message: result.message };
      return getNetworkDomainStatus();
    }
    return startNetworkDomainMonitor();
  })().finally(() => { requestingPermission = null; });
  return requestingPermission;
}
