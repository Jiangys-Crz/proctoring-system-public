#pragma once
#include "bridge_internal.hpp"
#include <array>
#include <charconv>

namespace proctor::bridge_detail {
inline bool PreferDirectHttp(std::string_view host) {
    if (host == "localhost" || host == "[::1]" || host.ends_with(".cwnupaa")) return true;
    std::array<unsigned, 4> address{};
    for (std::size_t i = 0; i < address.size(); ++i) {
        const auto dot = host.find('.');
        if ((dot == std::string_view::npos) != (i == address.size() - 1)) return false;
        const auto part = host.substr(0, dot);
        const auto parsed = std::from_chars(part.data(), part.data() + part.size(), address[i]);
        if (parsed.ec != std::errc{} || parsed.ptr != part.data() + part.size() || address[i] > 255) return false;
        if (dot != std::string_view::npos) host.remove_prefix(dot + 1);
    }
    return address[0] == 10 || address[0] == 127 || (address[0] == 192 && address[1] == 168)
        || (address[0] == 172 && address[1] >= 16 && address[1] <= 31)
        || (address[0] == 169 && address[1] == 254);
}
inline std::array<Transport, 3> HttpReadTransports(const HttpUrl& url) {
    return PreferDirectHttp(url.host)
        ? std::array{Transport::Direct, Transport::SystemProxy, Transport::SystemCurl}
        : std::array{Transport::SystemProxy, Transport::Direct, Transport::SystemCurl};
}
}
