#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <setupapi.h>
#include <shellapi.h>
#include <dbt.h>
#include "smbios.h"

/* Read-only Windows 7 APIs. No PowerShell, .NET, WMI service, driver install,
   device enable/disable, process termination, or third-party runtime DLL. */
static HANDLE output;
static void output_sink(const char *bytes, unsigned long length) {
    while (length) {
        DWORD written = 0;
        if (!WriteFile(output, bytes, length, &written, NULL) || !written) ExitProcess(30);
        length -= written;
        bytes += written;
    }
}
#include "buffered-output.h"
static void literal(const char *s) { write_bytes(s, (DWORD)lstrlenA(s)); }
static void quoted(const WCHAR *value, BOOL json) {
    int length = lstrlenW(value);
    int size = WideCharToMultiByte(CP_UTF8, 0, value, length, NULL, 0, NULL, NULL);
    char *utf8 = size ? HeapAlloc(GetProcessHeap(), 0, (SIZE_T)size) : NULL;
    if (size && (!utf8 || WideCharToMultiByte(CP_UTF8, 0, value, length, utf8, size, NULL, NULL) != size)) ExitProcess(31);
    literal("\"");
    for (int i = 0; i < size; i++) {
        unsigned char c = (unsigned char)utf8[i];
        if (c == '"') literal(json ? "\\\"" : "\"\"");
        else if (json && c == '\\') literal("\\\\");
        else if (json && c < 32) {
            const char hex[] = "0123456789abcdef";
            char escape[] = { '\\', 'u', '0', '0', hex[c >> 4], hex[c & 15] };
            write_bytes(escape, 6);
        } else write_bytes(utf8 + i, 1);
    }
    literal("\"");
    if (utf8) HeapFree(GetProcessHeap(), 0, utf8);
}
static void number(DWORD value) {
    char digits[11];
    DWORD at = 10;
    do { digits[--at] = (char)('0' + value % 10); value /= 10; } while (value);
    write_bytes(digits + at, 10 - at);
}
static void enable_debug_query(void) {
    HANDLE token = NULL;
    TOKEN_PRIVILEGES privileges;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES, &token)) return;
    privileges.PrivilegeCount = 1;
    privileges.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    if (LookupPrivilegeValueW(NULL, L"SeDebugPrivilege", &privileges.Privileges[0].Luid))
        AdjustTokenPrivileges(token, FALSE, &privileges, 0, NULL, NULL);
    CloseHandle(token);
}
static void processes(void) {
    enable_debug_query();
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) ExitProcess(40);
    PROCESSENTRY32W entry;
    entry.dwSize = sizeof(entry);
    if (!Process32FirstW(snapshot, &entry)) { CloseHandle(snapshot); ExitProcess(41); }
    WCHAR *path = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 32768 * sizeof(WCHAR));
    if (!path) ExitProcess(31);
    literal("\"Id\",\"ProcessName\",\"Path\"\r\n");
    do {
        path[0] = 0;
        HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID);
        if (process) {
            DWORD size = 32768;
            if (!QueryFullProcessImageNameW(process, 0, path, &size)) path[0] = 0;
            CloseHandle(process);
        }
        literal("\""); number(entry.th32ProcessID); literal("\",");
        /* Toolhelp may label PID 0 as "[System Process]" on older Windows.
           Its kernel identity is fixed; user processes retain their real name. */
        quoted(entry.th32ProcessID == 0 ? L"System Idle Process" : entry.szExeFile, FALSE);
        literal(","); quoted(path, FALSE); literal("\r\n");
    } while (Process32NextW(snapshot, &entry));
    DWORD error = GetLastError();
    HeapFree(GetProcessHeap(), 0, path);
    CloseHandle(snapshot);
    if (error != ERROR_NO_MORE_FILES) ExitProcess(42);
}
static BOOL device_property(HDEVINFO devices, SP_DEVINFO_DATA *device, DWORD property,
    DWORD expected_type, BYTE *value, DWORD capacity, DWORD *size) {
    DWORD type = 0;
    *size = 0;
    if (!SetupDiGetDeviceRegistryPropertyW(devices, device, property, &type, value, capacity, size)) {
        /* Older/custom drivers may not publish optional bus/hardware metadata.
           Access errors and truncated properties are failed observations. */
        if (GetLastError() == ERROR_INVALID_DATA) return FALSE;
        ExitProcess(53);
    }
    if (type != expected_type || *size > capacity) ExitProcess(53);
    return TRUE;
}
static const WCHAR *device_bus(HDEVINFO devices, SP_DEVINFO_DATA *device) {
    static const GUID usb = { 0x9d7debbc, 0xc85d, 0x11d1, { 0x9e, 0xb4, 0x00, 0x60, 0x08, 0xc3, 0xa1, 0x9a } };
    GUID bus;
    DWORD size;
    if (!device_property(devices, device, SPDRP_BUSTYPEGUID, REG_BINARY, (BYTE *)&bus, sizeof(bus), &size)) return L"UNKNOWN";
    if (size != sizeof(bus)) ExitProcess(53);
    for (DWORD i = 0; i < sizeof(bus); i++) if (((BYTE *)&bus)[i] != ((const BYTE *)&usb)[i]) return L"OTHER";
    return L"USB";
}
static void peripherals(void) {
    HDEVINFO devices = SetupDiGetClassDevsW(NULL, NULL, NULL, DIGCF_ALLCLASSES | DIGCF_PRESENT);
    if (devices == INVALID_HANDLE_VALUE) ExitProcess(50);
    SP_DEVINFO_DATA device;
    device.cbSize = sizeof(device);
    WCHAR *identity = HeapAlloc(GetProcessHeap(), 0, 32768 * sizeof(WCHAR));
    WCHAR *hardware = HeapAlloc(GetProcessHeap(), 0, 32768 * sizeof(WCHAR));
    if (!identity || !hardware) ExitProcess(31);
    literal("\"DeviceID\",\"Present\",\"BusType\",\"HardwareID\"\r\n");
    DWORD index = 0;
    while (SetupDiEnumDeviceInfo(devices, index++, &device)) {
        /* All currently present identities are read, so a machine with no USB
           peripherals still has a validated inventory, not a failed probe. */
        if (!SetupDiGetDeviceInstanceIdW(devices, &device, identity, 32768, NULL)) {
            SetupDiDestroyDeviceInfoList(devices); ExitProcess(51);
        }
        DWORD size;
        hardware[0] = 0;
        if (device_property(devices, &device, SPDRP_HARDWAREID, REG_MULTI_SZ, (BYTE *)hardware, 32768 * sizeof(WCHAR), &size)) {
            if (size < 2 * sizeof(WCHAR) || size % sizeof(WCHAR)
                || hardware[size / sizeof(WCHAR) - 1] || hardware[size / sizeof(WCHAR) - 2]) ExitProcess(53);
        } else hardware[0] = 0;
        quoted(identity, FALSE); literal(",\"True\",");
        quoted(device_bus(devices, &device), FALSE); literal(",");
        /* The most-specific hardware ID identifies physical vs MI_xx child
           devices even when a Windows 7 vendor driver uses its own enumerator. */
        quoted(hardware, FALSE); literal("\r\n");
    }
    DWORD error = GetLastError();
    HeapFree(GetProcessHeap(), 0, identity);
    HeapFree(GetProcessHeap(), 0, hardware);
    SetupDiDestroyDeviceInfoList(devices);
    if (error != ERROR_NO_MORE_ITEMS || index <= 1) ExitProcess(52);
}
static void firmware_text(const char *source, WCHAR *target, int capacity) {
    target[0] = 0;
    if (!source) return;
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, source, -1, target, capacity))
        if (!MultiByteToWideChar(CP_ACP, 0, source, -1, target, capacity)) target[0] = 0;
}
static void registry_text(HKEY key, const WCHAR *name, WCHAR *value, DWORD capacity) {
    DWORD size = capacity * sizeof(WCHAR), type = 0;
    if (RegQueryValueExW(key, name, NULL, &type, (BYTE *)value, &size) != ERROR_SUCCESS || type != REG_SZ) value[0] = 0;
    value[capacity - 1] = 0;
}
static void hardware(void) {
    WCHAR manufacturer[256], model[256];
    manufacturer[0] = model[0] = 0;
    const DWORD rsmb = 0x52534D42;
    UINT size = GetSystemFirmwareTable(rsmb, 0, NULL, 0);
    if (size >= 8 && size <= 1024 * 1024) {
        unsigned char *raw = HeapAlloc(GetProcessHeap(), 0, size);
        if (!raw) ExitProcess(31);
        if (GetSystemFirmwareTable(rsmb, 0, raw, size) == size) {
            const char *vendor, *product;
            if (smbios_identity(raw, size, &vendor, &product)) {
                firmware_text(vendor, manufacturer, 256);
                firmware_text(product, model, 256);
            }
        }
        HeapFree(GetProcessHeap(), 0, raw);
    }
    if (!manufacturer[0] || !model[0]) {
        HKEY key;
        if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"HARDWARE\\DESCRIPTION\\System\\BIOS", 0, KEY_READ | KEY_WOW64_64KEY, &key) == ERROR_SUCCESS) {
            if (!manufacturer[0]) registry_text(key, L"SystemManufacturer", manufacturer, 256);
            if (!model[0]) registry_text(key, L"SystemProductName", model, 256);
            RegCloseKey(key);
        }
    }
    if (!manufacturer[0] && !model[0]) ExitProcess(60);
    literal("\"Manufacturer\",\"Model\"\r\n");
    quoted(manufacturer, FALSE); literal(","); quoted(model, FALSE); literal("\r\n");
}
static void window(void) {
    WCHAR *title = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 32768 * sizeof(WCHAR));
    if (!title) ExitProcess(31);
    HWND foreground = GetForegroundWindow();
    if (foreground) {
        SetLastError(ERROR_SUCCESS);
        int count = GetWindowTextW(foreground, title, 32768);
        /* No foreground window and an untitled window are normal transitions.
           GetWindowText does not send messages to another process's controls. */
        if (!count && GetLastError() != ERROR_SUCCESS && IsWindow(foreground)) ExitProcess(70);
    }
    literal("{\"title\":"); quoted(title, TRUE); literal("}\r\n");
    HeapFree(GetProcessHeap(), 0, title);
}
static LRESULT CALLBACK usb_events_window(HWND hwnd, UINT message, WPARAM kind, LPARAM data) {
    if (message == WM_DEVICECHANGE && (kind == DBT_DEVICEARRIVAL || kind == DBT_DEVICEREMOVECOMPLETE) && data) {
        DEV_BROADCAST_HDR *header = (DEV_BROADCAST_HDR *)data;
        if (header->dbch_devicetype == DBT_DEVTYP_DEVICEINTERFACE && header->dbch_size >= sizeof(DEV_BROADCAST_DEVICEINTERFACE_W)) {
            DEV_BROADCAST_DEVICEINTERFACE_W *device = (DEV_BROADCAST_DEVICEINTERFACE_W *)data;
            DWORD capacity = (header->dbch_size - FIELD_OFFSET(DEV_BROADCAST_DEVICEINTERFACE_W, dbcc_name)) / sizeof(WCHAR);
            DWORD size = 0;
            while (size < capacity && device->dbcc_name[size]) size++;
            if (size < capacity && size < 2048) {
                literal(kind == DBT_DEVICEARRIVAL ? "{\"action\":\"INSERT\",\"path\":" : "{\"action\":\"REMOVE\",\"path\":");
                quoted(device->dbcc_name, TRUE); literal("}\r\n"); flush_output();
            }
        }
    }
    return DefWindowProcW(hwnd, message, kind, data);
}
static void usb_events(const WCHAR *parent_text) {
    DWORD parent_id = 0;
    for (DWORD i = 0; parent_text[i]; i++) {
        if (i >= 10 || parent_text[i] < L'0' || parent_text[i] > L'9' || parent_id > 429496729UL) ExitProcess(20);
        DWORD digit = (DWORD)(parent_text[i] - L'0');
        if (parent_id == 429496729UL && digit > 5) ExitProcess(20);
        parent_id = parent_id * 10 + digit;
    }
    HANDLE parent = parent_id ? OpenProcess(SYNCHRONIZE, FALSE, parent_id) : NULL;
    if (!parent) ExitProcess(80);
    WNDCLASSW cls = {0}; cls.lpfnWndProc = usb_events_window; cls.hInstance = GetModuleHandleW(NULL); cls.lpszClassName = L"ProctorUsbEvents";
    if (!RegisterClassW(&cls)) ExitProcess(81);
    HWND hwnd = CreateWindowExW(0, cls.lpszClassName, L"", WS_OVERLAPPED, 0, 0, 0, 0, NULL, NULL, cls.hInstance, NULL);
    if (!hwnd) ExitProcess(82);
    DEV_BROADCAST_DEVICEINTERFACE_W filter = {0};
    const GUID usb_device = {0xa5dcbf10,0x6530,0x11d2,{0x90,0x1f,0x00,0xc0,0x4f,0xb9,0x51,0xed}};
    filter.dbcc_size = sizeof(filter); filter.dbcc_devicetype = DBT_DEVTYP_DEVICEINTERFACE; filter.dbcc_classguid = usb_device;
    HDEVNOTIFY notification = RegisterDeviceNotificationW(hwnd, &filter, DEVICE_NOTIFY_WINDOW_HANDLE);
    if (!notification) ExitProcess(83);
    literal("{\"ready\":true}\r\n"); flush_output();
    for (;;) {
        DWORD result = MsgWaitForMultipleObjects(1, &parent, FALSE, INFINITE, QS_ALLINPUT);
        if (result == WAIT_OBJECT_0) break;
        if (result != WAIT_OBJECT_0 + 1) ExitProcess(84);
        MSG message;
        while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
    }
    UnregisterDeviceNotification(notification); DestroyWindow(hwnd); CloseHandle(parent);
}
void inventory_entry(void) {
    int count = 0;
    LPWSTR *arguments = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!arguments || (count != 2 && count != 3)) ExitProcess(20);
    output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (!output || output == INVALID_HANDLE_VALUE) ExitProcess(30);
    if (count == 3 && !lstrcmpW(arguments[1], L"peripheral-events")) usb_events(arguments[2]);
    else if (count != 2) ExitProcess(20);
    else if (!lstrcmpW(arguments[1], L"processes")) processes();
    else if (!lstrcmpW(arguments[1], L"peripherals")) peripherals();
    else if (!lstrcmpW(arguments[1], L"hardware")) hardware();
    else if (!lstrcmpW(arguments[1], L"window")) window();
    else ExitProcess(20);
    LocalFree(arguments);
    flush_output();
    ExitProcess(0);
}
