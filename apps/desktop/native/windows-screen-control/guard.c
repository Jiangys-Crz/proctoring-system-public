#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <shellapi.h>
#include <shobjidl.h>
#include "keyboard-policy.h"

/* Temporary process-owned protection only: no registry, policy, taskbar or
   secure-desktop changes. Windows automatically removes hooks/windows if this
   helper dies. The pipe and parent process are both monitored for release. */
static HANDLE parent, stopped, hook_ready;
static DWORD client_pid;
static volatile LONG hook_ok;
static HWND shields[64];
static int shield_count, display_changed;
static HWND images[64];
static int image_count;
static IVirtualDesktopManager *desktops;
static unsigned char keys[256], swallowed[256];
static char command[4096];
static const WCHAR shield_class[] = L"ProctorScreenControlShield";

static int read_command(const char *line, int length) {
    int count = 0;
    if (length == 4 && line[0] == 'S' && line[1] == 'T' && line[2] == 'O' && line[3] == 'P') return 0;
    if (length < 8 || line[0] != 'W' || line[1] != 'I' || line[2] != 'N' || line[3] != 'D'
        || line[4] != 'O' || line[5] != 'W' || line[6] != 'S' || line[7] != ' ') return 1;
    for (int index = 8; index < length && count < 64;) {
        ULONG_PTR value = 0;
        DWORD pid = 0;
        while (index < length && line[index] == ' ') ++index;
        while (index < length && line[index] != ' ') {
            char digit = line[index++];
            if (digit >= '0' && digit <= '9') value = (value << 4) | (digit - '0');
            else if (digit >= 'a' && digit <= 'f') value = (value << 4) | (digit - 'a' + 10);
            else return 1;
        }
        GetWindowThreadProcessId((HWND)value, &pid);
        if (pid == client_pid) images[count++] = (HWND)value;
    }
    image_count = count;
    return 1;
}

static void report(const char *text, DWORD length) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, length, &written, NULL);
}

static LRESULT CALLBACK keyboard(int code, WPARAM message, LPARAM data) {
    if (code == HC_ACTION) {
        const KBDLLHOOKSTRUCT *event = (const KBDLLHOOKSTRUCT *)data;
        DWORD key = event->vkCode;
        if (key < 256) {
            int down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            int control = keys[VK_CONTROL] || keys[VK_LCONTROL] || keys[VK_RCONTROL];
            int alt = keys[VK_MENU] || keys[VK_LMENU] || keys[VK_RMENU] || (event->flags & LLKHF_ALTDOWN);
            int win = keys[VK_LWIN] || keys[VK_RWIN];
            int block = down ? screen_control_block_key(key, control, alt, win) : swallowed[key];
            keys[key] = (unsigned char)down;
            swallowed[key] = down ? (unsigned char)block : 0;
            if (block) return 1;
        }
    }
    return CallNextHookEx(NULL, code, message, data);
}

static DWORD WINAPI keyboard_thread(void *unused) {
    MSG message;
    HHOOK hook;
    (void)unused;
    for (int key = 0; key < 256; ++key) keys[key] = (GetAsyncKeyState(key) & 0x8000) != 0;
    hook = SetWindowsHookExW(WH_KEYBOARD_LL, keyboard, GetModuleHandleW(NULL), 0);
    InterlockedExchange(&hook_ok, hook != NULL);
    SetEvent(hook_ready);
    if (!hook) return 1;
    SetTimer(NULL, 1, 200, NULL);
    while (GetMessageW(&message, NULL, 0, 0) > 0) {
        if (WaitForSingleObject(parent, 0) == WAIT_OBJECT_0 || WaitForSingleObject(stopped, 0) == WAIT_OBJECT_0) break;
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    UnhookWindowsHookEx(hook);
    if (WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) ExitProcess(0);
    return 0;
}

static LRESULT CALLBACK shield_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_CLOSE || message == WM_SYSCOMMAND || message == WM_CONTEXTMENU) return 0;
    if (message == WM_DISPLAYCHANGE) { display_changed = 1; return 0; }
    if (message == WM_PAINT) {
        PAINTSTRUCT paint;
        RECT area;
        HDC dc = BeginPaint(window, &paint);
        GetClientRect(window, &area);
        FillRect(dc, &area, (HBRUSH)GetStockObject(BLACK_BRUSH));
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, RGB(255, 255, 255));
        DrawTextW(dc, L"监考屏幕展示中", -1, &area, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        EndPaint(window, &paint);
        return 0;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

static BOOL CALLBACK cover_monitor(HMONITOR monitor, HDC dc, LPRECT bounds, LPARAM unused) {
    HWND window;
    (void)monitor; (void)dc; (void)unused;
    if (shield_count >= 64) return FALSE;
    window = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, shield_class, L"监考屏幕展示", WS_POPUP,
        bounds->left, bounds->top, bounds->right - bounds->left, bounds->bottom - bounds->top,
        NULL, NULL, GetModuleHandleW(NULL), NULL);
    if (!window) return FALSE;
    shields[shield_count++] = window;
    ShowWindow(window, SW_SHOWNOACTIVATE);
    UpdateWindow(window);
    return TRUE;
}

static void rebuild_shields(void) {
    HWND old[64];
    int old_count = shield_count;
    for (int index = 0; index < old_count; ++index) old[index] = shields[index];
    shield_count = 0;
    if (!EnumDisplayMonitors(NULL, NULL, cover_monitor, 0) || !shield_count) ExitProcess(24);
    for (int index = 0; index < old_count; ++index) DestroyWindow(old[index]);
    display_changed = 0;
    image_count = 0;
    if (shield_count) SetForegroundWindow(shields[0]);
    /* Electron recreates its image windows on the new active desktop. These
       native shields cover every monitor until the images have loaded. */
    report("DESKTOP\n", 8);
}

static int has_virtual_desktops(void) {
    typedef LONG (WINAPI *ReadVersion)(OSVERSIONINFOW *);
    union { FARPROC address; ReadVersion call; } version;
    OSVERSIONINFOW info = { 0 };
    info.dwOSVersionInfoSize = sizeof(info);
    version.address = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
    return !version.call || version.call(&info) != 0 || info.dwMajorVersion >= 10;
}

void guard_entry(void) {
    int count = 0;
    LPWSTR *arguments = CommandLineToArgvW(GetCommandLineW(), &count);
    WNDCLASSW window_class = { 0 };
    DWORD keyboard_id;
    HANDLE thread;
    MSG message;
    HRESULT com;
    int command_length = 0, keep_running = 1;
    if (!arguments || count != 2) ExitProcess(20);
    for (const WCHAR *digit = arguments[1]; *digit; ++digit) {
        if (*digit < L'0' || *digit > L'9' || client_pid > (MAXDWORD - (*digit - L'0')) / 10) ExitProcess(20);
        client_pid = client_pid * 10 + (*digit - L'0');
    }
    LocalFree(arguments);
    parent = OpenProcess(SYNCHRONIZE, FALSE, client_pid);
    if (!parent) ExitProcess(21);
    stopped = CreateEventW(NULL, TRUE, FALSE, NULL);
    hook_ready = CreateEventW(NULL, TRUE, FALSE, NULL);
    thread = CreateThread(NULL, 0, keyboard_thread, NULL, 0, &keyboard_id);
    if (!thread || WaitForSingleObject(hook_ready, 3000) != WAIT_OBJECT_0 || !hook_ok) ExitProcess(22);
    /* Physical monitor coordinates match Electron display bounds under DPI
       scaling. A separate hook thread never waits for shell COM or painting. */
    {
        typedef BOOL (WINAPI *SetDpiContext)(HANDLE);
        union { FARPROC address; SetDpiContext call; } dpi;
        dpi.address = GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext");
        if (!dpi.call || (!dpi.call((HANDLE)-4) && !dpi.call((HANDLE)-3))) SetProcessDPIAware();
    }
    window_class.lpfnWndProc = shield_proc;
    window_class.hInstance = GetModuleHandleW(NULL);
    window_class.lpszClassName = shield_class;
    window_class.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    if (!RegisterClassW(&window_class)) ExitProcess(23);
    com = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    if (SUCCEEDED(com)) CoCreateInstance(&CLSID_VirtualDesktopManager, NULL, CLSCTX_INPROC_SERVER, &IID_IVirtualDesktopManager, (void **)&desktops);
    rebuild_shields();
    if (!shield_count) ExitProcess(24);
    {
        int supported = desktops || !has_virtual_desktops();
        report(supported ? "READY\n" : "DEGRADED\n", supported ? 6 : 9);
    }
    while (keep_running) {
        DWORD available = 0, read = 0;
        char input[64];
        BOOL current = TRUE;
        if (WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) break;
        if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), NULL, 0, NULL, &available, NULL)) break;
        if (available) {
            if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), input, sizeof(input), &read, NULL)) break;
            for (DWORD index = 0; index < read; ++index) {
                if (input[index] == '\n') { keep_running = read_command(command, command_length); command_length = 0; }
                else if (command_length < (int)sizeof(command)) command[command_length++] = input[index];
                else { keep_running = 0; break; }
            }
            if (!keep_running) break;
        }
        if (desktops && shield_count && FAILED(IVirtualDesktopManager_IsWindowOnCurrentVirtualDesktop(desktops, shields[0], &current))) {
            /* Shell restart: recreate the COM object on the next iteration. */
            IVirtualDesktopManager_Release(desktops); desktops = NULL;
            report("DEGRADED\n", 9);
        }
        if (desktops && current) {
            for (int index = 0; index < image_count; ++index) {
                BOOL image_current = TRUE;
                if (IsWindow(images[index]) && SUCCEEDED(IVirtualDesktopManager_IsWindowOnCurrentVirtualDesktop(desktops, images[index], &image_current)) && !image_current) {
                    current = FALSE; break;
                }
            }
        }
        if (!current || display_changed) rebuild_shields();
        if (shield_count) {
            DWORD foreground_pid = 0;
            GetWindowThreadProcessId(GetForegroundWindow(), &foreground_pid);
            if (foreground_pid != client_pid && foreground_pid != GetCurrentProcessId()) SetForegroundWindow(shields[0]);
        }
        while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) {
            TranslateMessage(&message); DispatchMessageW(&message);
        }
        MsgWaitForMultipleObjects(1, &parent, FALSE, 200, QS_ALLINPUT);
    }
    SetEvent(stopped);
    PostThreadMessageW(keyboard_id, WM_QUIT, 0, 0);
    WaitForSingleObject(thread, 1000);
    for (int index = 0; index < shield_count; ++index) DestroyWindow(shields[index]);
    if (desktops) IVirtualDesktopManager_Release(desktops);
    if (SUCCEEDED(com)) CoUninitialize();
    CloseHandle(thread); CloseHandle(hook_ready); CloseHandle(stopped); CloseHandle(parent);
    ExitProcess(0);
}
