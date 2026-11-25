#include "legacy_launch.hpp"

#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <fcntl.h>
#include <optional>
#include <signal.h>
#include <spawn.h>
#include <stdexcept>
#include <string>
#include <string_view>
#include <sys/stat.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <vector>

namespace proctor {
namespace {
namespace fs = std::filesystem;

bool Directory(const fs::path& path) {
    std::error_code error;
    return fs::is_directory(fs::symlink_status(path, error));
}

std::optional<fs::path> FindProfile(const fs::path& support) {
    const auto scoped = support / "@cwnupaa";
    const auto hasData = [](const fs::path& path) {
        if (!Directory(path)) return false;
        for (const auto* source : {"Local Storage", "IndexedDB", "Network", "Partitions", "Service Worker", "Cache"})
            if (Directory(path / source)) return true;
        std::error_code error;
        return fs::is_regular_file(fs::symlink_status(path / "Cookies", error));
    };
    if (Directory(scoped) && hasData(scoped / "proctor-desktop")) return scoped / "proctor-desktop";
    const auto product = support / "程序设计算法协会监考客户端";
    if (hasData(product)) return product;
    return std::nullopt;
}

bool HasDrafts(const fs::path& source) {
    auto path = source;
    for (const auto* name : {"Partitions", "proctor-oj", "Local Storage", "leveldb"}) {
        path /= name;
        if (!Directory(path)) return false;
    }
    return true;
}

std::optional<fs::path> FindDraftProfile(const fs::path& support) {
    const auto scoped = support / "@cwnupaa";
    const auto current = scoped / "proctor-desktop";
    if (Directory(scoped) && Directory(current) && HasDrafts(current)) return current;
    const auto product = support / "程序设计算法协会监考客户端";
    if (Directory(product) && HasDrafts(product)) return product;
    return std::nullopt;
}

void RemoveStaleStages(const fs::path& userData) {
    std::error_code ignored;
    constexpr std::string_view prefix = "legacy-export.";
    for (const auto& entry : fs::directory_iterator(userData, ignored)) {
        const auto name = entry.path().filename().string();
        if (!name.starts_with(prefix) || name.size() != prefix.size() + 6 || !Directory(entry.path())) continue;
        fs::remove_all(entry.path(), ignored);
    }
}

struct SpawnArguments {
    posix_spawn_file_actions_t files;
    posix_spawnattr_t attributes;

    SpawnArguments() {
        if (posix_spawn_file_actions_init(&files)) throw std::runtime_error("export spawn file actions");
        if (posix_spawnattr_init(&attributes)) {
            posix_spawn_file_actions_destroy(&files);
            throw std::runtime_error("export spawn attributes");
        }
    }
    ~SpawnArguments() {
        posix_spawn_file_actions_destroy(&files);
        posix_spawnattr_destroy(&attributes);
    }
};

pid_t Launch(const fs::path& program, const fs::path& exporter, const fs::path& source, const fs::path& stage,
             std::vector<std::string> extra = {}) {
    SpawnArguments spawn;
    if (posix_spawnattr_setpgroup(&spawn.attributes, 0) ||
        posix_spawnattr_setflags(&spawn.attributes, POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT) ||
        posix_spawn_file_actions_addopen(&spawn.files, 0, "/dev/null", O_RDONLY, 0) ||
        posix_spawn_file_actions_addopen(&spawn.files, 1, "/dev/null", O_WRONLY, 0) ||
        posix_spawn_file_actions_addopen(&spawn.files, 2, "/dev/null", O_WRONLY, 0)) return -1;

    // Only inherit the user/locale data needed by Chromium and Keychain.
    // Debugging and arbitrary Node startup arguments must not reach the helper.
    std::vector<std::string> environment{"PATH=/usr/bin:/bin"};
    for (const auto* name : {"HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"}) {
        if (const auto* value = std::getenv(name)) environment.emplace_back(std::string(name) + '=' + value);
    }
    std::vector<char*> entries;
    for (auto& entry : environment) entries.push_back(entry.data());
    entries.push_back(nullptr);

    auto binary = program.string(), javascript = exporter.string(), from = source.string(), to = stage.string();
    std::string mode = extra.empty() ? "--proctor-export" : "--proctor-export-drafts";
    std::vector<char*> arguments{binary.data(), javascript.data(), mode.data(), from.data(), to.data()};
    for (auto& value : extra) arguments.push_back(value.data());
    arguments.push_back(nullptr);
    pid_t child = -1;
    return posix_spawn(&child, binary.c_str(), &spawn.files, &spawn.attributes, arguments.data(), entries.data()) == 0 ? child : -1;
}

bool Wait(pid_t child, const std::atomic_bool& cancelled, std::chrono::seconds timeout) {
    using namespace std::chrono_literals;
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    for (;;) {
        int status = 0;
        const auto result = waitpid(child, &status, WNOHANG);
        if (result == child) return WIFEXITED(status) && WEXITSTATUS(status) == 0;
        if (result < 0 && errno != EINTR) return false;
        if (cancelled || std::chrono::steady_clock::now() >= deadline) break;
        std::this_thread::sleep_for(100ms);
    }
    // Stop the helper and its Chromium workers before removing the snapshot.
    kill(-child, SIGKILL);
    while (waitpid(child, nullptr, 0) < 0 && errno == EINTR) {}
    return false;
}

std::string ReadDrafts(const fs::path& stage) {
    const int file = open((stage / "drafts.json").c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (file < 0) return {};
    struct stat status{};
    std::string data;
    if (fstat(file, &status) == 0 && S_ISREG(status.st_mode) && status.st_uid == geteuid() &&
        !(status.st_mode & (S_IRWXG | S_IRWXO)) && status.st_nlink == 1 && status.st_size > 0 &&
        status.st_size <= 2 * 1024 * 1024) {
        try {
            data.resize(static_cast<std::size_t>(status.st_size));
            std::size_t received = 0;
            while (received < data.size()) {
                const auto amount = read(file, data.data() + received, data.size() - received);
                if (amount < 0 && errno == EINTR) continue;
                if (amount <= 0) { data.clear(); break; }
                received += static_cast<std::size_t>(amount);
            }
        } catch (...) { data.clear(); }
    }
    close(file);
    return data;
}
} // namespace

LegacyExport ExportLegacyProfile(const fs::path& bundle, const fs::path& applicationSupport,
                                 const fs::path& userData, const std::atomic_bool& cancelled) {
    fs::path stage;
    try {
        RemoveStaleStages(userData);
        if (cancelled || fs::exists(userData / "legacy-electron-import-v1")) return {};
        const auto source = FindProfile(applicationSupport);
        if (!source) return {};
        const auto binary = bundle / "Contents/Helpers/Electron.app/Contents/MacOS/Electron";
        const auto exporter = bundle / "Contents/Resources/legacy-export";
        if (!fs::is_regular_file(binary) || !Directory(exporter)) return {LegacyExport::Failed, {}};
        auto pattern = (userData / "legacy-export.XXXXXX").string();
        if (!mkdtemp(pattern.data())) return {LegacyExport::Failed, {}};
        stage = pattern;
        const auto child = Launch(binary, exporter, *source, stage);
        if (child > 0 && Wait(child, cancelled, std::chrono::minutes(5)) && !cancelled)
            return {LegacyExport::Exported, stage};
    } catch (...) {}
    if (!stage.empty()) {
        std::error_code ignored;
        fs::remove_all(stage, ignored);
    }
    return {LegacyExport::Failed, {}};
}

bool HasLegacyDraftSource(const fs::path& applicationSupport) {
    return FindDraftProfile(applicationSupport).has_value();
}

std::string ExportLegacyDrafts(const fs::path& bundle, const fs::path& applicationSupport, const fs::path& userData,
                              std::string_view origin, std::string_view backend, std::string_view session,
                              const std::atomic_bool& cancelled) {
    fs::path stage;
    std::string data;
    try {
        const auto source = FindDraftProfile(applicationSupport);
        const auto binary = bundle / "Contents/Helpers/Electron.app/Contents/MacOS/Electron";
        const auto exporter = bundle / "Contents/Resources/legacy-export";
        if (cancelled || !source || !fs::is_regular_file(binary) || !Directory(exporter)) return {};
        auto pattern = (userData / "legacy-export.XXXXXX").string();
        if (!mkdtemp(pattern.data())) return {};
        stage = pattern;
        const auto child = Launch(binary, exporter, *source, stage, {std::string(origin), std::string(backend), std::string(session)});
        if (child > 0 && Wait(child, cancelled, std::chrono::seconds(8)) && !cancelled) data = ReadDrafts(stage);
    } catch (...) {}
    if (!stage.empty()) {
        std::error_code ignored;
        fs::remove_all(stage, ignored);
    }
    return data;
}

} // namespace proctor
