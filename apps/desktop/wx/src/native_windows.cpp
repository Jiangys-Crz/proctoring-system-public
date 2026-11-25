#include "native_windows_security.hpp"
#include "build_config.hpp"
#include "windows-device-access.hpp"

#include <bcrypt.h>
#include <objbase.h>
#include <shellapi.h>

#include <algorithm>
#include <array>
#include <charconv>
#include <fstream>
#include <iomanip>
#include <map>
#include <optional>
#include <regex>
#include <set>
#include <sstream>
#include <thread>

namespace proctor::native {
namespace {
std::wstring WinDirectory() {
    wchar_t buffer[MAX_PATH]{};
    const auto size = GetWindowsDirectoryW(buffer, MAX_PATH);
    if (!size || size >= MAX_PATH) throw std::runtime_error("无法定位 Windows 系统目录");
    return std::wstring(buffer, size);
}
}

std::wstring ReadEnv(const wchar_t* key) {
    const auto size = GetEnvironmentVariableW(key, nullptr, 0);
    if (!size) return {};
    std::wstring value(size, L'\0');
    const auto returned = GetEnvironmentVariableW(key, value.data(), size);
    if (!returned || returned >= size) return {};
    value.resize(returned);
    return value;
}

fs::path SystemCommand(const fs::path& relative) {
    const fs::path root = WinDirectory();
#ifndef _WIN64
    const auto native = root / L"Sysnative" / relative;
    if (fs::exists(native)) return native;
#endif
    return root / L"System32" / relative;
}

fs::path ExecutablePath() {
    std::wstring path(32768, L'\0');
    const DWORD size = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (!size || size >= path.size()) throw std::runtime_error("无法定位客户端程序");
    path.resize(size);
    return path;
}

std::string OsRelease() {
    using RtlGetVersion = LONG (WINAPI*)(OSVERSIONINFOW*);
    const auto ntdll = GetModuleHandleW(L"ntdll.dll");
    const auto version = reinterpret_cast<RtlGetVersion>(GetProcAddress(ntdll, "RtlGetVersion"));
    OSVERSIONINFOW result{};
    result.dwOSVersionInfoSize = sizeof(result);
    if (!version || version(&result) < 0) return {};
    return std::to_string(result.dwMajorVersion) + "." + std::to_string(result.dwMinorVersion) + "." + std::to_string(result.dwBuildNumber);
}

std::string Sha256(std::istream& input) {
    struct Algorithm {
        BCRYPT_ALG_HANDLE handle = nullptr;
        ~Algorithm() { if (handle) BCryptCloseAlgorithmProvider(handle, 0); }
    } algorithm;
    struct Hash {
        BCRYPT_HASH_HANDLE handle = nullptr;
        ~Hash() { if (handle) BCryptDestroyHash(handle); }
    };
    auto check = [](NTSTATUS value) { if (value < 0) throw std::runtime_error("无法计算 SHA-256"); };
    check(BCryptOpenAlgorithmProvider(&algorithm.handle, BCRYPT_SHA256_ALGORITHM, nullptr, 0));
    DWORD size = 0, returned = 0;
    check(BCryptGetProperty(algorithm.handle, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&size), sizeof(size), &returned, 0));
    std::vector<unsigned char> storage(size);
    Hash hash;
    check(BCryptCreateHash(algorithm.handle, &hash.handle, storage.data(), size, nullptr, 0, 0));
    std::array<unsigned char, 65536> chunk{};
    while (input) {
        input.read(reinterpret_cast<char*>(chunk.data()), chunk.size());
        if (input.gcount()) check(BCryptHashData(hash.handle, chunk.data(), static_cast<ULONG>(input.gcount()), 0));
    }
    if (!input.eof() || input.bad()) throw std::runtime_error("无法读取校验文件");
    std::array<unsigned char, 32> digest{};
    check(BCryptFinishHash(hash.handle, digest.data(), static_cast<ULONG>(digest.size()), 0));
    constexpr std::string_view hex = "0123456789abcdef";
    std::string result;
    for (const auto value : digest) {
        result.push_back(hex[value >> 4]);
        result.push_back(hex[value & 15]);
    }
    return result;
}
}

namespace proctor {
namespace {
using namespace native;
struct ProcessEntry { DWORD pid; std::string name; fs::path executable; };
using ProcessEntries = std::vector<ProcessEntry>;

std::string Lower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}
std::wstring PathKey(const fs::path& path) {
    auto text = path.lexically_normal().make_preferred().wstring();
    if (!text.empty()) CharLowerBuffW(text.data(), static_cast<DWORD>(text.size()));
    return text;
}
bool IsKernel(DWORD pid, const std::string& name) {
    const auto lower = Lower(name);
    return (pid == 0 || pid == 4) && (lower == "system" || lower == "system idle process" || lower == "idle");
}

ProcessEntries ReadProcesses(const fs::path& probe) {
    const auto result = Run(probe, {L"processes"});
    ProcessEntries entries;
    if (result.code == 0) for (const auto& line : Split(result.output, '\n')) {
        const auto row = ParseCsv(line);
        if (row.size() < 2 || row[1].empty()) continue;
        DWORD pid = 0;
        const auto end = row[0].data() + row[0].size();
        const auto parsed = std::from_chars(row[0].data(), end, pid);
        if (parsed.ec != std::errc{} || parsed.ptr != end) continue;
        auto name = IsKernel(pid, row[1]) ? row[1] : Lower(row[1]);
        if (!IsKernel(pid, name) && !name.ends_with(".exe")) name += ".exe";
        entries.push_back({pid, std::move(name), row.size() >= 3 ? fs::path(Wide(row[2])) : fs::path{}});
    }
    if (entries.empty()) throw std::runtime_error("进程检测未读取到有效的进程列表，请重新检测或检查系统组件。");
    return entries;
}

std::wstring QuotePowerShellLiteral(std::wstring_view value) {
    std::wstring quoted = L"'";
    for (const auto c : value) {
        if (c == L'\'') quoted.push_back(c);
        quoted.push_back(c);
    }
    return quoted + L"'";
}

std::string SignatureSubject(const fs::path& file) {
    const auto quoted = QuotePowerShellLiteral(file.wstring());
    const auto script = L"[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding\n$ErrorActionPreference = 'Stop'\n"
        L"if ((Get-Command Get-AuthenticodeSignature).Parameters.ContainsKey('LiteralPath')) { $s = Get-AuthenticodeSignature -LiteralPath " + quoted +
        L" } else { $s = Get-AuthenticodeSignature -FilePath ([System.Management.Automation.WildcardPattern]::Escape(" + quoted +
        L")) }; if ($s.Status -ne 'Valid') { exit 1 }; $s.SignerCertificate.Subject";
    const auto utf16 = std::string_view(reinterpret_cast<const char*>(script.data()), script.size() * sizeof(wchar_t));
    const auto output = Run(SystemCommand(L"WindowsPowerShell\\v1.0\\powershell.exe"),
                            {L"-NoProfile", L"-NonInteractive", L"-EncodedCommand", Wide(Base64(utf16))}, 8s, 1024 * 1024);
    if (output.code) return {};
    return Trim(output.output);
}

std::string SubjectAttribute(const std::string& subject, const std::regex& expression) {
    std::smatch match;
    if (!std::regex_search(subject, match, expression)) return {};
    return Trim(match[1].matched ? match[1].str() : match[2].str());
}

struct FileStamp {
    DWORD volume;
    std::uint64_t index, size;
    std::int64_t modified, changed;
    bool operator==(const FileStamp&) const = default;
};
FileStamp ReadFileStamp(const fs::path& path) {
    Handle input(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                             nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    BY_HANDLE_FILE_INFORMATION file{};
    FILE_BASIC_INFO details{};
    if (input.get() == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(input.get(), &file) ||
        !GetFileInformationByHandleEx(input.get(), FileBasicInfo, &details, sizeof(details)))
        throw std::runtime_error("进程文件不可验证");
    const auto combine = [](DWORD high, DWORD low) { return (static_cast<std::uint64_t>(high) << 32) | low; };
    return {file.dwVolumeSerialNumber, combine(file.nFileIndexHigh, file.nFileIndexLow), combine(file.nFileSizeHigh, file.nFileSizeLow),
            details.LastWriteTime.QuadPart, details.ChangeTime.QuadPart};
}

class ProcessPolicy {
public:
    ProcessPolicy(const fs::path& resources, const fs::path& runtime) {
        auto policy = std::ifstream(resources / L"renderer/process-policy.json", std::ios::binary);
        const auto manifest = Json::parse(policy, nullptr, false);
        if (manifest.is_object() && manifest.value("version", Json()) == 1) {
            const auto hashes = manifest.value("executables", Json::object());
            if (hashes.is_object()) for (const auto& [path, hash] : hashes.items()) {
                if (hash.is_string()) pins_.emplace(PathKey(Wide(path)), Lower(hash.get<std::string>()));
            }
        }
        // Electron used the same executable for the browser subprocesses. The
        // fixed runtime has separate executables at these exact installed paths.
        for (const auto& binary : {ExecutablePath(), resources / L"ffmpeg/ffmpeg.exe", resources / L"security/token-probe.exe",
                                   resources / L"security/inventory-probe.exe", runtime / L"msedgewebview2.exe", runtime / L"msedge_crashpad_handler.exe"}) {
            own_.insert(PathKey(binary));
            std::error_code error;
            auto canonical = fs::canonical(binary, error);
            if (!error) own_.insert(PathKey(canonical));
        }
    }
    Json Disallowed(const ProcessEntries& entries) {
        Json result = Json::array();
        std::set<std::string> seen;
        // Many Windows services share the same binary. Prove each candidate
        // once per inventory, without keeping negative decisions across scans.
        std::map<std::wstring_view, bool> verified;
        const auto clientPid = GetCurrentProcessId();
        constexpr std::size_t batchSize = 32;
        static const auto concurrency = std::clamp(std::thread::hardware_concurrency(), 1u, 4u);
        for (std::size_t offset = 0; offset < entries.size(); offset += batchSize) {
            const auto count = std::min(batchSize, entries.size() - offset);
            std::array<bool, batchSize> quick{};
            std::array<const bool*, batchSize> allowed{};
            std::array<std::pair<const fs::path*, bool*>, batchSize> candidates{};
            std::size_t candidateCount = 0;
            for (std::size_t i = 0; i < count; ++i) {
                const auto& entry = entries[offset + i];
                allowed[i] = &quick[i];
                if (entry.pid == clientPid) quick[i] = true;
                else if (entry.executable.empty()) quick[i] = IsKernel(entry.pid, entry.name);
                else {
                    const auto key = PathKey(entry.executable);
                    if (own_.contains(key)) quick[i] = true;
                    else if (IsPolicyCandidate(PathKey(entry.executable.filename())) || pins_.contains(key)) {
                        // Keep the original spelling so case-sensitive Windows
                        // directories do not share a decision between files.
                        auto [entryProof, inserted] = verified.try_emplace(entry.executable.native(), false);
                        allowed[i] = &entryProof->second;
                        if (inserted) candidates[candidateCount++] = {&entry.executable, &entryProof->second};
                    }
                }
            }
            std::atomic_size_t next{};
            const auto verify = [&] {
                for (auto index = next.fetch_add(1, std::memory_order_relaxed); index < candidateCount;
                     index = next.fetch_add(1, std::memory_order_relaxed)) {
                    auto [path, decision] = candidates[index];
                    *decision = CheckExecutable(*path);
                }
            };
            std::vector<std::future<void>> jobs;
            for (std::size_t i = 1; i < std::min<std::size_t>(concurrency, candidateCount); ++i)
                jobs.push_back(std::async(std::launch::async, verify));
            verify();
            for (auto& job : jobs) job.get();
            for (std::size_t i = 0; i < count; ++i) {
                const auto& name = entries[offset + i].name;
                if (!*allowed[i] && seen.insert(name).second) result.push_back(name);
            }
            if (result.size() >= 60) {
                result.erase(result.begin() + 60, result.end());
                break;
            }
        }
        return result;
    }

private:
    struct CachedSigner { FileStamp stamp; std::shared_future<std::string> signer; };
    std::set<std::wstring> own_;
    std::map<std::wstring, std::string> pins_;
    std::mutex mutex_;
    std::map<std::wstring, CachedSigner> signers_;

    std::string ReadSigner(const fs::path& path, const std::wstring& key) {
        const auto stamp = ReadFileStamp(path);
        std::optional<std::promise<std::string>> writer;
        std::shared_future<std::string> cached;
        {
            const std::lock_guard lock(mutex_);
            if (const auto prior = signers_.find(key); prior != signers_.end() && prior->second.stamp == stamp) cached = prior->second.signer;
            else {
                cached = writer.emplace().get_future().share();
                signers_.insert_or_assign(key, CachedSigner{stamp, cached});
            }
        }
        if (writer) {
            try {
                auto signature = SignatureSubject(path);
                if (signature.empty() || ReadFileStamp(path) != stamp) throw std::runtime_error("进程签名不可验证");
                writer->set_value(std::move(signature));
            } catch (...) {
                writer->set_exception(std::current_exception());
                const std::lock_guard lock(mutex_);
                const auto prior = signers_.find(key);
                if (prior != signers_.end() && prior->second.stamp == stamp) signers_.erase(prior);
            }
        }
        return cached.get();
    }

    inline static const std::set<std::wstring> windowsSystem_{
        L"svchost.exe", L"services.exe", L"wininit.exe", L"winlogon.exe", L"csrss.exe", L"lsass.exe", L"dwm.exe", L"conhost.exe",
        L"explorer.exe", L"runtimebroker.exe", L"taskhostw.exe", L"audiodg.exe", L"ctfmon.exe", L"fontdrvhost.exe", L"dllhost.exe",
        L"sihost.exe", L"spoolsv.exe", L"wmiprvse.exe", L"searchhost.exe", L"searchindexer.exe", L"startmenuexperiencehost.exe",
        L"shellexperiencehost.exe", L"textinputhost.exe", L"securityhealthservice.exe", L"securityhealthsystray.exe", L"msmpeng.exe", L"nissrv.exe"
    };
    inline static const std::set<std::wstring> jetbrains_{L"idea64.exe", L"pycharm64.exe", L"clion64.exe", L"rider64.exe", L"goland64.exe"};
    static bool IsPolicyCandidate(const std::wstring& name) {
        return windowsSystem_.contains(name) || jetbrains_.contains(name) || name == L"code.exe" || name == L"eclipse.exe";
    }

    bool CheckExecutable(const fs::path& executable) {
        try {
            const auto path = fs::canonical(executable);
            if (!fs::is_regular_file(path)) return false;
            const auto key = PathKey(path);
            const auto fileName = PathKey(path.filename());
            static const std::regex hashPattern("[a-f0-9]{64}");
            if (const auto pin = pins_.find(key); pin != pins_.end() && std::regex_match(pin->second, hashPattern)) {
                std::ifstream bytes(path, std::ios::binary);
                if (Sha256(bytes) == pin->second) return true;
            }
            static const fs::path windows = WinDirectory();
            static const auto system32 = PathKey(windows / L"System32") + L'\\';
            static const auto syswow64 = PathKey(windows / L"SysWOW64") + L'\\';
            static const auto explorer = PathKey(windows / L"explorer.exe");
            const bool system = windowsSystem_.contains(fileName) &&
                (key.starts_with(system32) || key.starts_with(syswow64) || key == explorer);
            const bool installed = key.starts_with(L"c:\\program files\\") || key.starts_with(L"c:\\program files (x86)\\");
            if (!system && !installed) return false;
            if (!system && fileName != L"code.exe" && fileName != L"eclipse.exe" && !jetbrains_.contains(fileName)) return false;
            const auto signature = ReadSigner(path, key);
            static const std::regex organizationPattern(R"attr((?:^|,\s*)O=(?:"([^"]+)"|([^,]+)))attr", std::regex::icase);
            static const std::regex namePattern(R"attr((?:^|,\s*)CN=(?:"([^"]+)"|([^,]+)))attr", std::regex::icase);
            const auto organization = SubjectAttribute(signature, organizationPattern), name = SubjectAttribute(signature, namePattern);
            if (system || fileName == L"code.exe") return organization == "Microsoft Corporation" &&
                (name == "Microsoft Windows" || name == "Microsoft Corporation" || name == "Microsoft Windows Publisher");
            if (jetbrains_.contains(fileName)) return organization == "JetBrains s.r.o." && name == organization;
            return fileName == L"eclipse.exe" && organization == "Eclipse Foundation, Inc." && name == organization;
        } catch (...) { return false; }
    }
};

std::string Hostname() {
    wchar_t name[256]{};
    DWORD size = static_cast<DWORD>(std::size(name));
    if (!GetComputerNameExW(ComputerNameDnsHostname, name, &size)) return {};
    return Utf8(std::wstring_view(name, size));
}

std::string DeviceId(const fs::path& directory) {
    fs::create_directories(directory);
    const auto path = directory / L"device-id";
    if (fs::exists(path)) {
        std::ifstream input(path, std::ios::binary);
        std::array<char, 1024> bytes{};
        input.read(bytes.data(), bytes.size());
        static const std::regex uuid(R"([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})", std::regex::icase);
        const auto saved = Trim(std::string_view(bytes.data(), static_cast<std::size_t>(input.gcount())));
        if (input.eof() && std::regex_match(saved, uuid)) return saved;
    }
    const auto uuid = StringUuid();
    auto temporary = path;
    temporary += Wide("." + StringUuid() + ".tmp");
    Handle output(CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (output.get() == INVALID_HANDLE_VALUE) throw std::runtime_error("无法保存设备标识");
    DWORD count = 0;
    const auto saved = WriteFile(output.get(), uuid.data(), static_cast<DWORD>(uuid.size()), &count, nullptr);
    output.reset();
    if (saved && count == uuid.size() && MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return uuid;
    DeleteFileW(temporary.c_str());
    throw std::runtime_error("无法保存设备标识");
}

Json ReadVmSignals(const fs::path& probe) {
    const auto result = Run(probe, {L"hardware"});
    if (result.code || Trim(result.output).empty()) throw std::runtime_error("未读取到设备信息");
    auto text = Trim(result.output);
    if (text.starts_with("\xef\xbb\xbf")) text.erase(0, 3);
    const auto rows = Split(text, '\n');
    if (rows.size() != 2 || ParseCsv(rows[0]) != std::vector<std::string>{"Manufacturer", "Model"}) throw std::runtime_error("设备型号信息不完整");
    const auto details = ParseCsv(rows[1]);
    if (details.size() != 2 || (details[0].empty() && details[1].empty())) throw std::runtime_error("设备型号信息不完整");
    const auto combined = Lower(details[0] + " " + details[1]);
    Json signals = Json::array();
    for (const std::string name : {"vmware", "virtualbox", "innotek", "parallels", "qemu", "hyper-v", "kvm", "xen", "bhyve", "bochs"}) {
        if ((name == "kvm" || name == "xen") ? std::regex_search(combined, std::regex("\\b" + name + "\\b")) : combined.find(name) != std::string::npos)
            signals.push_back(name);
    }
    if (combined.find("microsoft") != std::string::npos && combined.find("virtual machine") != std::string::npos &&
        std::find(signals.begin(), signals.end(), "hyper-v") == signals.end()) signals.push_back("hyper-v");
    return signals;
}

std::string ActiveWindow() {
    const HWND foreground = GetForegroundWindow();
    if (!foreground) return {};
    std::wstring title(32768, L'\0');
    DWORD process = 0;
    GetWindowThreadProcessId(foreground, &process);
    DWORD_PTR count = 0;
    if (process == GetCurrentProcessId()) {
        // The same-process form of GetWindowText waits for the UI thread.
        if (!SendMessageTimeoutW(foreground, WM_GETTEXT, title.size(), reinterpret_cast<LPARAM>(title.data()),
                                SMTO_ABORTIFHUNG | SMTO_BLOCK, 200, &count) && IsWindow(foreground))
            throw std::runtime_error("活动窗口检测报告无效");
    } else {
        SetLastError(ERROR_SUCCESS);
        count = GetWindowTextW(foreground, title.data(), static_cast<int>(title.size()));
        if (!count && GetLastError() != ERROR_SUCCESS && IsWindow(foreground))
            throw std::runtime_error("活动窗口检测报告无效");
    }
    title.resize(std::min<std::size_t>(count, title.size() - 1));
    return Trim(Utf8(title));
}

bool OpenPrivacyPane(const std::string& pane) {
    static const std::map<std::string, const wchar_t*> urls{
        {"camera", L"ms-settings:privacy-webcam"}, {"microphone", L"ms-settings:privacy-microphone"}, {"network", L"ms-settings:network-status"}
    };
    const auto found = urls.find(pane);
    if (found == urls.end()) throw std::runtime_error("未知的系统权限页面");
    const auto initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    SHELLEXECUTEINFOW launch{};
    launch.cbSize = sizeof(launch);
    launch.fMask = SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC;
    launch.lpVerb = L"open";
    launch.lpFile = found->second;
    launch.nShow = SW_SHOWNORMAL;
    const bool result = ShellExecuteExW(&launch);
    if (SUCCEEDED(initialized)) CoUninitialize();
    if (!result) throw std::runtime_error("无法打开系统权限页面");
    return true;
}

template<typename Work>
std::optional<Json> Read(Work work) {
    try { return work(); }
    catch (...) { return std::nullopt; }
}
}

struct NativeWindows::State {
    fs::path resources, userData, probe;
    std::string version;
    std::mutex diagnostics, deviceMutex, vmMutex, elevationMutex;
    Json vm;
    bool elevated = false;
    bool packaged;
    SharedWork<ProcessEntries> processWork;
    SharedWork<Json> capabilitiesWork;
    ProcessPolicy processPolicy;
    UsbMonitor usb;
    DomainMonitor domains;

    State(fs::path dir, fs::path data, std::string appVersion, const fs::path& runtime, bool isPackaged)
        : resources(std::move(dir)), userData(std::move(data)), probe(resources / L"security/inventory-probe.exe"), version(std::move(appVersion)),
          packaged(isPackaged), processPolicy(resources, runtime), usb(probe, [this](const std::string& detail) { Log("usb-events", detail); }) {}

    void Log(std::string_view event, std::string_view detail) {
        try {
            const std::lock_guard lock(diagnostics);
            const auto directory = userData / L"logs";
            fs::create_directories(directory);
            const auto path = directory / L"startup.log";
            std::error_code error;
            const auto size = fs::file_size(path, error);
            auto file = std::ofstream(path, !error && size > 512 * 1024 ? std::ios::trunc : std::ios::app);
            SYSTEMTIME now{};
            GetSystemTime(&now);
            file << std::setfill('0') << std::setw(4) << now.wYear << '-' << std::setw(2) << now.wMonth << '-' << std::setw(2) << now.wDay
                 << 'T' << std::setw(2) << now.wHour << ':' << std::setw(2) << now.wMinute << ':' << std::setw(2) << now.wSecond
                 << '.' << std::setw(3) << now.wMilliseconds << "Z v" << version << " win32/" << PROCTOR_ARCH
                 << ' ' << event << ": " << detail << '\n';
        } catch (...) { }
    }
    std::string Elevation() {
        const std::lock_guard lock(elevationMutex);
        if (elevated) return "elevated";
        try {
            const auto status = Run(resources / L"security/token-probe.exe", {std::to_wstring(GetCurrentProcessId())}, 10s).code;
            if (status == 0) {
                elevated = true;
                return "elevated";
            }
            if (status == 10) return "standard";
        } catch (...) { }
        return "unavailable";
    }
    ProcessEntries Processes() { return processWork([&] { return ReadProcesses(probe); }); }
    Json VmSignals() {
        const std::lock_guard lock(vmMutex);
        if (vm.is_null()) vm = ReadVmSignals(probe);
        return vm;
    }
    Json DesktopInfo() {
        const std::lock_guard lock(deviceMutex);
        return {{"deviceId", DeviceId(userData)}, {"hostname", Hostname()}, {"os", "win32 " + OsRelease()}, {"clientVersion", version}};
    }
    Json ReadPeripheral() {
        try { return {{"peripheralsFingerprint", usb.Fingerprint()}, {"peripheralScanOk", true}}; }
        catch (const std::exception& error) {
            Log("peripheral-scan-failed", error.what());
            return {{"peripheralScanOk", false}};
        }
    }
    Json Capabilities() {
        return capabilitiesWork([this] {
            auto hardware = std::async(std::launch::async, [this] { return ReadPeripheral(); });
            auto processes = std::async(std::launch::async, [this] {
                try { Processes(); return true; }
                catch (const std::exception& error) { Log("process-scan-failed", error.what()); return false; }
            });
            auto vmSignals = std::async(std::launch::async, [this] {
                try { return VmSignals(); }
                catch (const std::exception& error) { Log("vm-scan-failed", error.what()); return Json(); }
            });
            const auto elevationStatus = Elevation();
            bool windowOk = true;
            try { ActiveWindow(); }
            catch (const std::exception& error) { Log("window-scan-failed", error.what()); windowOk = false; }
            const auto fingerprint = hardware.get();
            const auto vm = vmSignals.get();
            const auto networkStatus = domains.Status();
            const auto networkState = networkStatus.at("state");
            const auto processOk = processes.get(), hardwareOk = fingerprint.at("peripheralScanOk").get<bool>();
            Json value{
                {"platform", "win32"}, {"elevated", elevationStatus == "elevated"}, {"elevationStatus", elevationStatus},
                {"processScan", processOk}, {"processScanMessage", processOk ? "" : "进程列表读取失败，请重试；已授权时请检查系统检测组件或安全软件拦截。"},
                {"networkScan", networkState == "ready" || networkState == "limited"}, {"networkDomainStatus", networkStatus},
                {"hardwareScan", hardwareOk}, {"hardwareScanMessage", hardwareOk ? "" : "外设信息读取失败，请重新检测，并检查安全软件是否隔离了检测组件。"},
                {"vmScan", !vm.is_null()}, {"vmScanMessage", vm.is_null() ? "设备型号读取失败，请重新检测，并检查客户端检测组件。" : ""},
                {"activeWindow", windowOk}, {"activeWindowMessage", windowOk ? "" : "活动窗口读取失败，请重新检测，并检查客户端检测组件。"}
            };
            if (hardwareOk) value["peripheralsFingerprint"] = fingerprint.at("peripheralsFingerprint");
            if (!vm.is_null()) value["vmSignals"] = vm;
            return value;
        });
    }
    Json Snapshot(const Json& allowedHosts, bool includePeripherals) {
        auto process = std::async(std::launch::async, [this] { return Read([&] { return processPolicy.Disallowed(Processes()); }); });
        std::future<Json> hardware;
        if (includePeripherals) hardware = std::async(std::launch::async, [this] { return ReadPeripheral(); });
        const auto title = Read(ActiveWindow);
        // The initial permission check normally cached this by the time exam
        // heartbeats run. A slow retry can still overlap both inventory jobs.
        auto vm = Read([&] { return VmSignals(); });
        auto value = hardware.valid() ? hardware.get() : Json::object();
        value["allowedNetworkRemotes"] = allowedHosts.is_array() ? allowedHosts : Json::array();
        value["networkRemotes"] = domains.Snapshot(allowedHosts);
        value["networkDomainStatus"] = domains.Status();
        if (title) value["activeWindow"] = *title;
        if (auto result = process.get()) value["disallowedProcesses"] = std::move(*result);
        if (vm) value["vmSignals"] = std::move(*vm);
        return value;
    }
};

NativeWindows::NativeWindows(fs::path resources, fs::path userData, std::string version, fs::path fixedRuntime, bool packaged)
    : state_(std::make_unique<State>(std::move(resources), std::move(userData), std::move(version), fixedRuntime, packaged)) {}
NativeWindows::~NativeWindows() = default;
void NativeWindows::SetUsbEnabled(bool enabled) { state_->usb.SetEnabled(enabled); }
void NativeWindows::StopUsb() { SetUsbEnabled(false); }
void NativeWindows::StopDomains() { state_->domains.Stop(); }
std::string NativeWindows::ElevationStatus() { return state_->Elevation(); }

bool NativeWindows::Relaunch() {
    DWORD status;
    try {
        status = Run(state_->resources / L"security/elevate-client.exe", {ExecutablePath().wstring(), L"--proctor-elevated-relaunch"}, 120s,
                     4 * 1024 * 1024, false).code;
    } catch (...) { status = 20; }
    if (status == 0) return true;
    if (status == 10) return false;
    throw std::runtime_error("管理员授权组件无法启动，请重新安装完整客户端或右键选择“以管理员身份运行”。");
}

Json NativeWindows::Handle(std::string_view channel, const Json& args, std::string_view mode) {
    if (channel == "system:getInfo") return state_->DesktopInfo();
    if (channel == "permissions:getMacMediaAccessStatus") return nullptr;
    if (channel == "permissions:openMacPrivacyPane") return false;
    if (channel == "permissions:askMacMediaAccess" || channel == "permissions:promptMacAccessibility") return true;
    if (channel == "permissions:openWindowsPrivacyPane") return OpenPrivacyPane(args.at(0).get<std::string>());
    if (channel == "permissions:getSystemPermissionStatus") return {
        {"platform", "win32"}, {"accessibility", true}, {"bundleId", "org.cwnupaa.proctor"},
        {"appName", "程序设计算法协会监考客户端"}, {"execPath", Utf8(ExecutablePath().wstring())}, {"isPackaged", state_->packaged},
        {"media", {{"camera", DeviceAccess(Devices::DeviceClass_VideoCapture)},
                    {"microphone", DeviceAccess(Devices::DeviceClass_AudioCapture)}, {"screen", "granted"}}}
    };
    if (channel == "security:capabilities") return state_->Capabilities();
    if (channel == "security:snapshot") return state_->Snapshot(args.empty() ? Json::array() : args[0], args.size() < 2 || args[1] != false);
    if (channel == "security:peripherals") return state_->ReadPeripheral();
    if (channel == "permissions:requestNetworkDomain" || channel == "security:startDomainMonitor") return state_->domains.Start();
    if (channel == "security:stopDomainMonitor") { StopDomains(); return nullptr; }
    if (channel == "security:resetDomains") { state_->domains.Reset(); return nullptr; }
    if (channel == "security:watchUsb") {
        if (mode == "setup" || args.empty() || !args[0].is_string() || args[0].get_ref<const std::string&>().empty() ||
            Wide(args[0].get_ref<const std::string&>()).size() > 191) throw std::runtime_error("请先登录考试再启用 USB 检测");
        const auto baseline = args.size() > 1 && args[1].is_string() ? args[1].get<std::string>() : std::string{};
        state_->usb.Watch(args[0].get<std::string>(), baseline);
        return nullptr;
    }
    if (channel == "security:readUsb") {
        if (mode == "setup" || args.empty() || !args[0].is_string()) return {{"available", false}, {"events", Json::array()}};
        return state_->usb.Read(args[0].get<std::string>());
    }
    if (channel == "security:ackUsb") {
        if (args.size() >= 2 && args[0].is_string()) state_->usb.Acknowledge(args[0].get<std::string>(), args[1]);
        return nullptr;
    }
    if (channel == "security:confirmPeripheralBaseline") {
        // The frame checks screen display and current publishers before and
        // after waiting here. This service also checks the received window mode.
        if (mode != "setup") throw std::runtime_error("请先结束当前考试或屏幕展示，再检测登录设备");
        return state_->usb.ConfirmBaseline();
    }
    throw std::runtime_error("未知的 Windows 本地调用");
}
}
