HttpUrl ResolveHttpUrl(std::string_view base, std::string_view target) {
    const auto origin = ParseHttpUrl(base);
    if (target.starts_with("//")) return ParseHttpUrl(std::string(origin.secure ? "https:" : "http:") + std::string(target));
    if (const auto colon = target.find(':'); colon != std::string_view::npos && colon < target.find_first_of("/?#"))
        return ParseHttpUrl(target);
    return ParseHttpUrl(origin.origin + (target.starts_with('/') ? "" : "/") + std::string(target));
}

HttpResponse RequestHttp(std::string_view url, std::string_view method, const Json& headers,
                         std::string_view body, int timeoutMs, std::size_t maxBytes, bool systemProxy, const std::atomic_bool* stopping) {
    std::string raw;
    auto response = bridge_detail::Exchange(ParseHttpUrl(url), method, headers, body, timeoutMs, systemProxy,
                             [&](std::string_view chunk) { raw.append(chunk); }, maxBytes, stopping);
    response.body = std::move(raw);
    return response;
}

Json RequestJson(std::string_view absoluteUrl, const Json& options) {
    return bridge_detail::RequestJsonWithFallback(ParseHttpUrl(absoluteUrl), options, nullptr);
}
