#pragma once

#include <atomic>
#include <filesystem>
#include <string>
#include <string_view>

namespace proctor {

struct LegacyExport {
    enum State { Unavailable, Exported, Failed } state = Unavailable;
    std::filesystem::path stage;
};

// Reads only the installed client's prior profile. The isolated exporter
// opens a private snapshot and returns a staging directory owned by the caller.
LegacyExport ExportLegacyProfile(const std::filesystem::path& bundle,
    const std::filesystem::path& applicationSupport, const std::filesystem::path& userData,
    const std::atomic_bool& cancelled);

bool HasLegacyDraftSource(const std::filesystem::path& applicationSupport);
std::string ExportLegacyDrafts(const std::filesystem::path& bundle, const std::filesystem::path& applicationSupport,
    const std::filesystem::path& userData, std::string_view origin, std::string_view backend,
    std::string_view session, const std::atomic_bool& cancelled);

} // namespace proctor
