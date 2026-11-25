#include "migration.hpp"

#include <array>
#include <cerrno>
#include <cstdlib>
#include <fcntl.h>
#include <optional>
#include <regex>
#include <string>
#include <string_view>
#include <sys/stat.h>
#include <unistd.h>

namespace proctor {
namespace {
namespace fs = std::filesystem;

bool Directory(const fs::path& path)
{
    std::error_code error;
    return fs::is_directory(fs::symlink_status(path, error));
}

std::optional<std::string> ReadDeviceId(const fs::path& profile)
{
    if (!Directory(profile)) return std::nullopt;
    const auto path = profile / "device-id";
    const int file = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (file < 0) return std::nullopt;
    struct stat info{};
    std::array<char, 129> bytes{};
    size_t count = 0;
    bool valid = fstat(file, &info) == 0 && S_ISREG(info.st_mode) &&
        info.st_size > 0 && info.st_size < static_cast<off_t>(bytes.size());
    while (valid && count < bytes.size()) {
        const auto size = read(file, bytes.data() + count, bytes.size() - count);
        if (size == 0) break;
        if (size < 0) {
            if (errno == EINTR) continue;
            valid = false;
        } else {
            count += static_cast<size_t>(size);
        }
    }
    close(file);
    if (!valid || count == bytes.size()) return std::nullopt;
    const std::string_view content(bytes.data(), count);
    const auto start = content.find_first_not_of(" \t\r\n");
    if (start == std::string_view::npos) return std::nullopt;
    const auto last = content.find_last_not_of(" \t\r\n");
    const std::string value(content.substr(start, last - start + 1));
    static const std::regex uuid("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", std::regex::icase);
    if (std::regex_match(value, uuid)) return value;
    return std::nullopt;
}

bool InstallDeviceId(const fs::path& destination, std::string_view value)
{
    std::error_code error;
    fs::create_directories(destination.parent_path(), error);
    if (error || !Directory(destination.parent_path())) return false;
    auto temporary = (destination.parent_path() / ".device-id.XXXXXX").string();
    const int file = mkstemp(temporary.data());
    if (file < 0) return false;
    while (!value.empty()) {
        const auto size = write(file, value.data(), value.size());
        if (size < 0 && errno == EINTR) continue;
        if (size <= 0) break;
        value.remove_prefix(static_cast<size_t>(size));
    }
    const bool synced = value.empty() && fsync(file) == 0;
    const bool closed = close(file) == 0;
    // Linking the finished file is atomic and refuses to replace an existing ID.
    const bool installed = synced && closed && link(temporary.c_str(), destination.c_str()) == 0;
    unlink(temporary.c_str());
    return installed;
}
} // namespace

bool MigrateMacDeviceId(const fs::path& userData, const fs::path& applicationSupportDirectory)
{
    const auto destination = userData / "device-id";
    std::error_code error;
    const auto status = fs::symlink_status(destination, error);
    if (status.type() != fs::file_type::not_found) return false;

    // The scoped package name is Electron's default here. Also look for the
    // distributed product name used by prior bundles.
    const auto scope = applicationSupportDirectory / "@cwnupaa";
    auto id = Directory(scope) ? ReadDeviceId(scope / "proctor-desktop") : std::nullopt;
    if (!id) id = ReadDeviceId(applicationSupportDirectory / "程序设计算法协会监考客户端");
    return id && InstallDeviceId(destination, *id);
}
} // namespace proctor
