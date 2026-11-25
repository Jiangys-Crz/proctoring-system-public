#include "native_windows_process.hpp"

#include <wincrypt.h>
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <cctype>
#include <stdexcept>
#include <system_error>
#include <thread>

namespace proctor::native {
namespace {
[[noreturn]] void WindowsError(const char* message) {
    throw std::system_error(static_cast<int>(GetLastError()), std::system_category(), message);
}

std::wstring QuoteArgument(std::wstring_view value) {
    std::wstring result = L"\"";
    std::size_t slashes = 0;
    for (const wchar_t c : value) {
        if (c == L'\\') { ++slashes; continue; }
        result.append(c == L'\"' ? 2 * slashes + 1 : slashes, L'\\');
        result.push_back(c);
        slashes = 0;
    }
    result.append(2 * slashes, L'\\');
    result.push_back(L'\"');
    return result;
}

struct OutputPipe {
    Handle read, write;
    OutputPipe() {
        SECURITY_ATTRIBUTES attributes{sizeof(attributes), nullptr, TRUE};
        HANDLE in = nullptr, out = nullptr;
        if (!CreatePipe(&in, &out, &attributes, 0)) WindowsError("CreatePipe");
        read.reset(in);
        write.reset(out);
        if (!SetHandleInformation(in, HANDLE_FLAG_INHERIT, 0)) WindowsError("SetHandleInformation");
    }
};

struct InputPipe {
    Handle read, write;
    InputPipe() {
        SECURITY_ATTRIBUTES attributes{sizeof(attributes), nullptr, TRUE};
        const auto name = L"\\\\.\\pipe\\proctor-" + Wide(StringUuid());
        read.reset(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
                                    PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                                    1, 4096, 4096, 0, &attributes));
        if (read.get() == INVALID_HANDLE_VALUE) WindowsError("CreateNamedPipeW");
        write.reset(CreateFileW(name.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr));
        if (write.get() == INVALID_HANDLE_VALUE) WindowsError("CreateFileW");
        if (!ConnectNamedPipe(read.get(), nullptr) && GetLastError() != ERROR_PIPE_CONNECTED) WindowsError("ConnectNamedPipe");
    }
};

class ProcessAttributes {
public:
    ProcessAttributes() {
        SIZE_T size = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
        storage_.resize(size);
        if (!InitializeProcThreadAttributeList(get(), 1, 0, &size)) WindowsError("InitializeProcThreadAttributeList");
    }
    ~ProcessAttributes() { DeleteProcThreadAttributeList(get()); }
    LPPROC_THREAD_ATTRIBUTE_LIST get() { return reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage_.data()); }
private:
    std::vector<unsigned char> storage_;
};

std::string ReadPipe(HANDLE pipe) {
    DWORD available = 0;
    if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr) || !available) return {};
    std::string result((std::min)(available, 65536ul), '\0');
    DWORD read = 0;
    if (!ReadFile(pipe, result.data(), static_cast<DWORD>(result.size()), &read, nullptr)) WindowsError("ReadFile");
    result.resize(read);
    return result;
}
}

ChildProcess::ChildProcess(const fs::path& exe, const std::vector<std::wstring>& args, bool ownTree) {
    InputPipe stdinPipe;
    OutputPipe stdoutPipe, stderrPipe;
    ProcessAttributes attributes;
    HANDLE inherited[]{stdinPipe.read.get(), stdoutPipe.write.get(), stderrPipe.write.get()};
    if (!UpdateProcThreadAttribute(attributes.get(), 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                   inherited, sizeof(inherited), nullptr, nullptr))
        WindowsError("UpdateProcThreadAttribute");
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inherited[0];
    startup.StartupInfo.hStdOutput = inherited[1];
    startup.StartupInfo.hStdError = inherited[2];
    startup.lpAttributeList = attributes.get();

    std::wstring command = QuoteArgument(exe.wstring());
    for (const auto& arg : args) command += L" " + QuoteArgument(arg);
    PROCESS_INFORMATION info{};
    if (!CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, TRUE,
                        CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                        nullptr, nullptr, &startup.StartupInfo, &info)) WindowsError("CreateProcessW");
    process_.reset(info.hProcess);
    Handle thread(info.hThread);
    // A collector may launch another process, such as tshark's dumpcap. Close
    // the job on timeouts and stop requests so its children are released too.
    if (ownTree) job_.reset(CreateJobObjectW(nullptr, nullptr));
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (job_ && (!SetInformationJobObject(job_.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
                 !AssignProcessToJobObject(job_.get(), process_.get()))) job_.reset();
    if (ResumeThread(thread.get()) == static_cast<DWORD>(-1)) {
        const DWORD error = GetLastError();
        Stop();
        SetLastError(error);
        WindowsError("ResumeThread");
    }
    input_ = std::move(stdinPipe.write);
    output_ = std::move(stdoutPipe.read);
    errors_ = std::move(stderrPipe.read);
}

ChildProcess::~ChildProcess() { Stop(); }
bool ChildProcess::IsRunning() const { return WaitForSingleObject(process_.get(), 0) == WAIT_TIMEOUT; }
DWORD ChildProcess::ExitCode() const {
    DWORD value = 0;
    if (!GetExitCodeProcess(process_.get(), &value)) WindowsError("GetExitCodeProcess");
    return value;
}
std::string ChildProcess::ReadOutput() { return ReadPipe(output_.get()); }
std::string ChildProcess::ReadErrors() { return ReadPipe(errors_.get()); }
bool ChildProcess::Write(std::string_view input) {
    if (!input_ || input.size() > 4096) return false;
    Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!event) return false;
    OVERLAPPED operation{};
    operation.hEvent = event.get();
    DWORD written = 0;
    if (!WriteFile(input_.get(), input.data(), static_cast<DWORD>(input.size()), &written, &operation)) {
        if (GetLastError() != ERROR_IO_PENDING) return false;
        if (WaitForSingleObject(event.get(), 250) != WAIT_OBJECT_0) {
            // A blocked helper must still be stoppable when the screen is
            // released or the application exits. Wait for cancellation before
            // its OVERLAPPED record and input buffer go out of scope.
            CancelIoEx(input_.get(), &operation);
            GetOverlappedResult(input_.get(), &operation, &written, TRUE);
            return false;
        }
    }
    return GetOverlappedResult(input_.get(), &operation, &written, FALSE) && written == input.size();
}
void ChildProcess::CloseInput() { input_.reset(); }
void ChildProcess::Stop(DWORD graceMs) {
    CloseInput();
    if (!process_) return;
    if (WaitForSingleObject(process_.get(), graceMs) == WAIT_TIMEOUT) TerminateProcess(process_.get(), 1);
    job_.reset();
}

CommandResult Run(const fs::path& exe, const std::vector<std::wstring>& args,
                  std::chrono::milliseconds timeout, std::size_t maxBytes, bool ownTree, const std::atomic_bool* cancelled) {
    auto checkCancelled = [&] { if (cancelled && cancelled->load()) throw std::runtime_error("系统检测已取消"); };
    checkCancelled();
    ChildProcess child(exe, args, ownTree);
    child.CloseInput();
    const auto deadline = Clock::now() + timeout;
    std::string output;
    std::size_t errorSize = 0;
    auto drain = [&] {
        const auto bytes = child.ReadOutput();
        output += bytes;
        errorSize += child.ReadErrors().size();
        if (output.size() > maxBytes || errorSize > maxBytes) throw std::runtime_error("检测组件输出过大");
        return !bytes.empty();
    };
    while (child.IsRunning()) {
        checkCancelled();
        if (Clock::now() >= deadline) throw std::runtime_error("检测组件执行超时");
        if (!drain()) std::this_thread::sleep_for(10ms);
    }
    while (drain()) { }
    return {child.ExitCode(), std::move(output)};
}

std::wstring Wide(std::string_view text) {
    if (text.empty()) return {};
    const auto inputSize = static_cast<int>(text.size());
    const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), inputSize, nullptr, 0);
    if (!size) WindowsError("MultiByteToWideChar");
    std::wstring result(size, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), inputSize, result.data(), size);
    return result;
}

std::string Utf8(std::wstring_view text) {
    if (text.empty()) return {};
    const auto inputSize = static_cast<int>(text.size());
    const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), inputSize, nullptr, 0, nullptr, nullptr);
    if (!size) WindowsError("WideCharToMultiByte");
    std::string result(size, '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), inputSize, result.data(), size, nullptr, nullptr);
    return result;
}

std::string Base64(std::string_view text) {
    constexpr DWORD encoding = CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF;
    const auto bytes = reinterpret_cast<const BYTE*>(text.data());
    const auto length = static_cast<DWORD>(text.size());
    DWORD size = 0;
    if (!CryptBinaryToStringA(bytes, length, encoding, nullptr, &size)) WindowsError("CryptBinaryToStringA");
    std::string result(size, '\0');
    if (!CryptBinaryToStringA(bytes, length, encoding, result.data(), &size)) WindowsError("CryptBinaryToStringA");
    result.resize(size);
    return result;
}

std::string Trim(std::string_view value) {
    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.front()))) value.remove_prefix(1);
    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.back()))) value.remove_suffix(1);
    return std::string(value);
}

std::vector<std::string> Split(std::string_view value, char separator) {
    std::vector<std::string> parts;
    for (auto boundary = value.find(separator); boundary != std::string_view::npos; boundary = value.find(separator)) {
        parts.emplace_back(value.substr(0, boundary));
        value.remove_prefix(boundary + 1);
    }
    parts.emplace_back(value);
    return parts;
}

std::vector<std::string> ParseCsv(std::string_view line) {
    std::vector<std::string> fields;
    std::string field;
    bool quoted = false;
    for (std::size_t at = 0; at < line.size(); ++at) {
        const char c = line[at];
        if (c == '"' && quoted && at + 1 < line.size() && line[at + 1] == '"') {
            field.push_back(c);
            ++at;
        } else if (c == '"') quoted = !quoted;
        else if (c == ',' && !quoted) {
            fields.push_back(Trim(field));
            field.clear();
        } else field.push_back(c);
    }
    fields.push_back(Trim(field));
    return fields;
}

std::string StringUuid() {
    std::array<unsigned char, 16> bytes{};
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
        throw std::runtime_error("无法生成设备标识");
    bytes[6] = (bytes[6] & 0x0F) | 0x40;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;
    constexpr std::string_view hex = "0123456789abcdef";
    std::string result;
    for (std::size_t i = 0; i < bytes.size(); ++i) {
        if (i == 4 || i == 6 || i == 8 || i == 10) result.push_back('-');
        result.push_back(hex[bytes[i] >> 4]);
        result.push_back(hex[bytes[i] & 15]);
    }
    return result;
}
}
