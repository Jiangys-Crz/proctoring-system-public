const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

test('SMBIOS parser reads type 1 identity and rejects truncated records and unbounded strings', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-smbios-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const header = path.resolve(__dirname, '../native/windows-inventory/smbios.h');
  fs.writeFileSync(path.join(directory, 'parser.c'), `
#include <assert.h>
#include <string.h>
#include "${header}"
int main(void) {
  unsigned char data[128] = { 0, 2, 7, 0 };
  const unsigned char table[] = { 0, 4, 0, 0, 0, 0, 1, 6, 1, 0, 1, 2,
    'D','e','l','l',0,'O','p','t','i','P','l','e','x',0,0 };
  data[4] = sizeof(table); memcpy(data + 8, table, sizeof(table));
  const char *vendor, *model;
  assert(smbios_identity(data, sizeof(table) + 8, &vendor, &model));
  assert(!strcmp(vendor, "Dell") && !strcmp(model, "OptiPlex"));
  for (size_t size = 0; size < sizeof(table) + 8; size++) assert(!smbios_identity(data, size, &vendor, &model));
  data[sizeof(table) + 7] = 'x';
  assert(!smbios_identity(data, sizeof(table) + 8, &vendor, &model));
  data[sizeof(table) + 7] = 0; data[8 + 7] = 255;
  assert(!smbios_identity(data, sizeof(table) + 8, &vendor, &model));
  data[8 + 7] = 6; data[8 + 10] = 99; data[8 + 11] = 99;
  assert(!smbios_identity(data, sizeof(table) + 8, &vendor, &model));
  return 0;
}`);
  const executable = path.join(directory, 'parser');
  const compile = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', path.join(directory, 'parser.c'), '-o', executable]);
  assert.equal(compile.status, 0, compile.stderr.toString());
  const run = spawnSync(executable);
  assert.equal(run.status, 0, run.stderr.toString());
});

test('both native collectors are checked against source and import only Windows 7 system DLLs', () => {
  const directory = path.resolve(__dirname, '../native/windows-inventory');
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'artifacts.json')));
  assert.equal(digest(Buffer.concat(['inventory.c', 'smbios.h', 'buffered-output.h'].map(file => fs.readFileSync(path.join(directory, file))))), manifest.sourceHash);
  for (const [arch, machine] of [['x64', 0x8664], ['ia32', 0x14c]]) {
    const bytes = fs.readFileSync(path.join(directory, arch, 'inventory-probe.exe'));
    assert.equal(digest(bytes), manifest.binaries[arch]);
    const pe = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.readUInt16LE(pe + 4), machine);
    assert.equal(bytes.readUInt16LE(pe + 24 + 48), 6);
    assert.equal(bytes.readUInt16LE(pe + 24 + 50), 1);
    const imports = spawnSync(`${arch === 'x64' ? 'x86_64' : 'i686'}-w64-mingw32-objdump`, ['-p', path.join(directory, arch, 'inventory-probe.exe')]);
    assert.equal(imports.status, 0, imports.stderr.toString());
    const dlls = [...imports.stdout.toString().matchAll(/DLL Name: (\S+)/g)].map(match => match[1].toLowerCase()).sort();
    assert.deepEqual(dlls, ['advapi32.dll', 'kernel32.dll', 'setupapi.dll', 'shell32.dll', 'user32.dll']);
  }
});

test('collector output keeps every byte while reducing per-character pipe writes to bounded chunks', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-output-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const header = path.resolve(__dirname, '../native/windows-inventory/buffered-output.h');
  fs.writeFileSync(path.join(directory, 'output.c'), `
#include <assert.h>
#include <string.h>
static unsigned char actual[200000];
static unsigned long used, calls;
static void output_sink(const char *bytes, unsigned long size) {
  assert(used + size <= sizeof(actual));
  memcpy(actual + used, bytes, size); used += size; calls++;
}
#include "${header}"
int main(void) {
  for (unsigned long i = 0; i < sizeof(actual); i++) { char byte = (char)i; write_bytes(&byte, 1); }
  flush_output();
  assert(used == sizeof(actual));
  assert(calls == (sizeof(actual) + sizeof(output_buffer) - 1) / sizeof(output_buffer));
  for (unsigned long i = 0; i < sizeof(actual); i++) assert(actual[i] == (unsigned char)i);
  flush_output();
  assert(used == sizeof(actual));
  return 0;
}`);
  const executable = path.join(directory, 'output');
  const compile = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', path.join(directory, 'output.c'), '-o', executable]);
  assert.equal(compile.status, 0, compile.stderr.toString());
  const run = spawnSync(executable);
  assert.equal(run.status, 0, run.stderr.toString());
});
