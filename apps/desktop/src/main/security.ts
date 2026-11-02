import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { hostname, platform, release, userInfo } from 'node:os';
import { basename, join, normalize } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readlinkSync } from 'node:fs';
import { app } from 'electron';
import { getNetworkDomainStatus, networkRemotes } from './network-domains';
import { installedProcessPolicy, trustedProcessExecutable } from './process-policy';
import { readClientWindowsElevation, type ElevationStatus } from './windows-elevation';
import { writeStartupDiagnostic } from './startup';
import { physicalUsbIdentity } from './windows-usb-identity';

function windowsTokenProbe() {
  return app.isPackaged
    ? join(process.resourcesPath, 'security', 'token-probe.exe')
    : join(__dirname, '../../native/windows-token', process.arch, 'token-probe.exe');
}

function windowsInventoryProbe() {
  return app.isPackaged
    ? join(process.resourcesPath, 'security', 'inventory-probe.exe')
    : join(__dirname, '../../native/windows-inventory', process.arch, 'inventory-probe.exe');
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  error: string;
}

interface ProcessEntry {
  pid: number;
  name: string;
  executable?: string;
  command?: string;
}

function execResult(command: string, args: string[] = [], timeout = 5000) {
  return new Promise<ExecResult>((resolve) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        code: typeof failure?.code === 'number' ? failure.code : error ? 1 : 0,
        error: error?.message || ''
      });
    });
  });
}

function exec(command: string, args: string[] = [], timeout = 5000) {
  return execResult(command, args, timeout).then((result) => {
    if (result.code !== 0) throw new Error(result.error || result.stderr || `${command} 执行失败`);
    return result.stdout;
  });
}

function normalized(value: string) {
  return value.toLowerCase();
}

function withExeExtension(name: string) {
  const lower = normalized(name.trim());
  if (!lower) return lower;
  return lower.endsWith('.exe') ? lower : `${lower}.exe`;
}

function appBundleName(value: string) {
  const match = value.match(/\/([^/]+)\.app\//);
  return match?.[1] || '';
}

function processDisplayName(entry: ProcessEntry) {
  return appBundleName(entry.executable || '') || appBundleName(entry.command || '') || entry.name || `PID ${entry.pid}`;
}

function uniqueProcessNames(entries: ProcessEntry[]) {
  return Array.from(new Set(entries.map(processDisplayName))).slice(0, 60);
}

let processPolicy: ReturnType<typeof installedProcessPolicy> | null = null;
function clientProcessPolicy() {
  // The installed ASAR policy is immutable until the application is updated.
  return processPolicy ??= installedProcessPolicy(join(__dirname, '../renderer/process-policy.json'));
}

async function isAllowedProcessEntry(entry: ProcessEntry) {
  if (entry.pid === process.pid) return true;
  // The Chinese product name no longer matches the legacy "proctor" needles.
  // Trust our exact binaries, not every process containing the same display name.
  const executable = normalized(normalize(entry.executable || ''));
  const ownBinaries = [process.execPath, process.resourcesPath && join(process.resourcesPath, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), process.platform === 'win32' && windowsTokenProbe(), process.platform === 'win32' && windowsInventoryProbe()]
    .filter((value): value is string => Boolean(value)).map((value) => normalized(normalize(value)));
  if (entry.executable && ownBinaries.includes(executable)) return true;
  if (process.platform === 'darwin' && process.resourcesPath) {
    const bundleRoot = process.resourcesPath.match(/^(.*\.app)\/Contents\/Resources$/)?.[1];
    if (bundleRoot) {
      const mainName = basename(process.execPath);
      const names = ['', ' (Renderer)', ' (GPU)', ' (Plugin)'].map(suffix => `${mainName} Helper${suffix}`);
      if (names.some(name => entry.executable === `${bundleRoot}/Contents/Frameworks/${name}.app/Contents/MacOS/${name}`)) return true;
    }
  }
  return trustedProcessExecutable(entry, process.platform, clientProcessPolicy());
}

function parseCsvLine(line: string) {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ',' && !quoted) {
      fields.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

function parsePidRows(output: string) {
  const rows = new Map<number, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    rows.set(Number(match[1]), match[2]);
  }
  return rows;
}

export function getDeviceId() {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'device-id');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const id = randomUUID();
  writeFileSync(file, id);
  return id;
}

export function getDesktopInfo() {
  return {
    deviceId: getDeviceId(),
    hostname: hostname(),
    os: `${platform()} ${release()}`,
    clientVersion: app.getVersion()
  };
}

async function listProcessEntries(): Promise<ProcessEntry[]> {
  if (process.platform === 'win32') {
    const output = await exec(windowsInventoryProbe(), ['processes']);
    const entries = output
      .split(/\r?\n/)
      .map((line) => parseCsvLine(line))
      .filter((fields) => fields[0] !== 'Id')
      .map((fields) => {
        const pid = /^\d+$/.test(fields[0]) ? Number(fields[0]) : NaN;
        const kernel = [0, 4].includes(pid) && ['system', 'system idle process', 'idle'].includes(normalized(fields[1] || ''));
        return { pid, name: kernel ? fields[1] : fields[1] ? withExeExtension(fields[1]) : '',
          executable: fields[2] || undefined, command: fields[2] || undefined };
      })
      .filter((entry) => entry.name && Number.isSafeInteger(entry.pid) && entry.pid >= 0);
    if (!entries.length) throw new Error('进程检测未读取到有效的进程列表，请重新检测或检查系统组件。');
    return entries;
  }
  const [commOutput, argsOutput] = await Promise.all([
    exec('/bin/ps', ['-axo', 'pid=,comm=']),
    exec('/bin/ps', ['-axo', 'pid=,args='])
  ]);
  const commands = parsePidRows(commOutput);
  const args = parsePidRows(argsOutput);
  return Array.from(commands.entries())
    .map(([pid, executable]) => {
      if (process.platform === 'linux') {
        try { executable = readlinkSync(`/proc/${pid}/exe`); } catch { executable = ''; }
      }
      return { pid, executable: executable || undefined, command: args.get(pid) || '', name: basename(executable) || commands.get(pid) || `PID ${pid}` };
    })
    .filter((entry) => entry.name && entry.pid);
}

export async function listProcesses() {
  return uniqueProcessNames(await listProcessEntries());
}

async function disallowedProcessEntries() {
  const processes = await listProcessEntries();
  const disallowed: ProcessEntry[] = [];
  for (let offset = 0; offset < processes.length; offset += 8) {
    const batch = processes.slice(offset, offset + 8);
    const allowed = await Promise.all(batch.map(isAllowedProcessEntry));
    batch.forEach((entry, index) => { if (!allowed[index]) disallowed.push(entry); });
  }
  return disallowed;
}

export async function disallowedProcesses() {
  return uniqueProcessNames(await disallowedProcessEntries());
}

let macUsbDataTypePromise: Promise<'SPUSBHostDataType' | 'SPUSBDataType'> | null = null;

async function macUsbDataType() {
  if (!macUsbDataTypePromise) {
    macUsbDataTypePromise = exec('/usr/sbin/system_profiler', ['-listDataTypes']).then((available) => {
      if (/^SPUSBHostDataType$/m.test(available)) return 'SPUSBHostDataType' as const;
      if (/^SPUSBDataType$/m.test(available)) return 'SPUSBDataType' as const;
      throw new Error('当前 macOS 未提供 USB 外设信息');
    }).catch((error) => {
      macUsbDataTypePromise = null;
      throw error;
    });
  }
  return macUsbDataTypePromise;
}

export async function peripheralsFingerprint() {
  // Capability probes and heartbeat scans can overlap. One OS inventory must
  // count as one observation, never as two confirmations of a transient change.
  if (pendingPeripheralScan) return pendingPeripheralScan;
  const scan = scanPeripherals().then(fingerprint => {
    const now = Date.now();
    lastPeripheralObservation = { fingerprint, observedAt: now, sequence: ++peripheralObservationSequence };
    if (!stablePeripheralFingerprint || fingerprint === stablePeripheralFingerprint) {
      stablePeripheralFingerprint = fingerprint;
      peripheralChange = null;
    } else if (peripheralChange?.fingerprint !== fingerprint) {
      peripheralChange = { fingerprint, firstSeenAt: now };
    } else if (now - peripheralChange.firstSeenAt >= (process.platform === 'win32' ? 3000 : 1000)) {
      stablePeripheralFingerprint = fingerprint;
      peripheralChange = null;
    }
    return stablePeripheralFingerprint;
  }).catch(error => {
    // A failed/partial scan is neither an empty device set nor a second vote.
    peripheralChange = null;
    throw error;
  });
  pendingPeripheralScan = scan;
  try { return await scan; }
  finally { if (pendingPeripheralScan === scan) pendingPeripheralScan = null; }
}

let pendingPeripheralScan: Promise<string> | null = null;
let stablePeripheralFingerprint = '';
let peripheralChange: { fingerprint: string; firstSeenAt: number } | null = null;
let peripheralObservationSequence = 0;
let lastPeripheralObservation: { fingerprint: string; observedAt: number; sequence: number } | null = null;

// Used only by the guarded pre-login IPC. Never reset the monitoring state:
// a pending real change must settle before a new login can adopt its baseline.
export async function confirmPeripheralBaseline() {
  let previous: typeof lastPeripheralObservation = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    await peripheralsFingerprint();
    const observed = lastPeripheralObservation;
    if (observed && previous && observed.sequence !== previous.sequence
      && observed.fingerprint === previous.fingerprint && observed.observedAt - previous.observedAt >= 1000
      && !peripheralChange && stablePeripheralFingerprint === observed.fingerprint) return observed.fingerprint;
    previous = observed;
    if (attempt < 3) await new Promise<void>(resolve => setTimeout(resolve, 1100));
  }
  throw new Error('设备检测未稳定，请稍后重试');
}

function normalizedUsbDevices(output: string) {
  const rows = output.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim()).map(parseCsvLine);
  const header = rows.shift() || [];
  const deviceColumn = header.indexOf('DeviceID'), presentColumn = header.indexOf('Present');
  const busColumn = header.indexOf('BusType'), hardwareColumn = header.indexOf('HardwareID');
  if ([deviceColumn, presentColumn, busColumn, hardwareColumn].some(column => column < 0)
    || !rows.length || rows.some(row => row.length !== header.length || !row[deviceColumn])) {
    throw new Error('未读取到有效的 USB 外设信息');
  }
  const devices = new Set<string>();
  for (const row of rows) {
    const id = row[deviceColumn].trim().toUpperCase();
    const present = row[presentColumn].trim().toLowerCase();
    if (!['true', 'false'].includes(present)) throw new Error('USB 外设状态无效');
    const bus = row[busColumn].trim().toUpperCase();
    const hardware = row[hardwareColumn].trim().toUpperCase();
    if (!['USB', 'OTHER', 'UNKNOWN'].includes(bus)) throw new Error('USB 总线信息无效');
    // The native collector uses DIGCF_PRESENT even on Windows 7, excluding
    // disconnected historical devices without WMI's missing Present property.
    // Physical USB parents persist when audio/video/HID child interfaces start
    // or stop. Display names, software endpoints and MI_xx children do not.
    // Windows 7 vendor USB 3 drivers may publish a different PnP enumerator.
    // Read bus/hardware metadata instead of treating every non-USB\\ ID as
    // a non-USB device. Software, HID and storage child nodes are not parents.
    const usb = /^USB\\/.test(id) || /^USB\\/.test(hardware) || bus === 'USB';
    if (usb && !/^[^\\]+\\[^\\]+\\.+$/.test(id)) throw new Error('USB 外设身份信息不完整');
    if (present === 'false' || !usb) continue;
    const identity = physicalUsbIdentity(id, bus, hardware);
    if (identity) devices.add(identity);
  }
  return [...devices].sort();
}

type HardwareEntry = Record<string, unknown>;

function hardwareValue(entry: HardwareEntry, keys: string[]) {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const normalized = String(value).trim().toLowerCase();
      if (normalized) return normalized;
    }
  }
  return '';
}

function hardwareHex(entry: HardwareEntry, keys: string[]) {
  const value = hardwareValue(entry, keys);
  // Old profiler versions append the vendor name or a changing USB address.
  // Retain the numeric vendor/product ID and physical port location only.
  return value.match(/0x([0-9a-f]+)/)?.[1].replace(/^0+(?=.)/, '') || value;
}

function normalizedMacDevices(output: string, usbType: string) {
  let report: HardwareEntry;
  try { report = JSON.parse(output); }
  catch { throw new Error('USB 外设报告不完整，请重新检测'); }
  if (!report || typeof report !== 'object' || !Array.isArray(report[usbType]) || !report[usbType].length || !Array.isArray(report.SPThunderboltDataType)) {
    throw new Error('USB 外设报告缺少硬件信息');
  }
  const devices = new Set<string>();
  const walk = (entries: unknown[], kind: 'usb' | 'thunderbolt', depth = 0) => {
    for (const value of entries) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('USB 外设报告格式无效');
      const entry = value as HardwareEntry;
      if (kind === 'usb') {
        const vendor = hardwareHex(entry, ['USBDeviceKeyVendorID', 'vendor_id']);
        const product = hardwareHex(entry, ['USBDeviceKeyProductID', 'product_id']);
        const location = hardwareHex(entry, ['USBKeyLocationID', 'location_id']);
        const reportedSerial = hardwareValue(entry, ['USBDeviceKeySerialNumber', 'serial_num']);
        const serial = reportedSerial === 'not provided' ? '' : reportedSerial;
        if (vendor || product) {
          if (!vendor || !product || (!location && !serial)) throw new Error('USB 外设身份信息不完整');
          devices.add(JSON.stringify(['usb', vendor, product, location, serial]));
        } else if (depth > 0 || !hardwareValue(entry, ['_name'])) {
          // Nested USB entries must describe devices. Do not silently remove a
          // partially reported device from the fingerprint during enumeration.
          throw new Error('USB 外设身份信息不完整');
        }
      } else if (depth > 0) {
        const uid = hardwareValue(entry, ['switch_uid_key', 'device_uid_key', 'uid']);
        if (!uid) throw new Error('Thunderbolt 外设身份信息不完整');
        devices.add(JSON.stringify(['thunderbolt', uid]));
      }
      if (entry._items !== undefined) {
        if (!Array.isArray(entry._items)) throw new Error('USB 外设报告格式无效');
        walk(entry._items, kind, depth + 1);
      }
    }
  };
  walk(report[usbType] as unknown[], 'usb');
  walk(report.SPThunderboltDataType as unknown[], 'thunderbolt');
  return [...devices].sort();
}

async function scanPeripherals() {
  let identities: string[];
  if (process.platform === 'win32') {
    identities = await windowsUsbInventory();
  } else {
    const usbType = await macUsbDataType();
    const result = await execResult('/usr/sbin/system_profiler', [usbType, 'SPThunderboltDataType', '-json'], 10000);
    if (result.code || /timed?\s*out|timeout|incomplete|failed|error/i.test(result.stderr)) throw new Error(result.error || 'USB 外设检测未完成');
    identities = normalizedMacDevices(result.stdout, usbType);
  }
  const hash = createHash('sha256').update(JSON.stringify(identities)).digest('hex');
  return `${process.platform === 'darwin' ? 'mac-usb-v3' : 'usb-v6'}:${hash}`;
}

let pendingWindowsUsbInventory: Promise<string[]> | null = null;
export async function windowsUsbInventory() {
  if (pendingWindowsUsbInventory) return pendingWindowsUsbInventory;
  const scan = exec(windowsInventoryProbe(), ['peripherals']).then(normalizedUsbDevices);
  pendingWindowsUsbInventory = scan;
  try { return await scan; }
  finally { if (pendingWindowsUsbInventory === scan) pendingWindowsUsbInventory = null; }
}

let hardwareSignals: Promise<string[]> | null = null;
export async function vmSignals() {
  // System manufacturer/model cannot change without restarting the computer.
  // Share successful identity reads; failures remain retryable after repair.
  if (!hardwareSignals) hardwareSignals = scanVmSignals().catch(error => { hardwareSignals = null; throw error; });
  return [...await hardwareSignals];
}

async function scanVmSignals() {
  const output =
    process.platform === 'win32'
      ? await exec(windowsInventoryProbe(), ['hardware'])
      : await exec('/usr/sbin/system_profiler', ['SPHardwareDataType']);
  if (!output.trim()) throw new Error('未读取到设备信息');
  if (process.platform === 'win32') {
    const rows = output.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(parseCsvLine);
    if (rows.length !== 2 || rows[0].join(',') !== 'Manufacturer,Model' || rows[1].length !== 2 || !rows[1].some(Boolean)) {
      throw new Error('设备型号信息不完整');
    }
  }
  const lower = normalized(output);
  const signals = ['vmware', 'virtualbox', 'innotek', 'parallels', 'qemu', 'hyper-v', 'kvm', 'xen', 'bhyve', 'bochs']
    .filter((needle) => lower.includes(needle));
  if (/microsoft/.test(lower) && /virtual machine/.test(lower)) signals.push('hyper-v');
  return [...new Set(signals)];
}

export async function activeWindowTitle() {
  if (process.platform === 'win32') {
    const output = await exec(windowsInventoryProbe(), ['window']);
    let value: { title?: unknown };
    try { value = JSON.parse(output); } catch { throw new Error('活动窗口检测报告无效'); }
    if (!value || typeof value.title !== 'string') throw new Error('活动窗口检测报告无效');
    return value.title.trim();
  }
  const script = 'tell application "System Events" to get name of first application process whose frontmost is true';
  return (await exec('/usr/bin/osascript', ['-e', script], 3000)).trim();
}

export async function elevationStatus(): Promise<ElevationStatus> {
  if (process.platform === 'win32') {
    return readClientWindowsElevation(windowsTokenProbe());
  }
  const elevated = typeof process.getuid === 'function' && process.getuid() === 0 || userInfo().uid === 0;
  return elevated ? 'elevated' : 'standard';
}

export async function isElevated() {
  return await elevationStatus() === 'elevated';
}

export async function securityCapabilities() {
  const [elevation, processes, fingerprint, vm, activeWindow] = await Promise.all([
    elevationStatus(),
    listProcessEntries().then(() => ({ ok: true, message: '' })).catch(error => {
      writeStartupDiagnostic(app, 'process-scan-failed', String(error));
      return { ok: false, message: '进程列表读取失败，请重试；已授权时请检查系统检测组件或安全软件拦截。' };
    }),
    peripheralsFingerprint().then(value => ({ ok: true, message: '', value })).catch(error => {
      writeStartupDiagnostic(app, 'peripheral-scan-failed', String(error));
      return { ok: false, message: '外设信息读取失败，请重新检测，并检查安全软件是否隔离了检测组件。', value: undefined };
    }),
    vmSignals().then(value => ({ ok: true, message: '', value })).catch(error => {
      writeStartupDiagnostic(app, 'vm-scan-failed', String(error));
      return { ok: false, message: '设备型号读取失败，请重新检测，并检查客户端检测组件。', value: undefined };
    }),
    activeWindowTitle().then(() => ({ ok: true, message: '' })).catch(error => {
      writeStartupDiagnostic(app, 'window-scan-failed', String(error));
      return { ok: false, message: '活动窗口读取失败，请重新检测，并检查客户端检测组件。' };
    })
  ]);

  return {
    platform: process.platform,
    elevated: elevation === 'elevated',
    elevationStatus: elevation,
    processScan: processes.ok,
    processScanMessage: processes.message,
    networkScan: ['ready', 'limited'].includes(getNetworkDomainStatus().state),
    networkDomainStatus: getNetworkDomainStatus(),
    hardwareScan: fingerprint.ok,
    hardwareScanMessage: fingerprint.message,
    peripheralsFingerprint: fingerprint.value,
    vmScan: vm.ok,
    vmScanMessage: vm.message,
    vmSignals: vm.value,
    activeWindow: activeWindow.ok,
    activeWindowMessage: activeWindow.message
  };
}

export async function peripheralSnapshot() {
  try {
    return { peripheralsFingerprint: await peripheralsFingerprint(), peripheralScanOk: true };
  } catch (error) {
    writeStartupDiagnostic(app, 'peripheral-scan-failed', String(error));
    return { peripheralScanOk: false };
  }
}

export async function securitySnapshot(allowedHosts: string[]) {
  const [processes, remotes, fingerprint, vm, activeWindow] = await Promise.allSettled([
    disallowedProcesses(),
    Promise.resolve().then(() => networkRemotes(allowedHosts)),
    peripheralsFingerprint(),
    vmSignals(),
    activeWindowTitle()
  ]);
  // A failed process/window probe must not discard a valid USB observation.
  // Unknown observations stay absent; they never become healthy empty lists.
  const value = <T>(result: PromiseSettledResult<T>) => result.status === 'fulfilled' ? result.value : undefined;
  if (fingerprint.status === 'rejected') writeStartupDiagnostic(app, 'peripheral-scan-failed', String(fingerprint.reason));
  return {
    activeWindow: value(activeWindow),
    disallowedProcesses: value(processes),
    networkRemotes: value(remotes),
    networkDomainStatus: getNetworkDomainStatus(),
    allowedNetworkRemotes: allowedHosts,
    peripheralsFingerprint: value(fingerprint),
    peripheralScanOk: fingerprint.status === 'fulfilled',
    vmSignals: value(vm)
  };
}
