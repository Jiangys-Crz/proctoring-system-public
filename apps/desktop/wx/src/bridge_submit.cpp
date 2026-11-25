#include "bridge_internal.hpp"

#ifdef _WIN32
#include <windows.h>
#include <sddl.h>
#include <shlobj.h>
#include <tlhelp32.h>
#else
#include <crt_externs.h>
#include <fcntl.h>
#include <pwd.h>
#include <signal.h>
#include <spawn.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <thread>
#endif

#include <array>
#include <cmath>
#include <regex>
#include <utility>
#include <vector>

namespace proctor::bridge_detail {
namespace {

constexpr std::string_view kOwner = "novajudge-proctor-desktop";
const std::regex kDeviceToken(R"(^njcli_[A-Za-z0-9_-]{43}$)");
const std::regex kJwt(R"(^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$)");
const std::regex kKey(R"(^[A-Za-z0-9_-]{43}$)");

#ifdef _WIN32
struct Handle {
    HANDLE value = nullptr;
    ~Handle() { Close(); }
    void Close() {
        if (value && value != INVALID_HANDLE_VALUE) CloseHandle(std::exchange(value, nullptr));
    }
};
struct Local {
    HLOCAL value = nullptr;
    ~Local() { if (value) LocalFree(value); }
};
#else
struct FileDescriptor {
    int value = -1;
    ~FileDescriptor() { Close(); }
    void Close() { if (value >= 0) close(std::exchange(value, -1)); }
};
#endif

struct SubmitFailure : std::runtime_error {
    explicit SubmitFailure(std::string code) : std::runtime_error("提交服务失败"), code(std::move(code)) {}
    std::string code;
};

std::string FriendlyFailure(const std::exception& failure) {
    if (const auto* error = dynamic_cast<const SubmitFailure*>(&failure)) {
        if (error->code == "WINDOWS_USER_MISMATCH")
            return "submit 需要监考客户端与终端使用同一 Windows 账号。请使用当前桌面账号完成管理员授权后重新登录。网页比赛不受影响。";
        if (error->code == "CLI_DISABLED" || error->code == "CONTEST_CHANGED")
            return "submit 暂不可用：请管理员将当前考试设为 NovaJudge 的命令行比赛，然后重试。网页比赛不受影响。";
        if (error->code == "PROCTORING_AUTH_REQUIRED" || error->code == "PROCTORING_CLIENT_REQUIRED")
            return "submit 监考授权已失效，请重新登录 NovaJudge。网页比赛不受影响。";
        if (error->code == "CONTEST_PASSWORD_REQUIRED")
            return "submit 缺少有效的私有赛授权，请联系管理员。网页比赛不受影响。";
    }
    return "submit 准备失败，网页比赛不受影响。可点击“重新准备 submit”重试。";
}

std::string ExactOrigin(std::string_view origin) {
    const auto parsed = ParseHttpUrl(origin);
    if (parsed.origin != origin || parsed.path != "/" || !parsed.query.empty() || !parsed.fragment.empty())
        throw std::runtime_error("提交服务地址无效");
    return parsed.origin;
}

#ifdef _WIN32
std::vector<std::byte> UserToken(HANDLE process) {
    Handle token;
    if (!OpenProcessToken(process, TOKEN_QUERY, &token.value)) throw SubmitFailure("WINDOWS_USER_MISMATCH");
    DWORD bytes = 0;
    GetTokenInformation(token.value, TokenUser, nullptr, 0, &bytes);
    if (!bytes) throw SubmitFailure("WINDOWS_USER_MISMATCH");
    std::vector<std::byte> result(bytes);
    if (!GetTokenInformation(token.value, TokenUser, result.data(), bytes, &bytes)) throw SubmitFailure("WINDOWS_USER_MISMATCH");
    return result;
}

PSID SidOf(std::vector<std::byte>& token) {
    return reinterpret_cast<TOKEN_USER*>(token.data())->User.Sid;
}

fs::path UserProfile() {
    std::array<wchar_t, MAX_PATH> path{};
    if (FAILED(SHGetFolderPathW(nullptr, CSIDL_PROFILE, nullptr, SHGFP_TYPE_CURRENT, path.data()))) return {};
    return fs::path(path.data());
}

void AssertInteractiveUser() {
    auto user = UserToken(GetCurrentProcess());
    const DWORD pid = GetCurrentProcessId();
    DWORD session = 0;
    if (!ProcessIdToSessionId(pid, &session)) throw SubmitFailure("WINDOWS_USER_MISMATCH");

    Handle processes{ CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    PROCESSENTRY32W process{};
    process.dwSize = sizeof(process);
    if (processes.value == INVALID_HANDLE_VALUE || !Process32FirstW(processes.value, &process))
        throw SubmitFailure("WINDOWS_USER_MISMATCH");

    bool shell = false;
    do {
        if (_wcsicmp(process.szExeFile, L"explorer.exe") != 0) continue;
        DWORD shellSession = 0;
        if (!ProcessIdToSessionId(process.th32ProcessID, &shellSession) || shellSession != session) continue;
        Handle owner{ OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process.th32ProcessID) };
        if (!owner.value) throw SubmitFailure("WINDOWS_USER_MISMATCH");
        auto ownerToken = UserToken(owner.value);
        if (!EqualSid(SidOf(user), SidOf(ownerToken))) throw SubmitFailure("WINDOWS_USER_MISMATCH");
        shell = true;
    } while (Process32NextW(processes.value, &process));
    if (!shell || UserProfile().empty()) throw SubmitFailure("WINDOWS_USER_MISMATCH");
}

void InstallCli(const fs::path& directory, std::string_view origin, const std::function<bool()>& current) {
    AssertInteractiveUser();
    const auto executable = SystemDirectory() / L"WindowsPowerShell" / L"v1.0" / L"powershell.exe";
    const auto script = directory / L"install-windows.ps1";
    if (!fs::is_regular_file(script)) throw std::runtime_error("submit 安装组件缺失");
    auto command = Quote(executable.wstring()) + L" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " +
        Quote(script.wstring()) + L" -Url " + Quote(Wide(origin)) + L" -SourceDir " + Quote(directory.wstring());
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                        nullptr, nullptr, &startup, &process)) throw std::runtime_error("submit 安装失败");
    Handle child{ process.hProcess };
    Handle thread{ process.hThread };
    const auto deadline = Clock::now() + std::chrono::seconds(30);
    while (WaitForSingleObject(child.value, 50) == WAIT_TIMEOUT) {
        if (!current() || Clock::now() > deadline) {
            TerminateProcess(child.value, 1);
            WaitForSingleObject(child.value, 1000);
            throw std::runtime_error("submit 安装已取消");
        }
    }
    DWORD code = 1;
    if (!GetExitCodeProcess(child.value, &code) || code != 0) throw std::runtime_error("submit 安装失败");
}
#else
fs::path UserProfile() {
    std::array<char, 16384> buffer{};
    passwd entry{};
    passwd* result = nullptr;
    if (getpwuid_r(getuid(), &entry, buffer.data(), buffer.size(), &result) != 0 ||
        !result || !entry.pw_dir || entry.pw_dir[0] != '/') return {};
    return fs::path(entry.pw_dir);
}

void InstallCli(const fs::path& directory, std::string_view origin, const std::function<bool()>& current) {
    const auto home = UserProfile();
    if (geteuid() != getuid() || geteuid() == 0 || home.empty()) throw std::runtime_error("无法读取用户目录");
    const auto script = directory / "install-macos.sh";
    const auto source = directory / "submit-macos";
    if (!fs::is_regular_file(fs::symlink_status(script)) || !fs::is_regular_file(fs::symlink_status(source)))
        throw std::runtime_error("submit 安装组件缺失");
    std::array<std::string, 6> arguments{"/bin/bash", script.string(), "--url", std::string(origin), "--source", source.string()};
    std::array<char*, 7> argv{};
    for (std::size_t index = 0; index < arguments.size(); ++index) argv[index] = arguments[index].data();

    std::vector<std::string> environment{"HOME=" + home.string(), "PATH=/usr/bin:/bin:/usr/sbin:/sbin"};
    for (auto** entry = *_NSGetEnviron(); entry && *entry; ++entry) {
        const std::string_view value(*entry);
        if (!value.starts_with("HOME=") && !value.starts_with("PATH=")) environment.emplace_back(value);
    }
    std::vector<char*> envp;
    for (auto& entry : environment) envp.push_back(entry.data());
    envp.push_back(nullptr);

    struct SpawnActions {
        posix_spawn_file_actions_t value{};
        ~SpawnActions() { if (value) posix_spawn_file_actions_destroy(&value); }
    } actions;
    struct SpawnAttributes {
        posix_spawnattr_t value{};
        ~SpawnAttributes() { if (value) posix_spawnattr_destroy(&value); }
    } attributes;
    if (posix_spawn_file_actions_init(&actions.value) || posix_spawnattr_init(&attributes.value) ||
        posix_spawn_file_actions_addopen(&actions.value, STDIN_FILENO, "/dev/null", O_RDONLY, 0) ||
        posix_spawn_file_actions_addopen(&actions.value, STDOUT_FILENO, "/dev/null", O_WRONLY, 0) ||
        posix_spawn_file_actions_adddup2(&actions.value, STDOUT_FILENO, STDERR_FILENO) ||
        posix_spawnattr_setflags(&attributes.value, POSIX_SPAWN_SETPGROUP) ||
        posix_spawnattr_setpgroup(&attributes.value, 0)) throw std::runtime_error("submit 安装失败");

    pid_t child = 0;
    if (posix_spawn(&child, argv.front(), &actions.value, &attributes.value, argv.data(), envp.data()))
        throw std::runtime_error("submit 安装失败");
    const auto deadline = Clock::now() + std::chrono::seconds(30);
    int status = 0;
    for (;;) {
        const auto result = waitpid(child, &status, WNOHANG);
        if (result == child) break;
        if (result < 0 && errno != EINTR) throw std::runtime_error("submit 安装失败");
        if (!current() || Clock::now() > deadline) {
            kill(-child, SIGTERM);
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
            if (waitpid(child, &status, WNOHANG) == 0) {
                kill(-child, SIGKILL);
                while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
            }
            throw std::runtime_error("submit 安装已取消");
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) throw std::runtime_error("submit 安装失败");
}
#endif

std::string Hex(std::string_view bytes) {
    std::string text;
    for (const unsigned char byte : bytes) {
        text += "0123456789abcdef"[byte >> 4];
        text += "0123456789abcdef"[byte & 15];
    }
    return text;
}

std::int64_t Now() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

std::int64_t Expiry(std::string_view value) {
    static const std::regex pattern(R"(^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$)");
    std::match_results<std::string_view::const_iterator> match;
    if (!std::regex_match(value.begin(), value.end(), match, pattern)) return 0;
#ifdef _WIN32
    const auto part = [&match](int i) { return static_cast<WORD>(match[i].matched ? std::stoi(match[i].str()) : 0); };
    SYSTEMTIME date{ part(1), part(2), 0, part(3), part(4), part(5), part(6), part(7) };
    FILETIME timestamp{};
    if (!SystemTimeToFileTime(&date, &timestamp)) return 0;
    ULARGE_INTEGER ticks{};
    ticks.LowPart = timestamp.dwLowDateTime;
    ticks.HighPart = timestamp.dwHighDateTime;
    return static_cast<std::int64_t>(ticks.QuadPart / 10000) - 11644473600000LL;
#else
    using namespace std::chrono;
    const auto part = [&match](int i) { return match[i].matched ? std::stoi(match[i].str()) : 0; };
    const auto date = year(part(1)) / part(2) / part(3);
    if (!date.ok() || part(4) > 23 || part(5) > 59 || part(6) > 59) return 0;
    return duration_cast<milliseconds>(sys_days(date).time_since_epoch() +
        hours(part(4)) + minutes(part(5)) + seconds(part(6)) + milliseconds(part(7))).count();
#endif
}

struct LoginIdentity {
    std::string username;
    double expiry;
    std::uint64_t contestId;
};

LoginIdentity Identity(const Bridge::NovaJudgeLogin& login) {
    const auto contestId = PositiveId(login.contestId);
    if (!contestId || login.cookieToken.size() > 8192 || !std::regex_match(login.cookieToken, kJwt) ||
        !std::regex_match(login.proctoringKey, kKey)) throw std::runtime_error("监考登录凭据无效");
    const auto first = login.cookieToken.find('.');
    const auto last = login.cookieToken.rfind('.');
    const auto payload = std::string_view(login.cookieToken).substr(first + 1, last - first - 1);
    const auto claims = Parse(DecodeBase64(payload, true));
    const auto username = Text(claims, "username");
    if (Text(claims, "role") != "TEAM" || Text(claims, "loginSource") != "PROCTORING" ||
        claims.value("contestId", Json()) != *contestId || username.empty() || username.size() > 800 ||
        Text(claims, "proctoringKeyHash") != Hex(Hash(login.proctoringKey, false)) ||
        !claims.contains("exp") || !claims.at("exp").is_number()) throw std::runtime_error("监考登录与当前比赛不匹配");
    const auto expiry = claims.at("exp").get<double>() * 1000.0;
    if (!std::isfinite(expiry) || expiry <= static_cast<double>(Now())) throw std::runtime_error("监考登录已过期");
    if (!login.contestAccessToken.is_null()) {
        if (!login.contestAccessToken.is_string()) throw std::runtime_error("私有赛授权无效");
        const auto& token = login.contestAccessToken.get_ref<const std::string&>();
        if (token.empty() || token.size() > 8192 || token.find_first_of("\r\n") != std::string::npos)
            throw std::runtime_error("私有赛授权无效");
    }
    return { username, expiry, *contestId };
}

Json PolicyGrant(const Bridge::NovaJudgeLogin& login, const LoginIdentity& identity, std::string& issuedToken) {
    Json headers = { { "Authorization", "Bearer " + login.cookieToken }, { "x-novajudge-proctor-key", login.proctoringKey },
                     { "Accept", "application/json" }, { "Content-Type", "application/json" } };
    if (login.contestAccessToken.is_string()) headers["x-contest-access-token"] = login.contestAccessToken;
    const auto response = RequestHttp(login.origin + "/api/cli/device/proctoring", "POST", headers, "{}", 5000, 64 * 1024);
    const auto grant = Parse(response.body);
    if (response.status < 200 || response.status >= 300) throw SubmitFailure(Text(grant, "code"));
    const auto token = Text(grant, "deviceToken");
    if (std::regex_match(token, kDeviceToken)) issuedToken = token;
    if (issuedToken.empty() || Text(grant, "loginSource") != "PROCTORING" || !grant.contains("contest") ||
        !grant.contains("user")) throw std::runtime_error("提交授权与当前比赛或队伍不匹配");
    const auto& contest = grant.at("contest");
    const auto& user = grant.at("user");
    const auto expires = Text(grant, "expiresAt");
    const auto expiration = Expiry(expires);
    if (!contest.is_object() || contest.value("id", Json()) != identity.contestId || Text(contest, "title").empty() ||
        Text(user, "username") != identity.username || !user.contains("displayName") ||
        !(user.at("displayName").is_null() || user.at("displayName").is_string()) ||
        expiration <= Now() || static_cast<double>(expiration) > identity.expiry)
        throw std::runtime_error("提交授权与当前比赛或队伍不匹配");
    return {
        { "deviceToken", token }, { "loginSource", "PROCTORING" }, { "expiresAt", expires },
        { "contest", { { "id", identity.contestId }, { "title", contest.at("title") } } },
        { "user", { { "username", identity.username }, { "displayName", user.at("displayName") } } }
    };
}

}  // namespace

Submit::Submit(fs::path resources, StatusPublisher publish, const std::atomic<bool>& stopping)
    : resources_(std::move(resources)), publish_(std::move(publish)), stopping_(stopping), instance_(RandomHex()) {
    const auto home = UserProfile();
    if (!home.empty()) configFile_ = home / ".novajudge-submit.json";
    status_ = { { "phase", "idle" }, { "message", "" } };
}

Json Submit::Status() const {
    std::lock_guard lock(mutex_);
    return status_;
}

void Submit::SetLocked(Json value) {
    status_ = std::move(value);
    publish_(status_);
}

Json Submit::ReadOwned() const {
    if (configFile_.empty()) return nullptr;
#ifdef _WIN32
    Handle file{ CreateFileW(configFile_.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE,
                             nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr) };
    if (file.value == INVALID_HANDLE_VALUE) return nullptr;
    BY_HANDLE_FILE_INFORMATION information{};
    if (!GetFileInformationByHandle(file.value, &information) ||
        (information.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) ||
        information.nFileSizeHigh != 0 || information.nFileSizeLow > 64 * 1024) return nullptr;
    std::string text(information.nFileSizeLow, '\0');
    DWORD bytes = 0;
    if (!ReadFile(file.value, text.data(), static_cast<DWORD>(text.size()), &bytes, nullptr) || bytes != text.size()) return nullptr;
#else
    FileDescriptor file{open(configFile_.c_str(), O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW)};
    struct stat info{};
    if (file.value < 0 || fstat(file.value, &info) || !S_ISREG(info.st_mode) || info.st_uid != geteuid() ||
        info.st_size < 1 || info.st_size > 64 * 1024) return nullptr;
    std::string text(static_cast<std::size_t>(info.st_size), '\0');
    std::size_t offset = 0;
    while (offset < text.size()) {
        const auto count = read(file.value, text.data() + offset, text.size() - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return nullptr;
        offset += static_cast<std::size_t>(count);
    }
#endif
    try {
        auto state = Parse(text);
        if (Text(state, "managedBy") != kOwner || Text(state, "managedInstance").empty() ||
            !std::regex_match(Text(state, "deviceToken"), kDeviceToken) || Text(state, "loginSource") != "PROCTORING") return nullptr;
        ExactOrigin(Text(state, "baseUrl"));
        return state;
    } catch (...) { return nullptr; }
}

void Submit::RemoveOwned(const Json& config) const {
    const auto current = ReadOwned();
    if (!current.is_null() && current.at("deviceToken") == config.at("deviceToken") &&
        current.at("managedInstance") == config.at("managedInstance")) {
#ifdef _WIN32
        DeleteFileW(configFile_.c_str());
#else
        unlink(configFile_.c_str());
#endif
    }
}

void Submit::WriteOwned(const Json& config) const {
    if (configFile_.empty()) throw std::runtime_error("无法读取用户目录");
#ifdef _WIN32
    const auto existing = GetFileAttributesW(configFile_.c_str());
    if (existing != INVALID_FILE_ATTRIBUTES && (existing & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)))
        throw std::runtime_error("submit 配置路径不是普通文件");

    auto user = UserToken(GetCurrentProcess());
    LPWSTR sid = nullptr;
    if (!ConvertSidToStringSidW(SidOf(user), &sid)) throw std::runtime_error("提交授权文件权限设置失败");
    Local sidBuffer{ sid };
    const std::wstring acl = L"O:" + std::wstring(sid) + L"D:P(A;;FA;;;" + sid + L")";
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(acl.c_str(), SDDL_REVISION_1, &descriptor, nullptr))
        throw std::runtime_error("提交授权文件权限设置失败");
    Local descriptorBuffer{ descriptor };
    SECURITY_ATTRIBUTES attributes{ sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE };
    auto temporary = configFile_;
    temporary += L"." + Wide(RandomHex()) + L".tmp";
    Handle file{ CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, &attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr) };
    if (file.value == INVALID_HANDLE_VALUE) throw std::runtime_error("无法保存提交授权");
    try {
        const auto text = config.dump(2) + '\n';
        DWORD written = 0;
        if (!WriteFile(file.value, text.data(), static_cast<DWORD>(text.size()), &written, nullptr) ||
            written != text.size() || !FlushFileBuffers(file.value)) throw std::runtime_error("无法保存提交授权");
        file.Close();
        if (!MoveFileExW(temporary.c_str(), configFile_.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            throw std::runtime_error("无法保存提交授权");
    } catch (...) {
        file.Close();
        DeleteFileW(temporary.c_str());
        throw;
    }
#else
    struct stat existing{};
    if (lstat(configFile_.c_str(), &existing) == 0 &&
        (!S_ISREG(existing.st_mode) || existing.st_uid != geteuid())) throw std::runtime_error("submit 配置路径不是当前用户的普通文件");
    auto temporary = configFile_;
    temporary += "." + RandomHex() + ".tmp";
    FileDescriptor file{open(temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600)};
    if (file.value < 0) throw std::runtime_error("无法保存提交授权");
    try {
        const auto text = config.dump(2) + '\n';
        std::size_t offset = 0;
        while (offset < text.size()) {
            const auto count = write(file.value, text.data() + offset, text.size() - offset);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) throw std::runtime_error("无法保存提交授权");
            offset += static_cast<std::size_t>(count);
        }
        if (fsync(file.value)) throw std::runtime_error("无法保存提交授权");
        file.Close();
        if (rename(temporary.c_str(), configFile_.c_str())) throw std::runtime_error("无法保存提交授权");
    } catch (...) {
        unlink(temporary.c_str());
        throw;
    }
#endif
}

void Submit::Revoke(std::string_view origin, std::string_view token) const {
    try {
        const auto url = ExactOrigin(origin) + "/api/cli/device";
        RequestHttp(url, "DELETE", { { "Authorization", "Bearer " + std::string(token) },
                                   { "Accept", "application/json" } }, {}, 5000, 64 * 1024);
    } catch (...) { /* Local removal occurs even if the revoke cannot reach the server. */ }
}

void Submit::Initialize() {
    std::lock_guard lock(initializationMutex_);
    if (initialized_) return;
    initialized_ = true;
    const auto stale = ReadOwned();
    if (!stale.is_null()) {
        RemoveOwned(stale);
        Revoke(Text(stale, "baseUrl"), Text(stale, "deviceToken"));
    }
}

void Submit::ResetLocked(bool forgetLogin) {
    ++generation_;
    if (!owned_.is_null()) {
        RemoveOwned(owned_);
        revocations_.push_back(std::exchange(owned_, nullptr));
    }
    if (forgetLogin) login_.reset();
    SetLocked({ { "phase", "idle" }, { "message", "" } });
}

void Submit::Reset() {
    std::lock_guard lock(mutex_);
    ResetLocked(true);
}

std::uint64_t Submit::SelectLogin(Bridge::NovaJudgeLogin login) {
    std::lock_guard lock(mutex_);
    ResetLocked(true);
    login_ = std::move(login);
    SetLocked({ { "phase", "installing" }, { "message", "正在准备 submit / printfile 命令…" } });
    return generation_;
}

std::uint64_t Submit::PrepareRetry() {
    std::lock_guard lock(mutex_);
    if (!login_) return 0;
    ResetLocked(false);
    SetLocked({ { "phase", "installing" }, { "message", "正在准备 submit / printfile 命令…" } });
    return generation_;
}

void Submit::DrainRevocations() {
    std::vector<Json> pending;
    {
        std::lock_guard lock(mutex_);
        pending.swap(revocations_);
    }
    for (const auto& token : pending) Revoke(Text(token, "baseUrl"), Text(token, "deviceToken"));
}

void Submit::Connect(std::uint64_t generation) {
    std::lock_guard operation(operationMutex_);
    const auto current = [&] { return generation == generation_ && !stopping_; };
    Bridge::NovaJudgeLogin login;
    {
        std::lock_guard lock(mutex_);
        if (!current() || !login_) return;
        login = *login_;
    }
    std::string issuedToken;
    try {
        Initialize();
        DrainRevocations();
        if (!current()) return;
        ExactOrigin(login.origin);
        const auto identity = Identity(login);
        auto grant = PolicyGrant(login, identity, issuedToken);
        if (current()) InstallCli(resources_, login.origin, current);
        {
            std::lock_guard lock(mutex_);
            if (current()) {
                grant["baseUrl"] = login.origin;
                grant["managedBy"] = kOwner;
                grant["managedInstance"] = instance_;
                WriteOwned(grant);
                owned_ = std::move(grant);
                issuedToken.clear();
                SetLocked({ { "phase", "ready" },
                            { "message", "submit / printfile 已就绪：新开终端运行 submit A.cpp 或 printfile A.cpp；加 -y 自动确认，--help 查看用法。" } });
            }
        }
    } catch (const std::exception& error) {
        std::lock_guard lock(mutex_);
        if (current()) SetLocked({ { "phase", "error" }, { "message", FriendlyFailure(error) } });
    }
    if (!issuedToken.empty()) Revoke(login.origin, issuedToken);
}

void Submit::ClearNow() {
    std::lock_guard lock(mutex_);
    if (!owned_.is_null()) RemoveOwned(owned_);
}

}  // namespace proctor::bridge_detail
