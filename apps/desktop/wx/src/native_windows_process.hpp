#pragma once

#include <windows.h>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace proctor::native {
namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;

struct CloseNativeHandle {
    void operator()(void* handle) const noexcept { if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle); }
};
using Handle = std::unique_ptr<void, CloseNativeHandle>;

class ChildProcess {
public:
    ChildProcess(const fs::path& exe, const std::vector<std::wstring>& args, bool ownTree = true);
    ~ChildProcess();

    bool IsRunning() const;
    DWORD ExitCode() const;
    std::string ReadOutput();
    std::string ReadErrors();
    bool Write(std::string_view input);
    void CloseInput();
    void Stop(DWORD graceMs = 0);

private:
    Handle process_, job_, input_, output_, errors_;
};

struct CommandResult {
    DWORD code;
    std::string output;
};

CommandResult Run(const fs::path& exe, const std::vector<std::wstring>& args,
                  std::chrono::milliseconds timeout = 5000ms, std::size_t maxBytes = 4 * 1024 * 1024, bool ownTree = true,
                  const std::atomic_bool* cancelled = nullptr);
std::wstring Wide(std::string_view text);
std::string Utf8(std::wstring_view text);
std::string Base64(std::string_view text);
std::string Trim(std::string_view value);
std::vector<std::string> Split(std::string_view value, char separator);
std::string StringUuid();
std::vector<std::string> ParseCsv(std::string_view line);
}
