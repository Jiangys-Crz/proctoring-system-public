import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { artifacts, digest, prepare, zipMember } from '../scripts/prepare-windows-prerequisites.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'proctor prerequisite '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('harmless fixture'), filename = 'fixture.exe';
  const source = { filename, sha256: digest(bytes), url: 'https://download.microsoft.com/fixture' };
  return { directory, bytes, filename, source, options: { directory, sources: [source], log() {} } };
}

function zip(name, contents, method = 8) {
  const bytes = method === 8 ? deflateRawSync(contents) : contents;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22), label = Buffer.from(name);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(method, 8); local.writeUInt16LE(label.length, 26);
  local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(contents.length, 22);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(method, 10); central.writeUInt16LE(label.length, 28);
  central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(contents.length, 24);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + label.length, 12); end.writeUInt32LE(local.length + label.length + bytes.length, 16);
  return Buffer.concat([local, label, bytes, central, label, end]);
}

test('offline bundling verifies existing bytes and writes the same pinned manifest without network', async t => {
  const h = await fixture(t); await writeFile(join(h.directory, h.filename), h.bytes);
  await prepare({ ...h.options, offline: true, fetcher() { assert.fail('offline must not download'); } });
  assert.equal(await readFile(join(h.directory, 'manifest.ini'), 'utf8'), `${h.filename}=${h.source.sha256}\r\n`);
});

test('offline build rejects missing or changed prerequisites and never trusts an old manifest', async t => {
  const h = await fixture(t); await writeFile(join(h.directory, 'manifest.ini'), 'forged manifest');
  const options = { ...h.options, offline: true, fetcher() { assert.fail('offline must not download'); } };
  await assert.rejects(prepare(options), /missing or invalid/);
  await writeFile(join(h.directory, h.filename), 'changed');
  await assert.rejects(prepare(options), /missing or invalid/);
  assert.equal(await readFile(join(h.directory, h.filename), 'utf8'), 'changed');
});

test('build downloads only verified bytes and leaves no partial or executable output on corrupt responses', async t => {
  const h = await fixture(t);
  await assert.rejects(prepare({ ...h.options, fetcher: async () => new Response('wrong file') }), /SHA-256 mismatch/);
  assert.deepEqual(await readdir(h.directory), []);
  await assert.rejects(prepare({ ...h.options, fetcher: async () => new Response('', { status: 503 }) }), /HTTP 503/);
  await assert.rejects(prepare({ ...h.options, fetcher: async () => new Response('x', { headers: { 'content-length': '999999999' } }) }), /size limit/);
  await prepare({ ...h.options, fetcher: async (url, options) => {
    assert.equal(url, h.source.url); assert.equal(options.redirect, 'error'); return new Response(h.bytes);
  } });
  assert.deepEqual(await readFile(join(h.directory, h.filename)), h.bytes);
  assert.deepEqual((await readdir(h.directory)).sort(), ['fixture.exe', 'manifest.ini']);
});

test('WMF extraction verifies both archive and exact named payload, never executes its scripts', async t => {
  const h = await fixture(t), member = 'Official.msu', archive = zip(member, h.bytes);
  const source = { ...h.source, member, archiveSha256: digest(archive) };
  await prepare({ ...h.options, sources: [source], fetcher: async () => new Response(archive) });
  assert.deepEqual(await readFile(join(h.directory, h.filename)), h.bytes);
  const wrongPayload = zip(member, Buffer.from('altered'));
  await rm(join(h.directory, h.filename));
  await assert.rejects(prepare({ ...h.options, sources: [{ ...source, archiveSha256: digest(wrongPayload) }], fetcher: async () => new Response(wrongPayload) }), /payload SHA-256 mismatch/);
});

test('ZIP extraction rejects wrong names, malformed and truncated containers', () => {
  const contents = Buffer.from('safe');
  for (const method of [0, 8]) assert.deepEqual(zipMember(zip('a.msu', contents, method), 'a.msu'), contents);
  assert.throws(() => zipMember(zip('../a.msu', contents), 'a.msu'), /does not contain/);
  assert.throws(() => zipMember(Buffer.from('not zip'), 'a.msu'), /ZIP/);
  assert.throws(() => zipMember(zip('a.msu', contents).subarray(0, -1), 'a.msu'), /ZIP/);
});

test('all production prerequisites are pinned HTTPS Microsoft downloads with fixed basenames', () => {
  assert.deepEqual(artifacts.map(item => item.filename), ['dotnet452.exe', 'wmf51-x86.msu', 'wmf51-x64.msu']);
  for (const item of artifacts) {
    assert.equal(new URL(item.url).protocol, 'https:'); assert.equal(new URL(item.url).hostname, 'download.microsoft.com');
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    if (item.member) assert.match(item.archiveSha256, /^[a-f0-9]{64}$/);
  }
});
