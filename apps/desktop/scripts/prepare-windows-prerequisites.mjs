import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

// Official Microsoft downloads, retrieved and Authenticode-verified on 2026-10-29.
// Pin both ZIP containers and the installed payloads; never execute ZIP scripts.
// Sources: https://www.microsoft.com/en-us/download/details.aspx?id=54616
// https://dotnet.microsoft.com/en-us/download/dotnet-framework/net452
export const artifacts = [
  {
    filename: 'dotnet452.exe',
    url: 'https://download.microsoft.com/download/E/2/1/E21644B5-2DF2-47C2-91BD-63C560427900/NDP452-KB2901907-x86-x64-AllOS-ENU.exe',
    sha256: '6c2c589132e830a185c5f40f82042bee3022e721a216680bd9b3995ba86f3781',
  },
  {
    filename: 'wmf51-x86.msu',
    url: 'https://download.microsoft.com/download/6/f/5/6f5ff66c-6775-42b0-86c4-47d41f2da187/Win7-KB3191566-x86.zip',
    archiveSha256: 'eb7e2c4ce2c6cb24206474a6cb8610d9f4bd3a9301f1cd8963b4ff64e529f563',
    member: 'Win7-KB3191566-x86.msu',
    sha256: '4575c47bedf732c7a215a5dd9e184ac2f06f10c0f23fcef38eec96b0ff3bd121',
  },
  {
    filename: 'wmf51-x64.msu',
    url: 'https://download.microsoft.com/download/6/f/5/6f5ff66c-6775-42b0-86c4-47d41f2da187/Win7AndW2K8R2-KB3191566-x64.zip',
    archiveSha256: 'f383c34aa65332662a17d95409a2ddedadceda74427e35d05024cd0a6a2fa647',
    member: 'Win7AndW2K8R2-KB3191566-x64.msu',
    sha256: 'c51abfc65dff5f6858c0b9f6420caa0c166df7a6d8b484f8a3c68ea99f0032b0',
  },
];
// KB2999226 for Windows 7 SP1, Windows 8 and Windows 8.1. The Microsoft Download Center MSUs and their
// timestamped SHA-256 Authenticode signatures were checked on 2026-11-15.
export const universalCrtArtifacts = [
  {
    filename: 'ucrt-x86.msu',
    url: 'https://download.microsoft.com/download/4/F/E/4FE73868-5EDD-4B47-8B33-CE1BB7B2B16A/Windows6.1-KB2999226-x86.msu',
    sha256: '909e76c81ef0eb176144b253ddffe7a8fdfacebfaa15e97def003d2262fbf084',
  },
  {
    filename: 'ucrt-x64.msu',
    url: 'https://download.microsoft.com/download/1/1/5/11565A9A-EA09-4F0A-A57E-520D5D138140/Windows6.1-KB2999226-x64.msu',
    sha256: '43234d2986ca9b0de75d5183977964d161a8395c3396279ddfc9b20698e5bc34',
  },
  {
    filename: 'ucrt-win8-x86.msu',
    url: 'https://download.microsoft.com/download/1/E/8/1E8AFE90-5217-464D-9292-7D0B95A56CE4/Windows8-RT-KB2999226-x86.msu',
    sha256: '0f36750fbb06fee23131f68b4d0943841eed24730ec1d5d77dedc41d359be88d',
  },
  {
    filename: 'ucrt-win8-x64.msu',
    url: 'https://download.microsoft.com/download/A/C/1/AC15393F-A6E6-469B-B222-C44B3BB6ECCC/Windows8-RT-KB2999226-x64.msu',
    sha256: '50cae25da33fa950222d1a803e42567291eb7feb087fa119b1c97fe9d41cd9f8',
  },
  {
    filename: 'ucrt-win81-x86.msu',
    url: 'https://download.microsoft.com/download/E/4/6/E4694323-8290-4A08-82DB-81F2EB9452C2/Windows8.1-KB2999226-x86.msu',
    sha256: 'b83251219c5390536b02bebaf5e43a6f13381ce1db43e76483bce07c4bcf877b',
  },
  {
    filename: 'ucrt-win81-x64.msu',
    url: 'https://download.microsoft.com/download/9/6/F/96FD0525-3DDF-423D-8845-5F92F4A6883E/Windows8.1-KB2999226-x64.msu',
    sha256: '9f707096c7d279ed4bc2a40ba695efac69c20406e0ca97e2b3e08443c6381d15',
  },
];
const maxBytes = 150 * 1024 * 1024;
const defaultDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../build/windows-prerequisites');
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Read one known member in Microsoft's small, non-ZIP64 archives. No archive
// path becomes a filesystem path, so extraction cannot overwrite other files.
export function zipMember(archive, expectedName) {
  let end = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65557); i--) {
    if (archive.readUInt32LE(i) === 0x06054b50 && i + 22 + archive.readUInt16LE(i + 20) === archive.length) { end = i; break; }
  }
  if (end < 0 || archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6)) throw Error('Unsupported prerequisite ZIP');
  const count = archive.readUInt16LE(end + 10);
  const centralEnd = archive.readUInt32LE(end + 16) + archive.readUInt32LE(end + 12);
  if (centralEnd > end) throw Error('Invalid prerequisite ZIP directory');
  let cursor = archive.readUInt32LE(end + 16), result;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > centralEnd || archive.readUInt32LE(cursor) !== 0x02014b50) throw Error('Invalid prerequisite ZIP entry');
    const flags = archive.readUInt16LE(cursor + 8), method = archive.readUInt16LE(cursor + 10);
    const compressed = archive.readUInt32LE(cursor + 20), expanded = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const next = cursor + 46 + nameLength + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
    if (next > centralEnd) throw Error('Truncated prerequisite ZIP entry');
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name === expectedName) {
      if (result || flags & 1 || ![0, 8].includes(method) || expanded > maxBytes) throw Error('Unsupported prerequisite ZIP payload');
      const offset = archive.readUInt32LE(cursor + 42);
      if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== 0x04034b50) throw Error('Invalid prerequisite ZIP payload');
      const start = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
      if (start + compressed > archive.readUInt32LE(end + 16)) throw Error('Truncated prerequisite ZIP payload');
      const bytes = archive.subarray(start, start + compressed);
      result = method === 8 ? inflateRawSync(bytes, { maxOutputLength: maxBytes }) : bytes;
      if (result.length !== expanded) throw Error('Invalid prerequisite ZIP size');
    }
    cursor = next;
  }
  if (!result) throw Error(`Official prerequisite ZIP does not contain ${expectedName}`);
  return result;
}

async function download(url, fetcher) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw Error(`Prerequisite download failed: HTTP ${response.status}`);
  if (!response.body) throw Error('Empty prerequisite download');
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel(); throw Error('Prerequisite download exceeds the size limit');
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw Error('Prerequisite download exceeds the size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function atomicWrite(filename, bytes) {
  const staging = `${filename}.${randomUUID()}.tmp`;
  try { await writeFile(staging, bytes, { flag: 'wx' }); await rename(staging, filename); }
  finally { await rm(staging, { force: true }); }
}

export async function prepare({ directory = defaultDirectory, offline = false, withUniversalCrt = false, fetcher = fetch,
  sources = withUniversalCrt ? [...artifacts, ...universalCrtArtifacts] : artifacts, log = console.log } = {}) {
  await mkdir(directory, { recursive: true });
  for (const artifact of sources) {
    if (!/^[a-z0-9.-]+$/.test(artifact.filename) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw Error('Invalid prerequisite manifest');
    const destination = join(directory, artifact.filename);
    let valid = false;
    try { valid = digest(await readFile(destination)) === artifact.sha256; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (valid) { log(`Verified Windows prerequisite: ${artifact.filename}`); continue; }
    if (offline) throw Error(`Offline prerequisite missing or invalid: ${destination}. Run prepare:windows-prerequisites online first, or copy the verified build/windows-prerequisites directory.`);
    log(`Downloading official Microsoft prerequisite: ${artifact.filename}`);
    let bytes = await download(artifact.url, fetcher);
    if (digest(bytes) !== (artifact.archiveSha256 || artifact.sha256)) throw Error(`Microsoft download SHA-256 mismatch: ${artifact.filename}`);
    if (artifact.member) bytes = zipMember(bytes, artifact.member);
    if (digest(bytes) !== artifact.sha256) throw Error(`Prerequisite payload SHA-256 mismatch: ${artifact.filename}`);
    await atomicWrite(destination, bytes);
  }
  await atomicWrite(join(directory, withUniversalCrt ? 'manifest-ucrt.ini' : 'manifest.ini'),
    sources.map(item => `${item.filename}=${item.sha256}\r\n`).join(''));
  log('Windows prerequisite bundle is ready; no system components were installed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).some(arg => !['--offline', '--with-ucrt'].includes(arg))) {
    throw Error('Usage: node prepare-windows-prerequisites.mjs [--offline] [--with-ucrt]');
  }
  await prepare({ offline: process.argv.includes('--offline') || process.env.PROCTOR_PREREQUISITES_OFFLINE === '1',
    withUniversalCrt: process.argv.includes('--with-ucrt') });
}
