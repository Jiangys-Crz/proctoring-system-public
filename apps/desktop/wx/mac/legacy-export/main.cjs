'use strict';

const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const stageName = '--proctor-export';
const draftMode = process.argv.includes('--proctor-export-drafts');
const argument = process.argv.indexOf(draftMode ? '--proctor-export-drafts' : stageName);
const renderer = path.join(__dirname, 'export.html');
const rendererUrl = pathToFileURL(renderer).href;
const bytesPerChunk = 256 * 1024;
const draftSnapshotMaxBytes = 64n * 1024n * 1024n;
const draftSnapshotMaxFiles = 256;

function directory(location) {
  const info = fs.lstatSync(location, { throwIfNoEntry: false });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('legacy directory format');
  return true;
}

function sourceFile(location) {
  const info = fs.lstatSync(location, { throwIfNoEntry: false, bigint: true });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('legacy file format');
  return info;
}

function copyLegacyData(source, snapshot) {
  const visited = new Map();
  function copyFile(from, to, info = sourceFile(from)) {
    if (!info) return false;
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    // APFS usually copies these queued video blobs without duplicating all
    // data blocks. Fallback is a normal copy when clonefile isn't available.
    fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
    fs.chmodSync(to, 0o600);
    visited.set(from, info);
    return true;
  }
  function copyDraftStorage(from, to) {
    const contents = fs.readdirSync(from).sort();
    if (!contents.includes('CURRENT')) return false;
    const files = contents.filter(name => /^(?:CURRENT|MANIFEST-\d+|\d+\.(?:ldb|log|sst))$/.test(name));
    if (files.length > draftSnapshotMaxFiles) throw new Error('legacy draft snapshot file count');
    let bytes = 0n;
    const entries = files.map(name => {
      const source = path.join(from, name);
      const info = sourceFile(source);
      if (!info) throw new Error('legacy draft snapshot changed');
      if (name === 'CURRENT' && info.size > 64n) throw new Error('legacy draft manifest pointer');
      bytes += info.size;
      if (bytes > draftSnapshotMaxBytes) throw new Error('legacy draft snapshot size');
      return { source, target: path.join(to, name), info };
    });
    visited.set(from, contents);
    for (const { source, target, info } of entries) copyFile(source, target, info);
    const manifest = fs.readFileSync(path.join(to, 'CURRENT'), 'utf8');
    if (!/^MANIFEST-\d+\n$/.test(manifest) || !files.includes(manifest.slice(0, -1))) {
      throw new Error('legacy draft manifest pointer');
    }
    return true;
  }
  function copyDirectory(from, to) {
    if (!directory(from)) return false;
    const contents = fs.readdirSync(from).sort();
    visited.set(from, contents);
    fs.mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const name of contents) {
      const item = path.join(from, name);
      const destination = path.join(to, name);
      if (fs.lstatSync(item).isDirectory()) copyDirectory(item, destination);
      // Chromium takes fresh LevelDB locks in the staging profile.
      else if (name !== 'LOCK') copyFile(item, destination);
    }
    return true;
  }
  function copyCookies(from, to) {
    if (!directory(from)) return null;
    for (const filename of ['Network/Cookies', 'Cookies']) {
      const origin = path.join(from, filename);
      if (filename.startsWith('Network/') && !directory(path.dirname(origin))) continue;
      const target = path.join(to, filename);
      if (!copyFile(origin, target)) continue;
      for (const suffix of ['-wal', '-journal']) {
        if (!copyFile(origin + suffix, target + suffix)) visited.set(origin + suffix, null);
      }
      return target;
    }
    return null;
  }

  let result;
  if (draftMode) {
    const parts = ['Partitions', 'proctor-oj', 'Local Storage', 'leveldb'];
    let from = source;
    const found = parts.every(part => directory(from = path.join(from, part)));
    result = { hasDrafts: found && copyDraftStorage(from, path.join(snapshot, ...parts)) };
  } else {
    const localStorage = path.join(source, 'Local Storage');
    if (directory(localStorage)) {
      copyDirectory(path.join(localStorage, 'leveldb'), path.join(snapshot, 'Local Storage', 'leveldb'));
    }
    const indexed = 'file__0.indexeddb';
    const index = path.join(source, 'IndexedDB');
    if (directory(index)) {
      for (const suffix of ['.leveldb', '.blob']) {
        copyDirectory(path.join(index, indexed + suffix), path.join(snapshot, 'IndexedDB', indexed + suffix));
      }
    }
    const serviceWorker = path.join(source, 'Service Worker');
    const hasCache = directory(serviceWorker) && copyDirectory(path.join(serviceWorker, 'CacheStorage'),
      path.join(snapshot, 'Service Worker', 'CacheStorage'));
    const client = copyCookies(source, snapshot);
    const oldPartitions = path.join(source, 'Partitions');
    const contest = directory(oldPartitions) ? copyCookies(path.join(oldPartitions, 'proctor-oj'),
      path.join(snapshot, 'Partitions', 'proctor-oj')) : null;
    result = { client, contest, hasCache };
  }
  // An Electron process started outside the supported install flow could be
  // writing at the same time. Reject an inconsistent snapshot before opening it.
  for (const [from, original] of visited) {
    if (Array.isArray(original)) {
      if (!directory(from) || JSON.stringify(fs.readdirSync(from).sort()) !== JSON.stringify(original)) {
        throw new Error('legacy storage changed while copying');
      }
    } else {
      const current = sourceFile(from);
      if (Boolean(current) !== Boolean(original) || (current && ['mtimeNs', 'ctimeNs', 'ino', 'dev', 'size']
        .some(key => current[key] !== original[key]))) throw new Error('legacy storage changed while copying');
    }
  }
  return result;
}

function encryptedCookieKeys(sqlite) {
  if (!sqlite) return [];
  // Electron reads the snapshot and asks macOS Keychain for the original
  // encryption key. Query identities only so a keychain failure stays visible.
  const expires = String(BigInt(Date.now() + 60_000) * 1000n + 11644473600000000n);
  const rows = execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', sqlite,
    'SELECT host_key AS domain, name, path FROM cookies WHERE length(encrypted_value)>0 AND has_expires=1 AND expires_utc>' + expires],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return rows ? JSON.parse(rows) : [];
}

function isolated(session, address = rendererUrl) {
  session.webRequest.onBeforeRequest((details, complete) => {
    complete({ cancel: details.url !== address || details.resourceType !== 'mainFrame' });
  });
  session.setPermissionRequestHandler((_contents, _permission, complete) => complete(false));
  session.setPermissionCheckHandler(() => false);
}

function sameOrigin(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== value) throw new Error('legacy draft origin');
  return url;
}

async function runDrafts(stage, sources, origin, backend, sessionId) {
  const site = sameOrigin(origin);
  sameOrigin(backend);
  if (!/^[A-Za-z0-9_-]{1,191}$/.test(sessionId)) throw new Error('legacy draft session');
  let drafts = {};
  if (sources.hasDrafts) {
    const target = new URL('/.proctor-local-storage-export', site).href;
    const profile = session.fromPartition('persist:proctor-oj', { cache: false });
    isolated(session.defaultSession, '');
    isolated(profile, target);
    // Serve one inert document locally at the exact origin owning the old storage.
    // No resource, cookie database, service worker, or webpage script is loaded.
    const intercepted = profile.protocol.interceptStringProtocol(site.protocol.slice(0, -1), (request, complete) => {
      if (request.url !== target || request.method !== 'GET') { complete({ error: -20 }); return; }
      complete({ mimeType: 'text/html', charset: 'utf-8',
        data: '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title></title>' });
    });
    if (!intercepted) throw new Error('legacy storage interception');
    const browser = new BrowserWindow({ show: false, skipTaskbar: true,
      webPreferences: { session: profile, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    browser.webContents.on('will-navigate', event => event.preventDefault());
    try {
      await browser.loadURL(target);
      const args = JSON.stringify([origin, backend, sessionId]);
      drafts = await browser.webContents.executeJavaScript(`(([origin, backend, sessionId]) => {
        const selected = Object.create(null);
        if (location.origin !== origin || localStorage.getItem('proctor.contest.sessionId') !== sessionId) return selected;
        const oldApi = new URL(localStorage.getItem('proctor.contest.sessionApiBase'));
        if (oldApi.origin !== backend || oldApi.pathname !== '/' || oldApi.username || oldApi.password || oldApi.search || oldApi.hash) return selected;
        const prefixes = ['proctor.contest.code.', 'proctor.contest.objective.'].map(kind => kind + sessionId + '.');
        let bytes = 2;
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          const prefix = prefixes.find(value => key?.startsWith(value));
          if (!prefix || !/^\\d{1,16}$/.test(key.slice(prefix.length))) continue;
          const value = localStorage.getItem(key);
          if (typeof value !== 'string' || value.length > 512 * 1024) continue;
          const size = new TextEncoder().encode(JSON.stringify(key) + ':' + JSON.stringify(value)).byteLength + 1;
          if (bytes + size > 2 * 1024 * 1024) continue;
          bytes += size;
          selected[key] = value;
        }
        return selected;
      })(${args})`);
    } finally { browser.destroy(); }
  }
  const buffer = Buffer.from(JSON.stringify(drafts));
  if (buffer.length > 2 * 1024 * 1024) throw new Error('legacy draft size');
  fs.writeFileSync(path.join(stage, 'drafts.json'), buffer, { flag: 'wx', mode: 0o600 });
}

async function exportCookies(profile, sqlite) {
  if (!sqlite) return { items: [], status: 'complete' };
  try {
    const identities = encryptedCookieKeys(sqlite);
    const items = (await profile.cookies.get({})).map(cookie => ({
      name: cookie.name, value: cookie.value, domain: cookie.domain, hostOnly: cookie.hostOnly, path: cookie.path,
      secure: cookie.secure, httpOnly: cookie.httpOnly, session: cookie.session, sameSite: cookie.sameSite,
      ...(Number.isFinite(cookie.expirationDate) ? { expirationDate: cookie.expirationDate } : {})
    }));
    const known = new Set(items.map(cookie => JSON.stringify([cookie.domain, cookie.name, cookie.path])));
    const complete = identities.every(cookie => known.has(JSON.stringify([cookie.domain, cookie.name, cookie.path])));
    return { items, status: complete ? 'complete' : 'unavailable' };
  } catch {
    return { items: [], status: 'unavailable' };
  }
}

async function exportBlob(window, stage, filename, size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid legacy blob length');
  const output = fs.openSync(path.join(stage, filename), 'wx', 0o600);
  try {
    for (let offset = 0; offset < size;) {
      const data = await window.webContents.executeJavaScript(`window.__proctorLegacyRead.chunk(${offset})`);
      if (typeof data !== 'string' || data.length > Math.ceil(bytesPerChunk / 3) * 4) throw new Error('invalid legacy blob');
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length !== Math.min(size - offset, bytesPerChunk)) throw new Error('incomplete legacy blob');
      let written = 0;
      while (written < bytes.length) {
        const count = fs.writeSync(output, bytes, written, bytes.length - written);
        if (count <= 0) throw new Error('legacy blob write failed');
        written += count;
      }
      offset += bytes.length;
    }
    fs.fsyncSync(output);
  } finally {
    fs.closeSync(output);
  }
}

async function run(stage, sources) {
  const { defaultSession } = session;
  const contest = session.fromPartition('persist:proctor-oj', { cache: false });
  isolated(defaultSession);
  isolated(contest);

  const browser = new BrowserWindow({
    show: false, skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  browser.webContents.on('will-navigate', event => event.preventDefault());
  const manifest = { version: 1, preferences: {}, records: [], cookies: { client: [], contest: [] },
    preferenceStatus: 'complete', evidenceStatus: 'complete', cookieStatus: {}, cache: [], cacheStatus: 'complete' };
  try {
    await browser.loadFile(renderer);
    await browser.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'read.js'), 'utf8'));
    try { manifest.preferences = await browser.webContents.executeJavaScript('window.__proctorLegacyRead.preferences()'); }
    catch { manifest.preferenceStatus = 'unavailable'; }
    for (const store of ['uploads', 'alerts']) {
      try {
        let after = null;
        for (;;) {
          const args = [store, after].map(value => JSON.stringify(value)).join(',');
          const { entry, skipped } = await browser.webContents.executeJavaScript(`window.__proctorLegacyRead.nextRecord(${args})`);
          if (skipped) manifest.evidenceStatus = 'unavailable';
          if (!entry) break;
          const output = { store, ...entry };
          after = entry.record.id;
          if (store === 'uploads') {
            output.blob = `${manifest.records.length}.blob`;
            if (entry.size > 512 * 1024 * 1024) {
              manifest.evidenceStatus = 'unavailable';
              continue;
            }
            try { await exportBlob(browser, stage, output.blob, entry.size); }
            catch {
              manifest.evidenceStatus = 'unavailable';
              fs.rmSync(path.join(stage, output.blob), { force: true });
              continue;
            }
          }
          manifest.records.push(output);
        }
      } catch { manifest.evidenceStatus = 'unavailable'; }
    }
    if (sources.hasCache) {
      try {
        for (;;) {
          const entry = await browser.webContents.executeJavaScript('window.__proctorLegacyRead.nextCache()');
          if (!entry) break;
          const blob = `cache-${manifest.cache.length}.blob`;
          await exportBlob(browser, stage, blob, entry.size);
          manifest.cache.push({ ...entry, blob });
        }
      } catch {
        manifest.cacheStatus = 'unavailable';
      }
    }
  } finally {
    browser.destroy();
  }
  for (const [partition, profile] of [['client', defaultSession], ['contest', contest]]) {
    const { items, status } = await exportCookies(profile, sources[partition]);
    manifest.cookies[partition] = items;
    manifest.cookieStatus[partition] = status;
  }

  const temporary = path.join(stage, '.manifest.tmp');
  const file = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(file, JSON.stringify(manifest));
    fs.fsyncSync(file);
  } finally {
    fs.closeSync(file);
  }
  fs.renameSync(temporary, path.join(stage, 'manifest.json'));
}

let snapshot;
function exit(status) {
  if (snapshot) {
    try { fs.rmSync(snapshot, { recursive: true, force: true }); } catch { /* Native owner cleans the stage. */ }
  }
  app.exit(status);
}

try {
  if (process.platform !== 'darwin' || process.versions.electron !== '22.3.27' ||
      argument < 0 || process.argv.length !== argument + (draftMode ? 6 : 3)) throw new Error('arguments');
  const source = fs.realpathSync(process.argv[argument + 1]);
  const stage = fs.realpathSync(process.argv[argument + 2]);
  const applicationSupport = fs.realpathSync(app.getPath('appData'));
  const allowed = [path.join(applicationSupport, '@cwnupaa', 'proctor-desktop'),
    path.join(applicationSupport, '程序设计算法协会监考客户端')];
  if (!allowed.includes(source) || !directory(source) || !directory(stage) ||
      fs.statSync(stage).uid !== process.getuid() || (fs.statSync(stage).mode & 0o077) || fs.readdirSync(stage).length) {
    throw new Error('profile or staging location');
  }
  snapshot = fs.mkdtempSync(path.join(stage, 'chromium-'));
  app.setPath('userData', snapshot);
  app.setPath('sessionData', snapshot);
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('disable-http-cache');
  app.commandLine.appendSwitch('disable-pings');

  const sources = copyLegacyData(source, snapshot);
  void app.whenReady().then(async () => {
    app.dock.hide();
    if (draftMode) await runDrafts(stage, sources, ...process.argv.slice(argument + 3));
    else await run(stage, sources);
    exit(0);
  }).catch(() => exit(1));
} catch {
  // Paths, cookie values and queued recording data are never emitted to stdout
  // or stderr by this exporter. Exit status is enough for the caller to retry.
  exit(1);
}
