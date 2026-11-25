#pragma once

#include <array>
#include <charconv>
#include <cstddef>
#include <optional>
#include <string_view>

namespace proctor::bridge_detail {

inline std::optional<std::array<unsigned, 3>> ParseReleaseVersion(std::string_view value) {
    std::array<unsigned, 3> version{};
    for (std::size_t index = 0; index < version.size(); ++index) {
        const auto separator = value.find('.');
        if ((separator == std::string_view::npos) != (index == version.size() - 1)) return std::nullopt;
        const auto part = value.substr(0, separator);
        if (part.empty() || part.size() > 6 || (part.size() > 1 && part.front() == '0')) return std::nullopt;
        const auto parsed = std::from_chars(part.data(), part.data() + part.size(), version[index]);
        if (parsed.ec != std::errc{} || parsed.ptr != part.data() + part.size()) return std::nullopt;
        if (separator != std::string_view::npos) value.remove_prefix(separator + 1);
    }
    return version;
}

} // namespace proctor::bridge_detail
