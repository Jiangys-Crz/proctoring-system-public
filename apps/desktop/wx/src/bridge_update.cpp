#include "bridge_internal.hpp"
#include "bridge_update_policy.hpp"

#ifdef _WIN32
#include <windows.h>
#endif

#include <algorithm>
#include <fstream>
#include <iterator>
#include <regex>

namespace proctor::bridge_detail {
#ifdef _WIN32
std::string_view UpdateTarget() {
    // One native-architecture installer contains x86, x64 and ARM64 payloads.
    return kUpdateTarget;
}
#endif

namespace {

#ifdef __APPLE__
constexpr char kUpdatePattern[] = R"(^/api/desktop/releases/files/[a-f0-9-]{36}\.dmg$)";
constexpr std::string_view kUpdateFeed = "latest-mac.yml";
constexpr char kAvailableMessage[] = " 后登录考试。下载后请打开 Mac 安装包中的新版客户端，选择“安装并重新打开”，再从“应用程序”启动。仅下载不会更新旧应用。";
constexpr char kDownloadingMessage[] = "正在下载最新版，完成后将打开安装包…";
constexpr char kInstallingMessage[] = "下载及校验完成，请在安装窗口完成安装后重新打开客户端";
#else
constexpr char kUpdatePattern[] = R"(^/api/desktop/releases/files/[a-f0-9-]{36}\.exe$)";
constexpr std::string_view kUpdateFeed = "latest.yml";
constexpr char kAvailableMessage[] = " 后登录考试。下载后会打开安装向导，请保留原安装路径并完成安装。";
constexpr char kDownloadingMessage[] = "正在下载最新版，完成后将打开安装向导…";
constexpr char kInstallingMessage[] = "下载及校验完成，正在打开安装向导，请完成安装后启动客户端";
#endif

std::string ReadSetting(std::string_view config, const char* key) {
    const std::regex pattern(std::string("window\\.") + key + R"(\s*=\s*['"]([^'"]*)['"])");
    std::match_results<std::string_view::const_iterator> match;
    return std::regex_search(config.begin(), config.end(), match, pattern) ? match[1].str() : std::string{};
}

std::string TrustedUpdateOrigin(std::string_view value, bool packaged) {
    const auto url = ParseHttpUrl(value);
    if (url.path != "/" || !url.query.empty() || !url.fragment.empty())
        throw std::runtime_error("更新地址必须是服务器主地址");
    if (!url.secure && (packaged || (url.host != "localhost" && url.host != "127.0.0.1" && url.host != "[::1]")))
        throw std::runtime_error("自动更新需要可信的 HTTPS 服务器地址，请联系管理员配置");
    return url.origin;
}

struct UpdateFile {
    HttpUrl url;
    std::uint64_t size;
    std::string sha512;
};

UpdateFile ValidateUpdateFile(const Json& file, std::string_view origin) {
    static const std::regex pathPattern(kUpdatePattern);
    static const std::regex hashPattern(R"(^[A-Za-z0-9+/]{86}==$)");
    if (!file.is_object() || !file.contains("size") || !file.at("size").is_number_integer())
        throw std::runtime_error("更新包地址或校验信息无效");
    const auto url = ResolveHttpUrl(origin, Text(file, "url"));
    const auto hash = Text(file, "sha512");
    const auto size = file.at("size").get<std::int64_t>();
    if (url.origin != origin || !url.query.empty() || !url.fragment.empty() ||
        !std::regex_match(url.path, pathPattern) || !std::regex_match(hash, hashPattern) ||
        size < 512 || size > 1024LL * 1024 * 1024)
        throw std::runtime_error("更新包地址或校验信息无效");
    return { url, static_cast<std::uint64_t>(size), hash };
}

Json ReadManifest(std::string_view url, int timeout, const std::atomic<bool>& stopping) {
    HttpResponse response;
    try {
#ifdef _WIN32
        response = RequestUpdateManifest(ParseHttpUrl(url), timeout, 128 * 1024, &stopping);
#else
        response = RequestHttp(url, "GET", {{ "accept", "application/json" }}, {}, timeout, 128 * 1024, true, &stopping);
#endif
    }
    catch (const NetworkFailure& error) {
        const std::string_view detail(error.what());
        if (detail.starts_with("请求超时")) throw std::runtime_error("客户端版本检查超时，请重试");
        if (detail.starts_with("服务器响应过大")) throw std::runtime_error("版本信息过大");
        throw std::runtime_error("无法连接版本服务器 " + ParseHttpUrl(url).origin + "：" + error.what());
    }
    if (response.status != 200) throw std::runtime_error("版本服务器暂不可用，请重试");
    return Parse(response.body);
}

}  // namespace

Updater::Updater(Bridge::Config config, StatusPublisher publish, const std::atomic<bool>& stopping)
    : config_(std::move(config)), publish_(std::move(publish)), stopping_(stopping) {
    status_ = {
        { "phase", "checking" }, { "required", true }, { "currentVersion", config_.version },
        { "message", "正在检查客户端版本…" }, { "percent", 0 }
    };
    std::ifstream source(config_.rendererDirectory / "config.js", std::ios::binary);
    const std::string content(std::istreambuf_iterator<char>(source), {});
    origin_ = ReadSetting(content, "PROCTOR_UPDATE_SERVER_URL");
    if (origin_.empty()) origin_ = ReadSetting(content, "PROCTOR_DEFAULT_SERVER_URL");
    if (origin_.empty()) origin_ = "http://localhost:4031";
    channel_ = ReadSetting(content, "PROCTOR_RELEASE_CHANNEL");
    if (channel_ != "intranet" && channel_ != "unified") channel_ = "public";
    backendOrigin_ = ReadSetting(content, "PROCTOR_DEFAULT_SERVER_URL");
    if (backendOrigin_.empty()) backendOrigin_ = origin_;
}

void Updater::RequireBackend(std::string_view origin) const {
    if (!config_.packaged || channel_ == "unified") return;
    if (origin != TrustedUpdateOrigin(backendOrigin_, true))
        throw std::runtime_error(channel_ == "intranet"
            ? "内网客户端只能连接配置的内网监考后台，请使用对应网络的安装包"
            : "公网客户端只能连接配置的公网监考后台，请使用对应网络的安装包");
}

Json Updater::Status() const {
    std::lock_guard lock(stateMutex_);
    return status_;
}

void Updater::Set(Json patch) {
    Json value;
    {
        std::lock_guard lock(stateMutex_);
        for (auto& [field, item] : patch.items()) {
            if (item.is_null()) status_.erase(field);
            else status_[field] = std::move(item);
        }
        value = status_;
    }
    publish_(value);
}

void Updater::Failed(std::string message) {
    Set({ { "phase", "error" }, { "required", true }, { "message", std::move(message) } });
}

Json Updater::Check(bool startup) {
    const auto current = Status();
    if (current.at("phase") == "downloading" || current.at("phase") == "installing") return current;
    std::lock_guard lock(operationMutex_);
    if (startup && startupChecked_) return Status();
    auto result = CheckUnlocked();
    if (startup) startupChecked_ = true;
    return result;
}

Json Updater::CheckUnlocked() {
    release_ = nullptr;
    Set({ { "phase", "checking" }, { "required", true }, { "percent", 0 }, { "latestVersion", nullptr },
          { "notes", "" }, { "message", "正在检查客户端版本…" } });
    try {
        if (!config_.packaged) {
            Set({ { "phase", "current" }, { "required", false }, { "serverOrigin", TrustedUpdateOrigin(origin_, false) },
                  { "releaseChannel", channel_ == "intranet" ? "intranet" : "public" },
                  { "message", "开发运行 · v" + config_.version } });
            return Status();
        }
        std::vector<std::pair<std::string, std::string>> backends;
        if (channel_ == "unified") {
            backends.emplace_back("https://proctoring.example.test", "intranet");
            backends.emplace_back("https://proctoring.example.org", "public");
        } else backends.emplace_back(origin_, channel_);

        Json manifest;
        const auto updateTarget = UpdateTarget();
        std::string selectedOrigin, selectedChannel;
        for (const auto& [origin, channel] : backends) {
            if (stopping_) throw std::runtime_error("请求已取消");
            const auto trusted = TrustedUpdateOrigin(origin, true);
            try {
                auto address = trusted + "/api/desktop/releases?channel=" + channel + "&runtime=" + std::string(kRuntime);
                if (updateTarget.starts_with("windows-")) address += "&target=" + std::string(updateTarget);
                manifest = ReadManifest(address,
                                        backends.size() == 1 ? 15000 : channel == "intranet" ? 5000 : 10000, stopping_);
                if (!manifest.is_object() || manifest.value("ok", Json(false)) != true ||
                    !manifest.contains("data") || !manifest.at("data").is_array())
                    throw std::runtime_error("版本服务暂不可用");
                selectedOrigin = trusted;
                selectedChannel = channel;
                break;
            } catch (...) {
                if (backends.size() == 1) throw;
            }
        }
        if (selectedOrigin.empty())
            throw std::runtime_error("内网和公网后台均无法连接，请检查网络与 HTTPS 证书后重试");
        Set({ { "serverOrigin", selectedOrigin }, { "releaseChannel", selectedChannel } });
        const auto& data = manifest.at("data");
        auto found = std::find_if(data.begin(), data.end(), [&](const Json& item) {
            return Text(item, "channel") == selectedChannel && Text(item, "target") == updateTarget;
        });
        if (found == data.end()) throw std::runtime_error("管理员尚未发布当前系统的客户端，请联系监考老师");
        const auto version = Text(*found, "version");
        const auto feed = "/api/desktop/updates/" + selectedChannel + "/" + Text(*found, "target") + "/";
        const auto installedVersion = ParseReleaseVersion(config_.version);
        const auto publishedVersion = ParseReleaseVersion(version);
        if (!installedVersion || !publishedVersion || Text(*found, "feedUrl") != feed)
            throw std::runtime_error("服务器版本信息无效");
        if (*publishedVersion < *installedVersion)
            throw std::runtime_error("服务器发布的客户端版本低于本机版本，请联系管理员更新发布版本");
        if (Text(*found, "runtime") != kRuntime && (found->contains("runtime") || version != config_.version))
            throw std::runtime_error("服务器尚未发布适用于当前客户端的安装包，请联系管理员");
        if (Text(*found, "installationMode") != "manual") throw std::runtime_error("服务器安装方式无效");
        ValidateUpdateFile(found->value("update", Json()), selectedOrigin);
        release_ = *found;
        if (version == config_.version) {
            Set({ { "phase", "current" }, { "required", false }, { "latestVersion", version },
                  { "message", "已是最新版本 · v" + version }, { "notes", "" } });
        } else {
            auto notes = Text(*found, "notes");
            if (notes.size() > 5000) {
                std::size_t boundary = 5000;
                while (boundary && (static_cast<unsigned char>(notes[boundary]) & 0xc0) == 0x80) --boundary;
                notes.resize(boundary);
            }
            Set({ { "phase", "available" }, { "required", true }, { "latestVersion", version }, { "notes", std::move(notes) },
                  { "message", "请更新至 v" + version + kAvailableMessage } });
        }
    } catch (const std::exception& error) { Failed(error.what()); }
    return Status();
}

fs::path Updater::Download() {
    std::lock_guard lock(operationMutex_);
    fs::path temporary, destination;
    try {
        const auto state = CheckUnlocked();
        if (state.at("phase") == "current") return {};
        if (state.at("phase") != "available" || release_.is_null()) throw std::runtime_error(Text(state, "message"));
        // Older release tracks may point to an Electron installer.
        if (Text(release_, "runtime") != kRuntime) throw std::runtime_error("服务器尚未发布适用于当前客户端的更新包，请联系管理员");
        const auto origin = Text(state, "serverOrigin");
        const auto file = ValidateUpdateFile(release_.at("update"), origin);
        const auto metadata = ReadManifest(origin + Text(release_, "feedUrl") + std::string(kUpdateFeed) + "?runtime=" + std::string(kRuntime), 15000, stopping_);
        if (Text(metadata, "version") != Text(release_, "version") || Text(metadata, "runtime") != kRuntime ||
            metadata.contains("packages") || !metadata.contains("files") || !metadata.at("files").is_array() ||
            metadata.at("files").size() != 1)
            throw std::runtime_error("版本已变化，请重新检查更新");
        const auto feedFile = ValidateUpdateFile(metadata.at("files").front(), origin);
        if (feedFile.url.Url() != file.url.Url() || feedFile.sha512 != file.sha512 || feedFile.size != file.size)
            throw std::runtime_error("更新信息已变化，请重新检查更新");

#ifdef __APPLE__
        const auto directory = config_.userDataDirectory / "client-updates";
#else
        const auto directory = config_.userDataDirectory / "client-updates" / RandomHex();
#endif
        fs::create_directories(directory);
        destination = directory / fs::path(file.url.path).filename();
        temporary = destination;
#ifdef __APPLE__
        if (MatchesUpdateFile(destination, file.size, file.sha512, stopping_)) return destination;
        temporary += "." + RandomHex();
#endif
        temporary += ".partial";
        const auto progress = [&](double percent) {
            Set({ { "phase", "downloading" }, { "required", true }, { "percent", percent },
                  { "message", kDownloadingMessage } });
        };
        progress(0);
        DownloadVerified(file.url, file.size, file.sha512, temporary, progress, stopping_);
        fs::rename(temporary, destination);
        return destination;
    } catch (const std::exception& error) {
        if (!temporary.empty()) {
            std::error_code ignored;
            fs::remove(temporary, ignored);
            fs::remove(temporary.parent_path(), ignored);
        }
        Failed(error.what());
        throw;
    }
}

void Updater::Installed() {
    Set({ { "phase", "installing" }, { "percent", 100 },
          { "message", kInstallingMessage } });
}

#ifdef __APPLE__
void Updater::Deferred() {
    Set({ { "phase", "available" }, { "required", true }, { "percent", 0 },
          { "message", "安装包已保存在本机。准备安装时，请重新点击更新" } });
}
#endif

}  // namespace proctor::bridge_detail
