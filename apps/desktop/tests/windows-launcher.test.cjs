const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('native launcher uses Windows runas, preserves its exact Unicode target and handles refusal without a command shell', t => {
  if (spawnSync('cc', ['--version']).error) { t.skip('C compiler unavailable'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-launcher-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'windows.h'), `
#include <stdint.h>
#include <stddef.h>
#include <wchar.h>
typedef uint32_t DWORD;
typedef int HRESULT;
typedef wchar_t *LPWSTR;
typedef void *HANDLE;
typedef int BOOL;
#define ERROR_CANCELLED 1223
#define SW_SHOWNORMAL 1
#define SUCCEEDED(value) ((value) >= 0)
void ExitProcess(DWORD);
DWORD GetLastError(void);
LPWSTR GetCommandLineW(void);
LPWSTR *CommandLineToArgvW(LPWSTR, int *);
void *LocalFree(void *);
BOOL CloseHandle(HANDLE);
`);
  fs.writeFileSync(path.join(directory, 'shellapi.h'), `
#include "windows.h"
#define SEE_MASK_NOCLOSEPROCESS 64
#define SEE_MASK_NOASYNC 256
typedef struct { DWORD cbSize, fMask; const wchar_t *lpVerb, *lpFile, *lpParameters; int nShow; HANDLE hProcess; } SHELLEXECUTEINFOW;
BOOL ShellExecuteExW(SHELLEXECUTEINFOW *);
`);
  // windows.h is included twice, matching the real SDK's guarded headers.
  const header = fs.readFileSync(path.join(directory, 'windows.h'), 'utf8');
  fs.writeFileSync(path.join(directory, 'windows.h'), '#ifndef PROCTOR_WINDOWS_H\n#define PROCTOR_WINDOWS_H\n' + header + '\n#endif\n');
  fs.writeFileSync(path.join(directory, 'objbase.h'), `
#include "windows.h"
#define COINIT_APARTMENTTHREADED 2
#define COINIT_DISABLE_OLE1DDE 4
HRESULT CoInitializeEx(void *, DWORD);
void CoUninitialize(void);
`);
  fs.writeFileSync(path.join(directory, 'stubs.c'), `
#include "shellapi.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>
static int closed = 0, freed = 0, com = 0;
static int mode(const char *value) { return strcmp(getenv("PROCTOR_LAUNCH_CASE"), value) == 0; }
LPWSTR GetCommandLineW(void) { return L"launcher"; }
LPWSTR *CommandLineToArgvW(LPWSTR cmd, int *count) {
  (void)cmd; static LPWSTR args[] = { L"launcher.exe", L"C:\\\\监考 软件\\\\客户端.exe", L"--proctor-elevated-relaunch" };
  *count = mode("invalid") ? 1 : 3; return args;
}
HRESULT CoInitializeEx(void *reserved, DWORD flags) { assert(!reserved && flags == 6); return 0; }
void CoUninitialize(void) { com++; }
BOOL ShellExecuteExW(SHELLEXECUTEINFOW *launch) {
  assert(launch->cbSize == sizeof(*launch) && launch->fMask == (64 | 256));
  assert(wcscmp(launch->lpVerb, L"runas") == 0);
  assert(wcscmp(launch->lpFile, L"C:\\\\监考 软件\\\\客户端.exe") == 0);
  assert(wcscmp(launch->lpParameters, L"--proctor-elevated-relaunch") == 0);
  assert(launch->nShow == 1);
  if (mode("success")) { launch->hProcess = (HANDLE)(uintptr_t)1; return 1; } return 0;
}
DWORD GetLastError(void) { return mode("cancelled") ? ERROR_CANCELLED : 5; }
BOOL CloseHandle(HANDLE process) { assert(process == (HANDLE)(uintptr_t)1); closed++; return 1; }
void *LocalFree(void *value) { assert(value); freed++; return NULL; }
void ExitProcess(DWORD code) {
  if (!mode("invalid")) { assert(freed == 1 && com == 1); assert(closed == (mode("success") ? 1 : 0)); }
  exit((int)code);
}
void launcher_entry(void);
int main(void) { launcher_entry(); return 99; }
`);
  const executable = path.join(directory, 'launcher-test');
  const compiled = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', directory,
    path.join(__dirname, '../native/windows-launcher/launcher.c'), path.join(directory, 'stubs.c'), '-o', executable]);
  assert.equal(compiled.status, 0, compiled.stderr.toString());
  for (const [scenario, code] of Object.entries({ success: 0, cancelled: 10, failed: 20, invalid: 20 })) {
    assert.equal(spawnSync(executable, [], { env: { ...process.env, PROCTOR_LAUNCH_CASE: scenario } }).status, code, scenario);
  }
});
