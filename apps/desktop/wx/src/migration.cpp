#include "migration.hpp"
#include "bridge.hpp"

#include <objbase.h>
#include <shlwapi.h>
#include <wx/app.h>

#include <algorithm>
#include <array>
#include <cwctype>
#include <tuple>
#include <chrono>
#include <cmath>
#include <fstream>
#include <optional>
#include <regex>
#include <set>
#include <stdexcept>
#include <utility>

namespace proctor {
namespace {

constexpr wchar_t importMarker[] = L"legacy-electron-import-v2";
constexpr wchar_t priorImportMarker[] = L"legacy-electron-import-v1";
constexpr std::uintmax_t smallFileLimit = 1024 * 1024;
constexpr std::uintmax_t cookieFileLimit = 64 * smallFileLimit;

class File {
public:
    File() = default;
    explicit File(HANDLE handle) : handle_(handle) {}
    File(File&& other) noexcept : handle_(std::exchange(other.handle_, INVALID_HANDLE_VALUE)) {}
    File(const File&) = delete;
    ~File() { if (*this) CloseHandle(handle_); }
    explicit operator bool() const { return handle_ != INVALID_HANDLE_VALUE; }
    HANDLE get() const { return handle_; }
private:
    HANDLE handle_ = INVALID_HANDLE_VALUE;
};

bool PathExists(const fs::path& path, bool directory) {
    const auto attrs = GetFileAttributesW(path.c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES) {
        const auto error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return false;
        throw std::runtime_error("无法读取旧客户端数据目录");
    }
    if ((attrs & FILE_ATTRIBUTE_REPARSE_POINT) || ((attrs & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory) {
        throw std::runtime_error("旧客户端数据目录格式无效");
    }
    return true;
}

File OpenSource(const fs::path& path, DWORD share) {
    File file(CreateFileW(path.c_str(), GENERIC_READ, share, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
    BY_HANDLE_FILE_INFORMATION info{};
    if (!file || !GetFileInformationByHandle(file.get(), &info)
        || (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))) {
        throw std::runtime_error("旧客户端数据仍在使用或无法读取");
    }
    return file;
}

std::string ReadSource(const fs::path& path, std::uintmax_t limit) {
    const auto file = OpenSource(path, FILE_SHARE_READ);
    LARGE_INTEGER bytes{};
    if (!GetFileSizeEx(file.get(), &bytes) || bytes.QuadPart < 0 || static_cast<std::uintmax_t>(bytes.QuadPart) > limit) {
        throw std::runtime_error("旧客户端数据文件大小异常");
    }
    std::string content(static_cast<size_t>(bytes.QuadPart), '\0');
    DWORD actual = 0;
    if (!ReadFile(file.get(), content.data(), static_cast<DWORD>(content.size()), &actual, nullptr) || actual != content.size()) {
        throw std::runtime_error("旧客户端数据未完整读取");
    }
    return content;
}

void Save(const fs::path& path, std::string_view text) {
    fs::create_directories(path.parent_path());
    const auto file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("无法写入客户端迁移数据");
    const File output(file);
    DWORD wrote = 0;
    if (!WriteFile(output.get(), text.data(), static_cast<DWORD>(text.size()), &wrote, nullptr) || wrote != text.size()
        || !FlushFileBuffers(output.get())) throw std::runtime_error("无法保存客户端迁移数据");
}

void SaveOnce(const fs::path& path, std::string_view text) {
    GUID id{};
    Check(CoCreateGuid(&id), "Create migration file id");
    wchar_t suffix[40]{};
    StringFromGUID2(id, suffix, 40);
    const auto temporary = fs::path(path.wstring() + suffix + L".tmp");
    try {
        Save(temporary, text);
        if (MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_WRITE_THROUGH)) return;
        throw std::runtime_error("无法提交客户端迁移数据");
    } catch (...) {
        std::error_code error;
        fs::remove(temporary, error);
        throw;
    }
}

void CopySource(const fs::path& from, const fs::path& to, const std::atomic_bool& stopping) {
    if (stopping) throw std::runtime_error("客户端已关闭");
    fs::create_directories(to.parent_path());
    // A non-capturing lambda follows the default calling convention on x86,
    // whereas COPY_PROGRESS_ROUTINE requires WINAPI. Use the static adapter.
    struct Progress {
        static DWORD CALLBACK Check(LARGE_INTEGER total, LARGE_INTEGER copied, LARGE_INTEGER streamTotal,
            LARGE_INTEGER streamCopied, DWORD stream, DWORD reason, HANDLE input, HANDLE output, LPVOID data) {
            (void)total; (void)copied; (void)streamTotal; (void)streamCopied; (void)stream;
            (void)reason; (void)input; (void)output;
            return *static_cast<const std::atomic_bool*>(data) ? PROGRESS_CANCEL : PROGRESS_CONTINUE;
        }
    };
    if (!CopyFileExW(from.c_str(), to.c_str(), &Progress::Check,
        const_cast<std::atomic_bool*>(&stopping), nullptr, COPY_FILE_FAIL_IF_EXISTS)) {
        throw std::runtime_error("旧客户端数据快照未完成");
    }
}

File StorageLock(const fs::path& leveldb) {
    auto file = OpenSource(leveldb / L"LOCK", FILE_SHARE_READ | FILE_SHARE_WRITE);
    OVERLAPPED offset{};
    if (!LockFileEx(file.get(), LOCKFILE_FAIL_IMMEDIATELY | LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &offset)) {
        throw std::runtime_error("旧客户端正在使用本地数据，关闭旧客户端后会重新迁移");
    }
    return file;
}

void SnapshotFiles(const fs::path& from, const fs::path& to, const std::atomic_bool& stopping) {
    if (!PathExists(from, true)) return;
    for (const auto& entry : fs::directory_iterator(from)) {
        const auto path = entry.path();
        const auto attrs = GetFileAttributesW(path.c_str());
        if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_REPARSE_POINT)) {
            throw std::runtime_error("旧客户端本地数据目录格式无效");
        }
        if (attrs & FILE_ATTRIBUTE_DIRECTORY) SnapshotFiles(path, to / path.filename(), stopping);
        else if (path.filename() != L"LOCK") {
            const auto held = OpenSource(path, FILE_SHARE_READ);
            CopySource(path, to / path.filename(), stopping);
        }
    }
}

std::optional<fs::path> CookieStore(const fs::path& profile) {
    if (!PathExists(profile, true)) return {};
    if (PathExists(profile / L"Network", true) && PathExists(profile / L"Network/Cookies", false)) {
        return profile / L"Network/Cookies";
    }
    if (PathExists(profile / L"Cookies", false)) return profile / L"Cookies";
    return {};
}

std::string PartialLocalState(const fs::path& source) {
    if (!PathExists(source, false)) return {};
    const auto state = Json::parse(ReadSource(source, smallFileLimit), nullptr, false);
    if (!state.is_object() || !state.contains("os_crypt") || !state["os_crypt"].is_object()) return {};
    const auto key = state["os_crypt"].find("encrypted_key");
    if (key == state["os_crypt"].end() || !key->is_string() || key->get_ref<const std::string&>().size() > 16384) return {};
    return Json({{"os_crypt", {{"encrypted_key", *key}}}}).dump();
}

void SnapshotCookies(const fs::path& from, const fs::path& stage, std::string_view osState, const std::atomic_bool& stopping) {
    // The same user's original key stays encrypted at rest and is interpreted
    // by the browser. Unrelated Local State preferences and account data stay out.
    if (!osState.empty()) Save(stage / L"EBWebView/Local State", osState);
    const auto held = OpenSource(from, FILE_SHARE_READ);
    const auto to = stage / L"EBWebView/Default/Network/Cookies";
    LARGE_INTEGER length{};
    if (!GetFileSizeEx(held.get(), &length) || length.QuadPart < 0 ||
        static_cast<std::uintmax_t>(length.QuadPart) > cookieFileLimit) throw std::runtime_error("旧 Cookie 文件大小异常");
    CopySource(from, to, stopping);
    for (const auto* suffix : {L"-wal", L"-journal"}) {
        const fs::path pending(from.wstring() + suffix);
        if (!PathExists(pending, false)) continue;
        const auto locked = OpenSource(pending, FILE_SHARE_READ);
        if (!GetFileSizeEx(locked.get(), &length) || length.QuadPart < 0 ||
            static_cast<std::uintmax_t>(length.QuadPart) > cookieFileLimit) throw std::runtime_error("旧 Cookie 日志大小异常");
        CopySource(pending, to.wstring() + suffix, stopping);
    }
}

std::string FileUrl(const fs::path& path) {
    const auto bytes = Utf8(path.generic_wstring());
    if (bytes.size() < 4 || bytes[1] != ':' || bytes[2] != '/') throw std::runtime_error("迁移页面必须位于本机");
    constexpr auto hex = "0123456789ABCDEF";
    std::string url = "file:///";
    for (const unsigned char byte : bytes) {
        if ((byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z') || (byte >= '0' && byte <= '9')
            || byte == ':' || byte == '/' || byte == '-' || byte == '.' || byte == '_' || byte == '~') url += static_cast<char>(byte);
        else { url += '%'; url += hex[byte >> 4]; url += hex[byte & 15]; }
    }
    return url;
}

std::string Prefer(const Json& value, const char* name) {
    const auto it = value.find(name);
    if (it == value.end() || !it->is_string()) return {};
    const auto& text = it->get_ref<const std::string&>();
    return text.size() <= 2048 ? text : std::string();
}

Json ValidatePreferences(const Json& values) {
    Json result = Json::object();
    if (!values.is_object()) return result;
    const auto server = Prefer(values, "proctorServerUrl");
    if (!server.empty()) {
        try {
            const auto url = ParseHttpUrl(server);
            if (url.fragment.empty() && url.query.empty()) result["proctorServerUrl"] = url.Url();
        } catch (...) {}
    }
    const auto position = Json::parse(Prefer(values, "monitorPreviewPosition"), nullptr, false);
    const auto coordinate = [](const Json& node) {
        if (!node.is_number()) return false;
        const auto number = node.get<double>();
        return std::isfinite(number) && std::abs(number) < 100000.0;
    };
    if (position.is_object() && position.contains("left") && position.contains("top")
        && coordinate(position["left"]) && coordinate(position["top"])) {
        result["monitorPreviewPosition"] = Json({{"left", position["left"]}, {"top", position["top"]}}).dump();
    }
    const auto top = Json::parse(Prefer(values, "monitorPreviewRestoreTop"), nullptr, false);
    if (coordinate(top)) result["monitorPreviewRestoreTop"] = top.dump();
    return result;
}

Json Message(ICoreWebView2WebMessageReceivedEventArgs* args, std::wstring_view expected, size_t limit) {
    LPWSTR raw = nullptr;
    if (FAILED(args->get_Source(&raw)) || TakeString(raw) != expected) return nullptr;
    raw = nullptr;
    if (FAILED(args->get_WebMessageAsJson(&raw))) return nullptr;
    const auto data = TakeString(raw);
    if (data.size() > limit || data.find(L"\"migration\"") == std::wstring::npos) return nullptr;
    return Json::parse(Utf8(data), nullptr, false);
}

void InstallSourcePolicy(ICoreWebView2* core, ICoreWebView2Environment* environment, const std::wstring& allowed,
    bool synthetic = false) {
    EventRegistrationToken token{};
    auto navigate = On<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs*>(
        [allowed](ICoreWebView2*, auto args) {
            LPWSTR raw = nullptr;
            if (FAILED(args->get_Uri(&raw)) || TakeString(raw) != allowed) args->put_Cancel(TRUE);
        });
    auto frame = On<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs*>(
        [](ICoreWebView2*, auto args) { args->put_Cancel(TRUE); });
    auto popup = On<ICoreWebView2NewWindowRequestedEventHandler, ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs*>(
        [](ICoreWebView2*, auto args) { args->put_Handled(TRUE); });
    auto permission = On<ICoreWebView2PermissionRequestedEventHandler, ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs*>(
        [](ICoreWebView2*, auto args) { args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY); });
    auto resource = On<ICoreWebView2WebResourceRequestedEventHandler, ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs*>(
        [environment, allowed, synthetic](ICoreWebView2*, auto args) {
            ComPtr<ICoreWebView2WebResourceRequest> request;
            LPWSTR uri = nullptr;
            const bool exact = SUCCEEDED(args->get_Request(&request)) && request && SUCCEEDED(request->get_Uri(&uri))
                && TakeString(uri) == allowed;
            if (exact && !synthetic) return;
            ComPtr<ICoreWebView2WebResourceResponse> denied;
            if (exact) {
                constexpr char blank[] = "<!doctype html><meta charset=utf-8>";
                ComPtr<IStream> contents;
                contents.Attach(SHCreateMemStream(reinterpret_cast<const BYTE*>(blank), sizeof(blank) - 1));
                if (contents && SUCCEEDED(environment->CreateWebResourceResponse(contents.Get(), 200, L"OK",
                    L"Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\n"
                    L"Content-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\n"
                    L"X-DNS-Prefetch-Control: off", &denied))) {
                    args->put_Response(denied.Get());
                    return;
                }
            }
            if (SUCCEEDED(environment->CreateWebResourceResponse(nullptr, 403, L"Forbidden", L"", &denied))) {
                args->put_Response(denied.Get());
            }
        });
    Check(core->add_NavigationStarting(navigate.Get(), &token), "Legacy source navigation");
    Check(core->add_FrameNavigationStarting(frame.Get(), &token), "Legacy source frames");
    Check(core->add_NewWindowRequested(popup.Get(), &token), "Legacy source popups");
    Check(core->add_PermissionRequested(permission.Get(), &token), "Legacy source permissions");
    Check(core->AddWebResourceRequestedFilter(L"*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL), "Legacy source request filter");
    Check(core->add_WebResourceRequested(resource.Get(), &token), "Legacy source requests");
}

struct DraftSnapshot {
    fs::path path;
    ~DraftSnapshot() { std::error_code ignored; if (!path.empty()) fs::remove_all(path, ignored); }
};

std::shared_ptr<DraftSnapshot> ReadDraftSnapshot(const fs::path& userData, const LegacyDraftTarget& target,
    const std::atomic_bool& stopping) {
    const auto scoped = userData.parent_path() / L"@cwnupaa";
    const auto findLevelDb = [](const fs::path& profile) {
        auto directory = profile;
        if (!PathExists(directory, true)) return fs::path{};
        for (const auto* part : {L"Partitions", L"proctor-oj", L"Local Storage", L"leveldb"}) {
            directory /= part;
            if (!PathExists(directory, true)) return fs::path{};
        }
        return directory;
    };
    auto leveldb = PathExists(scoped, true) ? findLevelDb(scoped / L"proctor-desktop") : fs::path{};
    if (leveldb.empty()) leveldb = findLevelDb(userData);
    if (leveldb.empty()) return {};
    if (!AuthorizeLegacyDrafts(target, &stopping) || stopping) return {};
    const auto lock = StorageLock(leveldb);
    GUID id{};
    Check(CoCreateGuid(&id), "Create draft snapshot id");
    wchar_t name[40]{};
    StringFromGUID2(id, name, 40);
    auto snapshot = std::make_shared<DraftSnapshot>();
    const auto stage = userData / L"WebView2" / (std::wstring(L"legacy-import-stage-") + name + L"-drafts");
    if (!fs::create_directory(stage)) return {};
    snapshot->path = stage;
    const auto destination = stage / L"EBWebView/Default/Local Storage/leveldb";
    static const std::wregex dataFile(LR"((?:[0-9]+\.(?:ldb|log|sst)|MANIFEST-[0-9]+))");
    std::uintmax_t bytes = 0;
    size_t files = 0;
    for (const auto& entry : fs::directory_iterator(leveldb)) {
        const auto file = entry.path();
        const auto fileName = file.filename().wstring();
        if (fileName != L"CURRENT" && !std::regex_match(fileName, dataFile)) continue;
        const auto held = OpenSource(file, FILE_SHARE_READ);
        LARGE_INTEGER length{};
        if (!GetFileSizeEx(held.get(), &length) || length.QuadPart < 0 || ++files > 256 ||
            static_cast<std::uintmax_t>(length.QuadPart) > 64 * smallFileLimit - bytes) return {};
        bytes += static_cast<std::uintmax_t>(length.QuadPart);
        CopySource(file, destination / file.filename(), stopping);
    }
    static const std::regex manifestFile(R"(MANIFEST-[0-9]+\n)");
    const auto current = ReadSource(destination / L"CURRENT", 128);
    if (!std::regex_match(current, manifestFile) || !PathExists(destination / Wide(current.substr(0, current.size() - 1)), false))
        return {};
    return snapshot;
}

ComPtr<ICoreWebView2CookieManager> Manager(ICoreWebView2* core) {
    ComPtr<ICoreWebView2_2> cookieView;
    ComPtr<ICoreWebView2CookieManager> result;
    if (core && SUCCEEDED(core->QueryInterface(IID_PPV_ARGS(&cookieView)))) cookieView->get_CookieManager(&result);
    return result;
}

using Cookie = ComPtr<ICoreWebView2Cookie>;
using CookieKey = std::tuple<std::wstring, std::wstring, std::wstring>;

CookieKey Identity(ICoreWebView2Cookie* cookie) {
    LPWSTR name = nullptr, domain = nullptr, path = nullptr;
    cookie->get_Name(&name);
    cookie->get_Domain(&domain);
    cookie->get_Path(&path);
    return {TakeString(name), TakeString(domain), TakeString(path)};
}

std::vector<Cookie> ReadCookies(ICoreWebView2CookieList* list, bool legacySource) {
    std::vector<Cookie> result;
    UINT count = 0;
    if (!list || FAILED(list->get_Count(&count))) return result;
    for (UINT i = 0; i < count; ++i) {
        Cookie cookie;
        if (FAILED(list->GetValueAtIndex(i, &cookie))) continue;
        if (legacySource) {
            auto [name, domain, path] = Identity(cookie.Get());
            std::transform(name.begin(), name.end(), name.begin(), [](wchar_t ch) { return static_cast<wchar_t>(std::towlower(ch)); });
            // Live short-lived judge proofs are bound to a current desktop
            // login. Normal cookies keep all of their browser security flags.
            if (domain.empty() || path.empty() || name == L"proctor_ws" || name == L"proctor_http" ||
                name == L"novajudge_proctor_wk") continue;
        }
        result.push_back(std::move(cookie));
    }
    return result;
}

} // namespace

struct LegacyMigration::State : std::enable_shared_from_this<LegacyMigration::State> {
    struct DraftRead {
        std::atomic_bool cancelled = false;
        Worker worker;
        std::function<void(Json)> done;
        std::shared_ptr<DraftSnapshot> snapshot;
        std::shared_ptr<WebView> source;
        std::chrono::steady_clock::time_point deadline = std::chrono::steady_clock::now() + std::chrono::seconds(6);
    };

    struct Partition {
        fs::path snapshot;
        std::shared_ptr<WebView> source;
        ComPtr<ICoreWebView2> target;
        std::vector<Cookie> cookies;
        std::optional<EventRegistrationToken> receiver;
        bool hasCookies = false;
        bool read = false;
        bool imported = false;
        unsigned targetGeneration = 0;
    };

    explicit State(fs::path data, fs::path assets, Report log)
        : userData(std::move(data)), resources(std::move(assets)), report(std::move(log)),
          marker(userData / L"WebView2" / importMarker) {}

    ~State() {
        std::error_code error;
        for (const auto& part : partitions) {
            if (!part.snapshot.empty()) fs::remove_all(part.snapshot, error);
        }
    }

    void Prepare() {
        try {
            if (stopping) return;
            const auto work = userData / L"WebView2";
            if (PathExists(work, true)) ClearInterruptedStages(work);
            if (PathExists(marker, false)) return;
            const bool priorImport = PathExists(work / priorImportMarker, false);
            // Electron uses the package name when productName isn't in the
            // packaged package.json. The slash in the scoped name is a subdir.
            const auto original = userData.parent_path() / L"@cwnupaa";
            auto source = PathExists(original, true) && PathExists(original / L"proctor-desktop", true)
                ? original / L"proctor-desktop" : userData;
            if (!PathExists(source, true)) return;
            try { MigrateDevice(source); } catch (...) { prepareFailed = !stopping; }
            const auto local = source / L"Local Storage";
            const auto indexed = source / L"IndexedDB";
            const auto db = indexed / L"file__0.indexeddb.leveldb";
            const auto hasStorage = [this](const fs::path& directory, const fs::path& child) {
                try { return PathExists(directory, true) && PathExists(child, true); }
                catch (...) { prepareFailed = !stopping; return false; }
            };
            const bool preferences = !priorImport && hasStorage(local, local / L"leveldb");
            const bool evidence = !priorImport && hasStorage(indexed, db);
            std::optional<fs::path> defaultCookies;
            std::optional<fs::path> contestCookies;
            const auto contest = source / L"Partitions/proctor-oj";
            try { defaultCookies = CookieStore(source); } catch (...) { prepareFailed = !stopping; }
            try { if (PathExists(source / L"Partitions", true)) contestCookies = CookieStore(contest); }
            catch (...) { prepareFailed = !stopping; }
            if (!preferences && !evidence && !defaultCookies && !contestCookies) return;

            GUID id{};
            Check(CoCreateGuid(&id), "Create legacy migration id");
            wchar_t name[40]{};
            StringFromGUID2(id, name, 40);
            const auto stage = std::wstring(L"legacy-import-stage-") + name;
            const auto profile = fs::path(L"EBWebView/Default");
            auto& client = partitions[0];
            auto& guest = partitions[1];
            const auto snapshotStorage = [this](const fs::path& destination, const auto& copy) {
                try { copy(); return true; }
                catch (...) {
                    prepareFailed = !stopping;
                    std::error_code ignored;
                    fs::remove_all(destination, ignored);
                    return false;
                }
            };
            const auto copyCookies = [this](Partition& partition, const fs::path& database, const fs::path& state,
                                             const fs::path& fallback = {}) {
                try {
                    auto key = PartialLocalState(state);
                    if (key.empty() && !fallback.empty()) key = PartialLocalState(fallback);
                    SnapshotCookies(database, partition.snapshot, key, stopping);
                    partition.hasCookies = true;
                } catch (...) {
                    // A busy cookie database can be retried independently.
                    // Leave copied preferences and evidence available.
                    prepareFailed = !stopping;
                    std::error_code ignored;
                    fs::remove_all(partition.snapshot / L"EBWebView/Default/Network", ignored);
                    fs::remove(partition.snapshot / L"EBWebView/Local State", ignored);
                }
            };

            if (preferences || evidence || defaultCookies) {
                client.snapshot = work / (stage + L"-client");
                if (preferences) {
                    const auto destination = client.snapshot / profile / L"Local Storage";
                    preferencesExpected = snapshotStorage(destination, [&] {
                        const auto lock = StorageLock(local / L"leveldb");
                        SnapshotFiles(local / L"leveldb", destination / L"leveldb", stopping);
                    });
                }
                if (evidence) {
                    const auto destination = client.snapshot / profile / L"IndexedDB";
                    evidenceExpected = snapshotStorage(destination, [&] {
                        const auto lock = StorageLock(db);
                        SnapshotFiles(db, destination / db.filename(), stopping);
                        const auto blobs = indexed / L"file__0.indexeddb.blob";
                        if (PathExists(blobs, true)) SnapshotFiles(blobs, destination / blobs.filename(), stopping);
                    });
                }
                if (defaultCookies) copyCookies(client, *defaultCookies, source / L"Local State");
                if (!client.hasCookies && !preferencesExpected && !evidenceExpected) {
                    std::error_code ignored;
                    fs::remove_all(client.snapshot, ignored);
                    client.snapshot.clear();
                }
            }
            if (contestCookies) {
                guest.snapshot = work / (stage + L"-contest");
                copyCookies(guest, *contestCookies, contest / L"Local State", source / L"Local State");
                if (!guest.hasCookies) {
                    std::error_code ignored;
                    fs::remove_all(guest.snapshot, ignored);
                    guest.snapshot.clear();
                }
            }
            prepared = !client.snapshot.empty() || !guest.snapshot.empty();
        } catch (const std::exception&) {
            // Prepare runs off the UI thread. Only a fixed diagnostic crosses
            // back to startup logs, even on malformed legacy input.
            prepareFailed = !stopping;
        }
    }

    void MigrateDevice(const fs::path& source) {
        const auto old = source / L"device-id";
        const auto current = userData / L"device-id";
        if (!PathExists(old, false) || PathExists(current, false)) return;
        auto value = ReadSource(old, 256);
        value.erase(value.find_last_not_of(" \r\n\t") + 1);
        static const std::regex uuid("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", std::regex::icase);
        if (std::regex_match(value, uuid)) SaveOnce(current, value);
    }

    void ClearInterruptedStages(const fs::path& directory) {
        for (const auto& entry : fs::directory_iterator(directory)) {
            const auto name = entry.path().filename().wstring();
            // Only the GUID stage names created by this importer are ours.
            static const std::wregex staging(LR"(^legacy-import-stage-\{[A-Fa-f0-9-]{36}\}-(?:client|contest|drafts)$)");
            if (!std::regex_match(name, staging)) continue;
            const DWORD attrs = GetFileAttributesW(entry.path().c_str());
            if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_REPARSE_POINT) || !(attrs & FILE_ATTRIBUTE_DIRECTORY)) continue;
            std::error_code error;
            fs::remove_all(entry.path(), error);
        }
    }

    void Start(const Runtime& runtime, HWND parent, Ready complete) {
        ready = std::move(complete);
        started = true;
        if (prepareFailed) {
            failed = true;
            report("部分旧客户端本地数据暂时无法读取，保留原文件并在下次启动时重试");
        }
        if (!prepared || stopping) {
            for (auto& part : partitions) ReleaseTarget(part);
            Deliver();
            return;
        }
        preferencesReady = !preferencesExpected;
        startupDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
        try {
            sourceUrl = Wide(FileUrl(resources / L"migration.html"));
            for (size_t i = 0; i < partitions.size(); ++i) {
                auto& part = partitions[i];
                if (part.snapshot.empty()) {
                    part.read = part.imported = true;
                    continue;
                }
                auto source = std::make_shared<WebView>(parent);
                part.source = source;
                // Only the primary source needs a local renderer. The contest
                // snapshot is only read through the browser's cookie manager.
                std::wstring script;
                const bool needsDocument = i == 0 && (preferencesExpected || evidenceExpected);
                if (needsDocument) script = Wide("const PROCTOR_LEGACY_SOURCE_URL = " + Json(Utf8(sourceUrl)).dump()
                    + ";\nconst PROCTOR_LEGACY_READ_PREFERENCES = " + (preferencesExpected ? "true" : "false")
                    + ";\n" + ReadText(resources / L"migration-source.js"));
                source->Start(runtime, part.snapshot, {}, needsDocument, std::move(script),
                    [weak = weak_from_this(), i] {
                        if (auto self = weak.lock()) self->ConnectSource(i);
                    }, [weak = weak_from_this(), i](std::string) {
                        if (auto self = weak.lock()) self->SourceFailed(i);
                    }, false, true);
            }
            Deliver();
        } catch (...) {
            for (size_t i = 0; i < partitions.size(); ++i) SourceFailed(i);
        }
    }

    void Tick() {
        if (!started || stopping) return;
        const auto now = std::chrono::steady_clock::now();
        if (draftRead && now >= draftRead->deadline) FinishDrafts(draftRead, Json::object());
        if (ready && now >= startupDeadline) {
            if (!preferencesReady) SourceFailed(0);
            else if (!partitions[0].read) AcceptCookies(0, E_ABORT, nullptr);
            if (!partitions[1].imported) SourceFailed(1);
        }
        if (evidenceExpected && !evidenceApplied && !transferAbandoned && !ready && now >= evidenceDeadline) {
            TransferFailed();
        }
        // Closing a temporary controller in an event it raised can interrupt
        // WebView2. Release finished sources from the host's timer instead.
        if (partitions[1].imported) partitions[1].source.reset();
        if (partitions[0].imported && preferencesReady &&
            (!evidenceExpected || evidenceApplied || transferAbandoned)) partitions[0].source.reset();
        if (finished || (partitions[0].imported && now >= evidenceDeadline &&
            (!evidenceExpected || evidenceApplied || transferAbandoned))) {
            ReleaseTarget(partitions[0]);
            ReleaseTarget(partitions[1]);
        }
    }

    void ReadDrafts(LegacyDraftTarget target, const Runtime& runtime, HWND parent, Worker worker,
        std::function<void(Json)> done) {
        if (stopping) { done(Json::object()); return; }
        if (draftRead) FinishDrafts(draftRead, Json::object());
        auto read = std::make_shared<DraftRead>();
        read->worker = std::move(worker);
        read->done = std::move(done);
        draftRead = read;
        if (!read->worker([weak = weak_from_this(), read, data = userData, target = std::move(target), &runtime, parent] {
            std::shared_ptr<DraftSnapshot> snapshot;
            try { snapshot = ReadDraftSnapshot(data, target, read->cancelled); } catch (...) {}
            if (read->cancelled) return;
            wxTheApp->CallAfter([weak, read, snapshot = std::move(snapshot), target = std::move(target), &runtime, parent] {
                const auto owner = weak.lock();
                if (!owner || owner->draftRead != read || owner->stopping) return;
                read->snapshot = std::move(snapshot);
                if (!read->snapshot) { owner->FinishDrafts(read, Json::object()); return; }
                try { owner->OpenDrafts(read, target, runtime, parent); }
                catch (...) { owner->FinishDrafts(read, Json::object()); }
            });
        })) FinishDrafts(read, Json::object());
    }

    void OpenDrafts(const std::shared_ptr<DraftRead>& read, const LegacyDraftTarget& target, const Runtime& runtime, HWND parent) {
        const auto expected = Wide(target.origin + "/__proctor_native_draft_snapshot__");
        const auto script = Wide(LegacyDraftReadScript(target));
        const auto finish = [weak = weak_from_this(), pending = std::weak_ptr<DraftRead>(read)](Json result) {
            wxTheApp->CallAfter([weak, pending, result = std::move(result)]() mutable {
                const auto owner = weak.lock();
                const auto read = pending.lock();
                if (owner && read) owner->FinishDrafts(read, std::move(result));
            });
        };
        read->source = std::make_shared<WebView>(parent);
        read->source->Start(runtime, read->snapshot->path, {}, false, {},
            [pending = std::weak_ptr<DraftRead>(read), expected, script, finish] {
                const auto read = pending.lock();
                if (!read || read->cancelled) return;
                const auto source = read->source;
                auto* core = source->core();
                InstallSourcePolicy(core, source->environment(), expected, true);
                EventRegistrationToken event{};
                auto loaded = On<ICoreWebView2NavigationCompletedEventHandler, ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*>(
                    [pending, expected, script, finish](ICoreWebView2* core, ICoreWebView2NavigationCompletedEventArgs* args) {
                        const auto read = pending.lock();
                        BOOL ok = FALSE;
                        LPWSTR address = nullptr;
                        if (!read || read->cancelled) return;
                        if (FAILED(args->get_IsSuccess(&ok)) || !ok || FAILED(core->get_Source(&address)) ||
                            TakeString(address) != expected) { finish(Json::object()); return; }
                        auto complete = On<ICoreWebView2ExecuteScriptCompletedHandler, HRESULT, LPCWSTR>(
                            [finish](HRESULT status, LPCWSTR value) {
                                const std::wstring_view json = value ? value : L"";
                                if (FAILED(status) || json.size() > 8 * smallFileLimit) finish(Json::object());
                                else finish(Json::parse(Utf8(json), nullptr, false));
                            });
                        if (FAILED(core->ExecuteScript(script.c_str(), complete.Get()))) finish(Json::object());
                    });
                Check(core->add_NavigationCompleted(loaded.Get(), &event), "Legacy draft snapshot");
                source->Navigate(expected);
            },
            [finish](std::string) { finish(Json::object()); }, false, true);
    }

    void FinishDrafts(std::shared_ptr<DraftRead> read, Json value, bool respond = true) {
        if (draftRead != read) return;
        draftRead.reset();
        read->cancelled = true;
        read->source.reset();
        if (read->snapshot) {
            const auto snapshot = std::move(read->snapshot);
            read->worker([snapshot] {});
        }
        auto done = std::move(read->done);
        if (respond) done(std::move(value));
    }

    void SourceFailed(size_t index) {
        if (stopping) return;
        failed = true;
        report("固定版浏览器未能读取一部分旧客户端数据，原文件已保留");
        auto& part = partitions[index];
        part.read = part.imported = true;
        ++part.targetGeneration;
        part.cookies.clear();
        if (index == 0) {
            preferencesReady = true;
            transferAbandoned = true;
            transfer = false;
        }
        Deliver();
    }

    void ConnectSource(size_t index) {
        if (stopping || partitions[index].read) return;
        auto& part = partitions[index];
        auto source = part.source;
        source->Visible(false);
        ComPtr<ICoreWebView2_13> coreProfile;
        ComPtr<ICoreWebView2Profile> profile;
        Check(source->core()->QueryInterface(IID_PPV_ARGS(&coreProfile)), "Legacy profile");
        Check(coreProfile->get_Profile(&profile), "Legacy browsing profile");
        LPWSTR rawPath = nullptr;
        Check(profile->get_ProfilePath(&rawPath), "Legacy browsing profile path");
        if (!fs::equivalent(fs::path(TakeString(rawPath)), part.snapshot / L"EBWebView/Default")) {
            throw std::runtime_error("浏览器临时迁移目录布局不匹配");
        }
        if (index == 0 && (preferencesExpected || evidenceExpected)) {
            auto* core = source->core();
            InstallSourcePolicy(core, source->environment(), sourceUrl);
            EventRegistrationToken token{};
            auto handler = On<ICoreWebView2WebMessageReceivedEventHandler, ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs*>(
                [weak = weak_from_this()](ICoreWebView2*, auto args) {
                    if (auto self = weak.lock()) self->ReceiveSource(Message(args, self->sourceUrl, 512 * 1024));
                });
            Check(core->add_WebMessageReceived(handler.Get(), &token), "Legacy source bridge");
            auto loaded = On<ICoreWebView2NavigationCompletedEventHandler, ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*>(
                [weak = weak_from_this()](ICoreWebView2*, auto args) {
                    BOOL ok = FALSE;
                    if (FAILED(args->get_IsSuccess(&ok)) || !ok) {
                        if (auto self = weak.lock()) self->SourceFailed(0);
                    }
                });
            Check(core->add_NavigationCompleted(loaded.Get(), &token), "Legacy source loaded");
            source->Navigate(sourceUrl);
        }
        if (!part.hasCookies) {
            part.read = part.imported = true;
            Deliver();
            return;
        }
        auto manager = Manager(source->core());
        if (!manager) { AcceptCookies(index, E_FAIL, nullptr); return; }
        auto completed = On<ICoreWebView2GetCookiesCompletedHandler, HRESULT, ICoreWebView2CookieList*>(
            [weak = weak_from_this(), index](HRESULT result, ICoreWebView2CookieList* list) {
                if (auto self = weak.lock()) self->AcceptCookies(index, result, list);
            });
        if (FAILED(manager->GetCookies(L"", completed.Get()))) AcceptCookies(index, E_FAIL, nullptr);
    }

    void AcceptCookies(size_t index, HRESULT result, ICoreWebView2CookieList* list) {
        if (stopping) return;
        auto& part = partitions[index];
        if (part.read) return;
        if (FAILED(result)) {
            // Cookie failure does not discard usable page preferences/evidence.
            failed = true;
            part.imported = true;
            report("未能读取旧客户端 Cookie");
        } else {
            part.cookies = ReadCookies(list, true);
            if (part.cookies.empty()) part.imported = true;
        }
        part.read = true;
        ImportCookies(index);
        Deliver();
        Finish();
    }

    void ImportCookies(size_t index) {
        auto& part = partitions[index];
        if (!part.read || part.imported || !part.target) return;
        const auto manager = Manager(part.target.Get());
        if (!manager) { failed = true; part.imported = true; Deliver(); Finish(); return; }
        auto done = On<ICoreWebView2GetCookiesCompletedHandler, HRESULT, ICoreWebView2CookieList*>(
            [weak = weak_from_this(), index, generation = part.targetGeneration, manager](HRESULT status, ICoreWebView2CookieList* existing) {
                auto self = weak.lock();
                if (!self || self->stopping) return;
                auto& current = self->partitions[index];
                if (current.targetGeneration != generation || current.imported) return;
                if (FAILED(status)) self->failed = true;
                else {
                    std::set<CookieKey> known;
                    for (const auto& cookie : ReadCookies(existing, false)) known.insert(Identity(cookie.Get()));
                    for (const auto& source : current.cookies) {
                        if (known.count(Identity(source.Get()))) continue;
                        Cookie copy;
                        if (FAILED(manager->CopyCookie(source.Get(), &copy)) || FAILED(manager->AddOrUpdateCookie(copy.Get()))) {
                            self->failed = true;
                        } else ++self->cookieCount[index];
                    }
                }
                current.cookies.clear();
                if (self->cookieCount[index] == 0) {
                    self->CompleteCookieImport(index, generation, S_OK);
                    return;
                }
                // Queries and updates use the same Chromium cookie service, so
                // this read fences earlier writes before opening an exam scope.
                auto fence = On<ICoreWebView2GetCookiesCompletedHandler, HRESULT, ICoreWebView2CookieList*>(
                    [weak, index, generation](HRESULT result, ICoreWebView2CookieList*) {
                        if (auto owner = weak.lock()) owner->CompleteCookieImport(index, generation, result);
                    });
                const auto result = manager->GetCookies(L"", fence.Get());
                if (FAILED(result)) self->CompleteCookieImport(index, generation, result);
            });
        if (FAILED(manager->GetCookies(L"", done.Get()))) {
            failed = true;
            part.imported = true;
            Deliver();
            Finish();
        }
    }

    void CompleteCookieImport(size_t index, unsigned generation, HRESULT result) {
        auto& part = partitions[index];
        if (stopping || part.targetGeneration != generation || part.imported) return;
        if (FAILED(result)) failed = true;
        part.imported = true;
        Deliver();
        Finish();
    }

    void Deliver() {
        if (!ready) return;
        // Let the guest finish its one-time cookie import before the shell can
        // request a new contest and clear this partition for candidate login.
        if (prepared && (!preferencesReady || !partitions[0].read || !partitions[1].imported)) return;
        auto complete = std::move(ready);
        TouchEvidence();
        complete();
    }

    void Attach(size_t index, ICoreWebView2* target) {
        if (stopping || finished || (started && !prepared)) return;
        auto& part = partitions[index];
        ReleaseTarget(part);
        part.target = target;
        ++part.targetGeneration;
        ImportCookies(index);
        if (index == 0 && prepared && !finished) {
            EventRegistrationToken token{};
            auto response = On<ICoreWebView2WebMessageReceivedEventHandler, ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs*>(
                [weak = weak_from_this()](ICoreWebView2*, auto args) {
                    if (auto self = weak.lock()) self->ReceiveTarget(Message(args, clientUrl, 8192));
                });
            Check(target->add_WebMessageReceived(response.Get(), &token), "Legacy destination bridge");
            part.receiver = token;
        }
        Finish();
    }

    void SourceSend(const Json& value) {
        if (!partitions[0].source || !partitions[0].source->core()) return;
        partitions[0].source->Send(value);
    }
    void TargetSend(const Json& value) {
        auto* target = partitions[0].target.Get();
        if (target) target->PostWebMessageAsJson(Wide(value.dump()).c_str());
    }

    void Next() {
        if (!transfer || stopping) return;
        SourceSend({{"migration", "next"}, {"generation", generation}, {"store", store},
            {"after", after.empty() ? Json(nullptr) : Json(after)}});
    }

    void ReceiveSource(const Json& value) {
        if (!value.is_object() || stopping || !value.contains("migration") || !value["migration"].is_string()) return;
        const auto kind = value["migration"].get<std::string>();
        if (kind == "preferences") {
            if (!preferencesReady && value.contains("values")) {
                preferences = ValidatePreferences(value["values"]);
                preferencesRead = value.value("read", false);
                if (!preferencesRead) failed = true;
            }
            preferencesReady = true;
            Deliver();
            return;
        }
        if (!transfer || value.value("generation", 0U) != generation) return;
        TouchEvidence();
        if (kind == "failed") { TransferFailed(); return; }
        if (kind == "store-complete" && value.value("store", "") == store) {
            if (store == "uploads") { store = "alerts"; after = Prefer(resume, "alerts"); Next(); }
            else {
                transfer = false;
                evidenceComplete = true;
                TargetSend({{"migration", "complete"}, {"document", document}});
            }
        } else if (kind == "entry" && value.value("store", "") == store && value.contains("record") && value["record"].is_object()) {
            const auto id = Prefer(value["record"], "id");
            if (id.empty()) { TransferFailed(); return; }
            after = id;
            ForwardToDocument(value);
        } else if (kind == "chunk" || kind == "commit") ForwardToDocument(value);
    }

    void ForwardToDocument(Json message) {
        message["document"] = document;
        TargetSend(message);
    }

    void ReceiveTarget(const Json& value) {
        if (!value.is_object() || stopping || !value.contains("migration") || !value["migration"].is_string()) return;
        const auto kind = value["migration"].get<std::string>();
        if (kind == "preferences-applied") {
            preferencesApplied = true;
            Finish();
        } else if (kind == "ready") {
            const auto next = Prefer(value, "document");
            if (next.empty() || next == document || transferAbandoned) return;
            TouchEvidence();
            document = next;
            ++generation;
            if (evidenceComplete) { TargetSend({{"migration", "complete"}, {"document", document}}); return; }
            resume = value.value("resume", Json::object());
            if (!resume.is_object()) resume = Json::object();
            store = "uploads";
            after = Prefer(resume, "uploads");
            transfer = true;
            Next();
        } else if (kind == "already-complete") {
            evidenceComplete = evidenceApplied = true;
            transfer = false;
            Finish();
        } else if (value.value("document", "") != document) return;
        else if (kind == "evidence-applied" && evidenceComplete) { evidenceApplied = true; Finish(); }
        else if (kind == "failed" && transfer) TransferFailed();
        else if (kind == "continue" && transfer) {
            TouchEvidence();
            SourceSend({{"migration", "continue"}, {"generation", generation}});
        }
        else if (kind == "duplicate" && transfer) Next();
        else if (kind == "committed" && transfer) {
            ++evidenceCount;
            Next();
        }
        else if (kind == "skipped" && transfer) {
            failed = true;
            if (!reportedSkipped) {
                reportedSkipped = true;
                report("存在无法按原会话范围迁移的离线证据，原数据库已保留");
            }
            Next();
        }
    }

    void TransferFailed() {
        failed = true;
        transfer = false;
        transferAbandoned = true;
        report("旧客户端离线证据迁移未完成，原文件已保留");
    }

    void TouchEvidence() { evidenceDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(30); }

    void Finish() {
        if (!prepared || finished || stopping || !preferencesApplied
            || (evidenceExpected && !evidenceApplied)
            || !partitions[0].target || !partitions[0].imported || !partitions[1].imported) return;
        if (failed) return;
        try {
            SaveOnce(marker, "1\n");
            finished = true;
            report("旧客户端本地数据已迁移，偏好 " + std::to_string(preferences.size())
                + "，主页面 Cookie " + std::to_string(cookieCount[0])
                + "，比赛页 Cookie " + std::to_string(cookieCount[1])
                + "，离线记录 " + std::to_string(evidenceCount));
        } catch (...) { report("未能保存旧客户端数据迁移标记"); }
    }

    void ReleaseTarget(Partition& part) {
        if (part.receiver && part.target) part.target->remove_WebMessageReceived(*part.receiver);
        part.receiver.reset();
        part.target.Reset();
    }

    void Close() {
        stopping = true;
        if (draftRead) FinishDrafts(draftRead, Json(), false);
        ready = {};
        for (auto& part : partitions) {
            part.cookies.clear();
            ReleaseTarget(part);
            part.source.reset();
        }
    }

    fs::path userData, resources;
    Report report;
    fs::path marker;
    std::array<Partition, 2> partitions;
    std::shared_ptr<DraftRead> draftRead;
    std::atomic_bool stopping = false;
    std::wstring sourceUrl;
    std::chrono::steady_clock::time_point startupDeadline, evidenceDeadline = std::chrono::steady_clock::time_point::max();
    Ready ready;
    Json preferences = Json::object();
    Json resume = Json::object();
    std::string store, after, document;
    unsigned generation = 0;
    std::array<size_t, 2> cookieCount{};
    size_t evidenceCount = 0;
    std::atomic_bool prepared = false;
    bool prepareFailed = false, preferencesExpected = false, preferencesReady = false, preferencesRead = false, preferencesApplied = false;
    bool evidenceExpected = false, evidenceComplete = false, evidenceApplied = false, transfer = false, transferAbandoned = false;
    bool started = false, failed = false, finished = false, reportedSkipped = false;
};

LegacyMigration::LegacyMigration(fs::path userData, fs::path resources, Report report)
    : state_(std::make_shared<State>(std::move(userData), std::move(resources), std::move(report))) {}
LegacyMigration::~LegacyMigration() { Cancel(); }
void LegacyMigration::Prepare() { state_->Prepare(); }
bool LegacyMigration::NeedsContestTarget() const {
    return state_->prepared && state_->partitions[1].hasCookies;
}
void LegacyMigration::Start(const Runtime& runtime, HWND parent, Ready ready) {
    state_->Start(runtime, parent, std::move(ready));
}
std::string LegacyMigration::ShellScript() const {
    const auto& self = *state_;
    if (!self.prepared || (!self.preferencesReady && !self.evidenceExpected) || self.finished) return {};
    return "\nconst PROCTOR_LEGACY_PREFERENCES = " + (self.preferencesRead ? self.preferences.dump() : "null")
        + ";\nconst PROCTOR_LEGACY_EVIDENCE = " + (self.evidenceExpected && !self.transferAbandoned ? "true" : "false")
        + ";\n" + ReadText(self.resources / L"migration-client.js");
}
void LegacyMigration::AttachClient(ICoreWebView2* target) { state_->Attach(0, target); }
void LegacyMigration::AttachContest(ICoreWebView2* target) { state_->Attach(1, target); }
void LegacyMigration::ReadDrafts(LegacyDraftTarget target, const Runtime& runtime, HWND parent, Worker worker,
    std::function<void(Json)> ready) {
    state_->ReadDrafts(std::move(target), runtime, parent, std::move(worker), std::move(ready));
}
void LegacyMigration::Tick() { state_->Tick(); }
void LegacyMigration::Cancel() { state_->Close(); }

} // namespace proctor
