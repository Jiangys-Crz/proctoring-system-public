std::string NormalizePath(std::string_view path) {
    if (path.empty()) return "/";
    std::vector<std::string_view> segments;
    while (!path.empty()) {
        path.remove_prefix(1);
        const auto end = path.find('/');
        const auto piece = path.substr(0, end);
        auto decodedDots = Lower(std::string(piece));
        // A browser collapses percent-encoded dot segments when resolving
        // URLs. Apply that before consulting the allowed request paths.
        for (auto index = decodedDots.find("%2e"); index != std::string::npos; index = decodedDots.find("%2e"))
            decodedDots.replace(index, 3, ".");
        if (decodedDots == "." || decodedDots == "..") {
            if (decodedDots == ".." && !segments.empty()) segments.pop_back();
            if (end == std::string_view::npos) segments.emplace_back();
        } else {
            segments.push_back(piece);
        }
        if (end == std::string_view::npos) break;
        path.remove_prefix(end);
    }
    std::string out;
    for (const auto segment : segments) {
        out += '/';
        out += segment;
    }
    return out.empty() ? "/" : out;
}

bool ValidMethod(std::string_view method) {
    return !method.empty() && method.size() <= 32 &&
           std::all_of(method.begin(), method.end(), [](unsigned char c) { return std::isalpha(c) != 0; });
}

bool ValidHeaderName(std::string_view name) {
    return !name.empty() && std::all_of(name.begin(), name.end(), [](unsigned char c) {
        return std::isalnum(c) != 0 || std::string_view("!#$%&'*+-.^`_|~").find(c) != std::string_view::npos;
    });
}

void CheckHeaders(const Json& headers) {
    if (!headers.is_object()) throw std::runtime_error("请求标头无效");
    std::size_t bytes = 0;
    for (const auto& [name, value] : headers.items()) {
        if (!ValidHeaderName(name) || !value.is_string()) throw std::runtime_error("请求标头无效");
        const auto& text = value.get_ref<const std::string&>();
        if (text.find_first_of("\r\n\0", 0, 3) != std::string::npos) throw std::runtime_error("请求标头无效");
        // A caller may supply application auth headers but may not override
        // the socket destination or how the native transport frames the body.
        const auto lower = Lower(name);
        if (lower == "host" || lower == "content-length" || lower == "transfer-encoding")
            throw std::runtime_error("请求标头无效");
        bytes += name.size() + text.size() + 6;
        if (bytes > 32 * 1024) throw std::runtime_error("请求标头过大");
    }
}
