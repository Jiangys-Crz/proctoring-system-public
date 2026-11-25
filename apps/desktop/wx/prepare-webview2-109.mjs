import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const version = '109.0.1518.140';
const catalog = 'https://catalog.s.download.windowsupdate.com/c/msdownload/update/software/updt/2023/09/';
const packages = {
  x64: {
    update: '322eb0af-cdbc-4a17-a8ca-f0ace4d4adc8',
    file: 'microsoftedgestandaloneinstallerx64_1c890b4b8dd6b7c93da98ebdc08ecdc5e30e50cb.exe',
    sha256: 'eac95c8095ec5f9971eade9827d8fb67fd251f5c16e702b5312d31067e39119b',
    size: 150552536,
    machine: 0x8664,
    files: 201,
  },
  x86: {
    update: 'cd7a382c-62c6-46c0-8098-0d50a7953b61',
    file: 'microsoftedgestandaloneinstallerx86_179f59bc54d73843d9288a9fd5609de0e507b911.exe',
    sha256: '60b22c71128f10abc5e92dd8fed90ff6ca55b8382ba01e48d87faf1664746a31',
    size: 138366936,
    machine: 0x014c,
    files: 200,
  },
  arm64: {
    update: 'b66cfe87-928e-4647-afe2-36254a55f53e',
    file: 'microsoftedgestandaloneinstallerarm64_e56fc438c0d28cab886126d2e62052d9506380d4.exe',
    sha256: 'e44f73f970cb61843c766dd2b3e2d717baec4439e401f991e47558b2883874a9',
    size: 148350920,
    machine: 0xaa64,
    files: 200,
  },
};

function sevenZip(requested) {
  for (const name of requested ? [requested] : ['7zz', '7z']) {
    const result = spawnSync(name, ['i'], { stdio: 'ignore', windowsHide: true });
    if (result.status === 0) return name;
  }
  throw new Error('找不到 7-Zip。请安装 7z 或 7zz，或传入 7-Zip 可执行文件的完整路径。');
}

function extract(tool, archive, destination, filters = [], nested = false) {
  const args = ['x', '-y', '-bb0', '-o' + destination, ...(nested ? ['-t7z'] : []), archive, ...filters];
  const result = spawnSync(tool, args, { encoding: 'utf8', windowsHide: true });
  const output = (result.stdout || '') + (result.stderr || '');
  // 7-Zip can report the signed executable trailer after the inner 7z stream.
  // Extraction will be followed by required-file, machine and file-count checks.
  if (result.status === 0 || (nested && result.status === 1 &&
      /There are data after the end of archive/.test(output) && /Everything is Ok/.test(output) &&
      !/\bERROR\b/i.test(output))) return;
  throw result.error || new Error('运行时解包失败\n' + output);
}

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadPackage(url, filename, size) {
  const partSize = 20 * 1024 * 1024;
  const offsets = Array.from({ length: Math.ceil(size / partSize) }, (_, index) => index * partSize);
  const request = offset => fetch(url, {
    headers: { range: `bytes=${offset}-${Math.min(size, offset + partSize) - 1}`, 'accept-encoding': 'identity' },
    redirect: 'error',
    signal: AbortSignal.timeout(1_800_000),
  });
  const file = await open(filename, 'wx');
  async function writePart(response, start, end) {
    if ((response.status !== 206 && !(response.status === 200 && start === 0 && end === size)) || !response.body ||
        (response.status === 206 && response.headers.get('content-range') !== `bytes ${start}-${end - 1}/${size}`)) {
      await response.body?.cancel();
      throw new Error('Microsoft Update Catalog HTTP 下载区段无效，状态 ' + response.status);
    }
    let offset = start;
    for await (const chunk of response.body) {
      if (offset + chunk.length > end) throw new Error('Microsoft Update Catalog 下载文件超过预期大小');
      let written = 0;
      while (written < chunk.length) {
        const result = await file.write(chunk, written, chunk.length - written, offset);
        if (!result.bytesWritten) throw new Error('无法写入 Microsoft Update Catalog 下载文件');
        written += result.bytesWritten;
        offset += result.bytesWritten;
      }
    }
    if (offset !== end) throw new Error('Microsoft Update Catalog 下载文件不完整');
  }
  try {
    const first = await request(0);
    if (first.status !== 206) {
      await writePart(first, 0, size);
      return;
    }
    const responses = await Promise.allSettled(offsets.map(async start =>
      writePart(start === 0 ? first : await request(start), start, Math.min(size, start + partSize))));
    for (const response of responses) {
      if (response.status === 'rejected') throw response.reason;
    }
  } finally {
    await file.close();
  }
}

async function verifyMachine(file, expected) {
  const handle = await open(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.readUInt16LE(0) !== 0x5a4d) {
      throw new Error('运行时 DOS 头无效：' + file);
    }
    const pe = Buffer.alloc(6);
    if ((await handle.read(pe, 0, pe.length, dos.readUInt32LE(60))).bytesRead !== pe.length ||
        pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== expected) {
      throw new Error('运行时 PE 架构不匹配：' + file);
    }
  } finally {
    await handle.close();
  }
}

function verifySignature(file) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$s = Get-AuthenticodeSignature -LiteralPath $env:PROCTOR_SIGNATURE_FILE; " +
    "if ($s.Status -ne 'Valid' -or $s.SignerCertificate.GetNameInfo('SimpleName', $false) -ne 'Microsoft Corporation') { exit 1 }"],
  { env: { ...process.env, PROCTOR_SIGNATURE_FILE: file }, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw result.error || new Error('Microsoft Authenticode 签名校验失败：' + file);
}

async function prepare(architecture, spec, tool, folder, target, checkSignatures, catalogDirectory) {
  const download = path.join(catalogDirectory || folder, spec.file);
  const source = catalog + spec.file;
  if (!catalogDirectory) await downloadPackage(source, download, spec.size);
  if ((await stat(download)).size !== spec.size || await sha256(download) !== spec.sha256) {
    throw new Error('Microsoft Update Catalog 文件 SHA-256 或大小不匹配：' + spec.file);
  }
  if (checkSignatures) verifySignature(download);

  const installer = 'MicrosoftEdge_' + architecture.toUpperCase() + '_' + version +
    '.exe.{0D50BFEC-CD6A-4F9A-964C-C7416E3ACB10}';
  const inner = path.join(folder, 'runtime-installer.exe');
  extract(tool, download, folder, [installer]);
  await rename(path.join(folder, installer), inner);
  if (checkSignatures) verifySignature(inner);
  extract(tool, inner, folder, ['MSEDGE.7z'], true);
  extract(tool, path.join(folder, 'MSEDGE.7z'), folder, ['Chrome-bin/' + version + '/*']);
  const root = path.join(folder, 'Chrome-bin', version);
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  if (files.some(file => !file.isDirectory() && !file.isFile()) || files.filter(file => file.isFile()).length !== spec.files) {
    throw new Error('运行时文件目录不完整：' + architecture);
  }
  const binaries = ['msedgewebview2.exe', 'msedge.dll', 'EBWebView/' + architecture + '/EmbeddedBrowserWebView.dll'];
  for (const binary of binaries) {
    const file = path.join(root, binary);
    await verifyMachine(file, spec.machine);
    if (checkSignatures) verifySignature(file);
  }
  for (const file of ['icudtl.dat', 'resources.pak', 'Locales/en-US.pak', version + '.manifest']) {
    if (!(await stat(path.join(root, file))).isFile()) throw new Error('运行时资源缺失：' + file);
  }
  await rename(root, path.join(target, architecture));
  return { catalogUpdateId: spec.update, source, installerSha256: spec.sha256, files: spec.files };
}

const args = process.argv.slice(2);
const signatureIndex = args.indexOf('--verify-signatures');
const checkSignatures = signatureIndex !== -1;
if (checkSignatures) args.splice(signatureIndex, 1);
const architectureIndex = args.indexOf('--arch');
const architecture = architectureIndex === -1 ? undefined : args[architectureIndex + 1];
const selected = architectureIndex === -1 ? ['x64', 'x86'] : architecture === 'all' ? Object.keys(packages) : [architecture];
if (architectureIndex !== -1) args.splice(architectureIndex, 2);
const catalogIndex = args.indexOf('--catalog-directory');
let catalogDirectory;
if (catalogIndex !== -1 && args[catalogIndex + 1] && !args[catalogIndex + 1].startsWith('--')) {
  catalogDirectory = path.resolve(args[catalogIndex + 1]);
  args.splice(catalogIndex, 2);
}
if (selected.some(name => !Object.hasOwn(packages, name)) || args.length > 2 || args.some(arg => arg.startsWith('--')) ||
    (checkSignatures && process.platform !== 'win32')) {
  throw new Error('用法：node prepare-webview2-109.mjs [输出目录] [7-Zip 可执行文件] [--arch x64|x86|arm64|all] [--catalog-directory 缓存目录] [--verify-signatures，仅 Windows]');
}
const destination = path.resolve(args[0] || path.join('tmp', 'webview2-' + version + (architecture && architecture !== 'all' ? '-' + architecture : '')));
const exists = await access(destination).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
if (exists) throw new Error('输出目录已存在：' + destination);
const tool = sevenZip(args[1]);
await mkdir(path.dirname(destination), { recursive: true });
const staging = await mkdtemp(path.join(path.dirname(destination), '.webview2-109-'));
try {
  const output = path.join(staging, 'runtime');
  await mkdir(output);
  const architectures = await Promise.allSettled(selected.map(async architecture => {
    const working = path.join(staging, architecture);
    await mkdir(working);
    return [architecture, await prepare(architecture, packages[architecture], tool, working, output, checkSignatures, catalogDirectory)];
  }));
  for (const result of architectures) {
    if (result.status === 'rejected') throw result.reason;
  }
  const provenance = { version, sourceType: 'Microsoft Update Catalog signed runtime payload', authenticodeChecked: checkSignatures,
    architectures: Object.fromEntries(architectures.map(result => result.value)) };
  await writeFile(path.join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' });
  await rename(output, destination);
  console.log(destination);
} finally {
  await rm(staging, { recursive: true, force: true });
}
