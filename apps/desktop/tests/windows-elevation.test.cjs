const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readWindowsElevation, createWindowsElevationCheck } = require('../dist/main/windows-elevation');

const probe = 'C:\\自定义安装目录\\监考客户端\\resources\\security\\token-probe.exe';
async function result(error) {
  return readWindowsElevation(probe, (file, args, options, callback) => {
    assert.equal(file, probe);
    assert.deepEqual(args, [String(process.pid)]);
    assert.equal(options.windowsHide, true);
    assert.ok(options.timeout > 0);
    callback(error, '', '');
  });
}
test('native token probe distinguishes real elevation, standard tokens and failed checks', async () => {
  assert.equal(await result(null), 'elevated');
  assert.equal(await result(Object.assign(new Error('standard token'), { code: 10 })), 'standard');
  for (const code of [20, 21, 1, 'ENOENT', 'EACCES', '10', undefined]) {
    assert.equal(await result(Object.assign(new Error('probe failed'), { code })), 'unavailable');
  }
  for (const extra of [{ killed: true }, { signal: 'SIGTERM' }]) {
    assert.equal(await result(Object.assign(new Error('probe interrupted'), { code: 10, ...extra })), 'unavailable');
  }
});

test('verified administrator status survives later helper failures in the same client process', async () => {
  let reads = 0;
  const check = createWindowsElevationCheck(async () => ++reads === 1 ? 'elevated' : 'unavailable');
  assert.deepEqual(await Promise.all([check(), check(), check()]), ['elevated', 'elevated', 'elevated']);
  assert.equal(await check(), 'elevated');
  assert.equal(reads, 1, 'device scans reuse the token that actually passed the startup gate');
});

test('missing or standard tokens cannot be promoted by caching or account names', async () => {
  const values = ['unavailable', 'standard', 'unavailable', 'elevated'];
  let reads = 0;
  const check = createWindowsElevationCheck(async () => { reads++; return values.shift(); });
  for (const expected of ['unavailable', 'standard', 'unavailable', 'elevated', 'elevated']) assert.equal(await check(), expected);
  assert.equal(reads, 4);
  assert.equal(await createWindowsElevationCheck(async () => { throw new Error('missing helper'); })(), 'unavailable');
});

test('native source checks the client token and closes handles on every API result', t => {
  if (spawnSync('cc', ['--version']).error) { t.skip('C compiler unavailable'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-token-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'windows.h'), `
#include <stdint.h>
#include <stddef.h>
#include <wchar.h>
typedef uint32_t DWORD;
typedef wchar_t WCHAR;
typedef WCHAR *LPWSTR;
typedef void *HANDLE;
typedef int BOOL;
typedef struct { DWORD TokenIsElevated; } TOKEN_ELEVATION;
#define MAXDWORD UINT32_MAX
#define FALSE 0
#define TOKEN_QUERY 8
#define PROCESS_QUERY_LIMITED_INFORMATION 4096
#define TokenElevation 20
void ExitProcess(DWORD code);
WCHAR *GetCommandLineW(void);
LPWSTR *CommandLineToArgvW(WCHAR *, int *);
void *LocalFree(void *);
HANDLE OpenProcess(DWORD, BOOL, DWORD);
BOOL OpenProcessToken(HANDLE, DWORD, HANDLE *);
BOOL GetTokenInformation(HANDLE, int, void *, DWORD, DWORD *);
BOOL CloseHandle(HANDLE);
`);
  fs.writeFileSync(path.join(directory, 'shellapi.h'), '');
  fs.writeFileSync(path.join(directory, 'api-stubs.c'), `
#include "windows.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>
static int closed = 0;
static int mode(const char *value) { return strcmp(getenv("PROCTOR_PROBE_CASE"), value) == 0; }
void ExitProcess(DWORD code) {
  if (code == 0 || code == 10 || code == 23) assert(closed == 2);
  if (code == 22) assert(closed == 1);
  exit((int)code);
}
WCHAR *GetCommandLineW(void) { return L"probe.exe 4242"; }
LPWSTR *CommandLineToArgvW(WCHAR *value, int *count) {
  (void)value;
  static LPWSTR args[2]; args[0] = L"probe.exe"; args[1] = L"4242";
  if (mode("invalid")) args[1] = L"abc";
  if (mode("overflow")) args[1] = L"4294967296";
  if (mode("zero")) args[1] = L"0";
  *count = mode("badargc") ? 1 : 2; return args;
}
void *LocalFree(void *value) { (void)value; return NULL; }
HANDLE OpenProcess(DWORD access, BOOL inherit, DWORD pid) {
  assert(access == PROCESS_QUERY_LIMITED_INFORMATION && !inherit && pid == 4242);
  return mode("openprocess") ? NULL : (HANDLE)(uintptr_t)1;
}
BOOL OpenProcessToken(HANDLE process, DWORD access, HANDLE *token) {
  assert(process == (HANDLE)(uintptr_t)1 && access == TOKEN_QUERY);
  *token = (HANDLE)(uintptr_t)2; return !mode("opentoken");
}
BOOL GetTokenInformation(HANDLE token, int type, void *buffer, DWORD length, DWORD *size) {
  assert(token == (HANDLE)(uintptr_t)2 && type == TokenElevation && length == sizeof(TOKEN_ELEVATION));
  ((TOKEN_ELEVATION *)buffer)->TokenIsElevated = !mode("standard");
  *size = mode("short") ? 3 : sizeof(TOKEN_ELEVATION);
  return !mode("readtoken");
}
BOOL CloseHandle(HANDLE handle) { assert(handle != NULL); ++closed; return 1; }
void probe_entry(void);
int main(void) { probe_entry(); return 99; }
`);
  const executable = path.join(directory, process.platform === 'win32' ? 'test.exe' : 'test');
  const compiled = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', directory,
    path.join(__dirname, '../native/windows-token/probe.c'), path.join(directory, 'api-stubs.c'), '-o', executable]);
  assert.equal(compiled.status, 0, compiled.stderr?.toString());
  for (const [scenario, code] of Object.entries({ elevated: 0, standard: 10, invalid: 20, overflow: 20, zero: 20, badargc: 20, openprocess: 21, opentoken: 22, readtoken: 23, short: 23 })) {
    const checked = spawnSync(executable, [], { env: { ...process.env, PROCTOR_PROBE_CASE: scenario } });
    assert.equal(checked.status, code, `${scenario}: ${checked.stderr?.toString()}`);
  }
});
