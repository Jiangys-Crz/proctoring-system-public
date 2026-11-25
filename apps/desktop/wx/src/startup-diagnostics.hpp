#pragma once
#include "build_config.hpp"
#include <windows.h>
#include <algorithm>
#include <cstdio>
#include <cwchar>
#include <exception>
#include <iterator>
#include <string_view>

namespace proctor::startup {
inline HANDLE output = INVALID_HANDLE_VALUE;
inline wchar_t filename[MAX_PATH]{};
inline LONG handlingException = 0;

inline void Trace(std::string_view event) noexcept {
    if (output == INVALID_HANDLE_VALUE) return;
    SYSTEMTIME now{};
    GetSystemTime(&now);
    char line[384]{};
    const auto length = std::snprintf(line, sizeof(line), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ pid=%lu tid=%lu v%s win32/%s %.*s\r\n",
        now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond, now.wMilliseconds,
        GetCurrentProcessId(), GetCurrentThreadId(), PROCTOR_VERSION, PROCTOR_ARCH,
        static_cast<int>((std::min)(event.size(), std::size_t(160))), event.data());
    DWORD written{};
    if (length > 0) WriteFile(output, line, static_cast<DWORD>((std::min)(length, static_cast<int>(sizeof(line) - 1))), &written, nullptr);
}

inline void TraceAddress(const char* event, const void* address) noexcept {
    MEMORY_BASIC_INFORMATION memory{};
    wchar_t path[MAX_PATH]{};
    char module[128]{};
    const void* base = nullptr;
    if (address && VirtualQuery(address, &memory, sizeof(memory)) && memory.Type == MEM_IMAGE) {
        base = memory.AllocationBase;
        if (GetModuleFileNameW(static_cast<HMODULE>(memory.AllocationBase), path, MAX_PATH)) {
            const auto slash = std::wcsrchr(path, L'\\');
            WideCharToMultiByte(CP_UTF8, 0, slash ? slash + 1 : path, -1, module, sizeof(module) - 1, nullptr, nullptr);
        }
    }
    char detail[256]{};
    std::snprintf(detail, sizeof(detail), "%s address=%p module=%s base=%p rva=0x%llX", event, address, module, base,
        base ? static_cast<unsigned long long>(reinterpret_cast<ULONG_PTR>(address) - reinterpret_cast<ULONG_PTR>(base)) : 0);
    Trace(detail);
}

inline void Fatal(DWORD code, const void* address) noexcept {
    char detail[128]{};
    std::snprintf(detail, sizeof(detail), "native-fatal code=0x%08lX address=%p", code, address);
    Trace(detail);
    if (output != INVALID_HANDLE_VALUE) FlushFileBuffers(output);
    wchar_t message[640]{};
    std::swprintf(message, std::size(message), L"\u5ba2\u6237\u7aef\u53d1\u751f\u539f\u751f\u7a0b\u5e8f\u5f02\u5e38\uff08%08lX\uff09\u3002\n\u8bf7\u5c06\u4ee5\u4e0b\u8bca\u65ad\u6587\u4ef6\u63d0\u4f9b\u7ed9\u76d1\u8003\u8001\u5e08\uff1a\n%ls", code, filename);
    MessageBoxW(nullptr, message, L"\u76d1\u8003\u5ba2\u6237\u7aef\u5f02\u5e38", MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
}

inline LONG WINAPI Exception(EXCEPTION_POINTERS* info) noexcept {
    if (InterlockedCompareExchange(&handlingException, 1, 0)) return EXCEPTION_EXECUTE_HANDLER;
    if (info && info->ExceptionRecord) {
        const auto record = info->ExceptionRecord;
        TraceAddress("fault", record->ExceptionAddress);
        if (record->ExceptionCode == EXCEPTION_ACCESS_VIOLATION && record->NumberParameters >= 2) {
            char detail[128]{};
            std::snprintf(detail, sizeof(detail), "access=%llu target=%p",
                static_cast<unsigned long long>(record->ExceptionInformation[0]),
                reinterpret_cast<void*>(record->ExceptionInformation[1]));
            Trace(detail);
        }
        void* frames[24]{};
        const auto count = CaptureStackBackTrace(0, static_cast<DWORD>(std::size(frames)), frames, nullptr);
        for (USHORT i = 0; i < count; ++i) TraceAddress("stack", frames[i]);
    }
    Fatal(info && info->ExceptionRecord ? info->ExceptionRecord->ExceptionCode : 0xE0000001,
        info && info->ExceptionRecord ? info->ExceptionRecord->ExceptionAddress : nullptr);
    return EXCEPTION_EXECUTE_HANDLER;
}

inline void Initialize() noexcept {
    // Keep this independent of wx, AppData discovery and C++ filesystem I/O.
    // The path is shown on failure even when normal startup logging never ran.
    wchar_t directory[MAX_PATH]{};
    const auto length = GetTempPathW(MAX_PATH, directory);
    if (length && length < MAX_PATH - 80) {
        std::wcscat(directory, L"CWNUPAAProctor");
        CreateDirectoryW(directory, nullptr);
        std::swprintf(filename, std::size(filename), L"%ls\\startup-%lu.log", directory, GetCurrentProcessId());
        output = CreateFileW(filename, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr);
    }
    SetUnhandledExceptionFilter(Exception);
    std::set_terminate([] { Fatal(0xE0000002, nullptr); ExitProcess(0xE0000002); });
    Trace("native-entry");
    TraceAddress("image", GetModuleHandleW(nullptr));
}
}
