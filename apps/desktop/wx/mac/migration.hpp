#pragma once

#include <filesystem>

namespace proctor {

// Call before the native host generates a device ID for this profile.
bool MigrateMacDeviceId(const std::filesystem::path& userData,
                        const std::filesystem::path& applicationSupportDirectory);

} // namespace proctor
