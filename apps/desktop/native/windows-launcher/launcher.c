#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <objbase.h>

/* Elevate only the main client through the Windows shell. Electron's own
   executable stays asInvoker so sandboxed Chromium children can start. */
void launcher_entry(void) {
    int count = 0;
    LPWSTR *arguments = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!arguments || count != 3 || !*arguments[1]) ExitProcess(20);
    HRESULT initialized = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    SHELLEXECUTEINFOW launch = { 0 };
    launch.cbSize = sizeof(launch);
    launch.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    launch.lpVerb = L"runas";
    launch.lpFile = arguments[1];
    launch.lpParameters = arguments[2];
    launch.nShow = SW_SHOWNORMAL;
    BOOL started = ShellExecuteExW(&launch);
    DWORD error = started ? 0 : GetLastError();
    if (launch.hProcess) CloseHandle(launch.hProcess);
    if (SUCCEEDED(initialized)) CoUninitialize();
    LocalFree(arguments);
    ExitProcess(started ? 0 : error == ERROR_CANCELLED ? 10 : 20);
}
