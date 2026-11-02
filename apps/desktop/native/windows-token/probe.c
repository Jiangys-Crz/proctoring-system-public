#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>

/* Query the parent client's token instead of depending on PowerShell, .NET,
   localized command output or server services.
   This entry point has no CRT dependency and works with Windows 7 system DLLs. */
void probe_entry(void) {
    int count = 0;
    LPWSTR *arguments = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!arguments || count != 2) ExitProcess(20);
    DWORD pid = 0;
    const WCHAR *digit = arguments[1];
    if (!*digit) ExitProcess(20);
    for (; *digit; ++digit) {
        if (*digit < L'0' || *digit > L'9' || pid > (MAXDWORD - (*digit - L'0')) / 10) ExitProcess(20);
        pid = pid * 10 + (*digit - L'0');
    }
    LocalFree(arguments);
    if (!pid) ExitProcess(20);
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) ExitProcess(21);
    HANDLE token = NULL;
    TOKEN_ELEVATION elevation = { 0 };
    DWORD size = 0;
    BOOL opened = OpenProcessToken(process, TOKEN_QUERY, &token);
    CloseHandle(process);
    if (!opened) {
        ExitProcess(22);
    }
    BOOL ok = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size);
    CloseHandle(token);
    if (!ok || size != sizeof(elevation)) {
        ExitProcess(23);
    }
    ExitProcess(elevation.TokenIsElevated ? 0 : 10);
}
