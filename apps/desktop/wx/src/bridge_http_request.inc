std::string Text(const Json& value, std::string_view key) {
    if (!value.is_object()) return {};
    const auto item = value.find(key);
    return item != value.end() && item->is_string() ? item->get<std::string>() : std::string{};
}

std::string Lower(std::string value) {
    for (auto& ch : value) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    return value;
}

Json Parse(std::string_view value) {
    const auto result = Json::parse(value, nullptr, false);
    return result.is_discarded() ? Json(nullptr) : result;
}

std::optional<std::uint64_t> PositiveId(std::string_view value) {
    if (value.empty() || value.front() == '0') return std::nullopt;
    std::uint64_t number = 0;
    const auto parsed = std::from_chars(value.data(), value.data() + value.size(), number);
    if (parsed.ec != std::errc() || parsed.ptr != value.data() + value.size() || !number || number > 9007199254740991ULL) return std::nullopt;
    return number;
}

Json RequestResponse(const HttpResponse& response) {
    const Json value = Parse(response.body);
    const auto code = Text(value, "code");
    const auto message = Text(value, "message");
    if (code == "CLIENT_SESSION_REVOKED") throw ResponseError("[CLIENT_SESSION_REVOKED] 会话已注销，请重新登录");
    if (code == "CLIENT_DESKTOP_REPLACED") throw ResponseError("[CLIENT_DESKTOP_REPLACED] 当前电脑连接已被新电脑替换，请在新电脑继续考试");
    if (code == "OJ_LOGIN_REJECTED") throw ResponseError("[OJ_LOGIN_REJECTED] " + (message.empty() ? "考试平台拒绝登录，请联系监考老师" : message));
    if (code == "PAIRING_EXPIRED" || code == "PAIRING_INVALID")
        throw ResponseError("[" + code + "] " + (message.empty() ? "登录二维码已失效，请重新生成" : message));
    if (response.status < 200 || response.status >= 300 || !value.is_object() || value.value("ok", Json(false)) != true)
        throw ResponseError(message.empty() ? "请求失败：HTTP " + std::to_string(response.status) : message);
    return value.value("data", Json(nullptr));
}

Json RequestJsonVia(const HttpUrl& target, const Json& options, Transport transport, const std::atomic<bool>* stopping) {
    if (stopping && *stopping) throw NetworkFailure("请求已取消");
    auto method = Text(options, "method");
    if (method.empty()) method = "GET";
    std::ranges::transform(method, method.begin(), [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    const auto body = options.is_object() && options.contains("body") ? options.at("body").dump() : std::string{};
    Json headers = { { "content-type", "application/json" }, { "x-proctor-client", "desktop" } };
    if (options.is_object() && options.contains("headers") && !options.at("headers").is_null()) {
        const auto& provided = options.at("headers");
        CheckHeaders(provided);
        for (const auto& [name, value] : provided.items()) headers[Lower(name)] = value;
    }
    int timeout = 8000;
    if (method == "POST") {
        if (target.path == "/api/client/oj-cookie") timeout = 60000;
        static constexpr std::string_view slowPaths[] = {
            "/api/login-requests", "/api/client/credential-login", "/api/client/candidate-verify",
            "/api/client/pair", "/api/client/material-upload-ticket", "/api/client/reconnect"
        };
        if (std::ranges::find(slowPaths, target.path) != std::end(slowPaths)) timeout = 40000;
    }
    if (transport == Transport::SystemCurl) return RequestResponse(Curl(target, method, headers, body, timeout, stopping));
    std::string raw;
    auto response = Exchange(target, method, headers, body, timeout, transport == Transport::SystemProxy,
                             [&](std::string_view bytes) { raw.append(bytes); }, 16 * 1024 * 1024, stopping);
    response.body = std::move(raw);
    return RequestResponse(response);
}

Json RequestJsonWithFallback(const HttpUrl& target, const Json& options, const std::atomic<bool>* stopping) {
#ifdef _WIN32
    const auto method = Lower(Text(options, "method"));
    const bool retry = method.empty() || method == "get" || method == "head" || method == "options";
    std::string failures;
    for (const auto transport : HttpReadTransports(target)) {
        try { return RequestJsonVia(target, options, transport, stopping); }
        catch (const NetworkFailure& failure) {
            if (!retry || (stopping && *stopping)) throw;
            if (!failures.empty()) failures += "；";
            failures += (transport == Transport::Direct ? "WinHTTP 直连：" : transport == Transport::SystemProxy ? "WinHTTP 系统代理：" : "系统 curl：");
            failures += failure.what();
        }
    }
    throw NetworkFailure(failures);
#else
    const auto method = Lower(Text(options, "method"));
    const bool retry = method.empty() || method == "get" || method == "head" || method == "options";
    const auto cancelled = [&] { return stopping && *stopping; };
    std::string first, second;
    try { return RequestJsonVia(target, options, Transport::SystemProxy, stopping); }
    catch (const NetworkFailure& failure) { if (!retry || cancelled()) throw; first = failure.what(); }
    try { return RequestJsonVia(target, options, Transport::Direct, stopping); }
    catch (const NetworkFailure& failure) { if (cancelled()) throw; second = failure.what(); }
    try { return RequestJsonVia(target, options, Transport::SystemCurl, stopping); }
    catch (const NetworkFailure& failure) {
        if (cancelled()) throw;
        throw NetworkFailure("Electron net 失败：" + first + "；Node HTTP 失败：" + second + "；系统 curl 失败：" + failure.what());
    }
#endif
}

#ifdef _WIN32
HttpResponse RequestUpdateManifest(const HttpUrl& target, int timeoutMs, std::size_t maxBytes,
                                   const std::atomic<bool>* stopping) {
    const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
    // Update endpoints are fixed HTTPS origins. Direct access also avoids
    // legacy WPAD discovery blocking Win7 before its request timeout starts.
    const std::array transports{Transport::Direct, Transport::SystemProxy, Transport::SystemCurl};
    std::string failures;
    for (std::size_t i = 0; i < transports.size(); ++i) {
        if (stopping && *stopping) throw NetworkFailure("请求已取消");
        const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
        if (left <= 0) break;
        const auto budget = static_cast<int>(std::max<std::int64_t>(1, left / static_cast<std::int64_t>(transports.size() - i)));
        try {
            HttpResponse response;
            if (transports[i] == Transport::SystemCurl) response = Curl(target, "GET", {{"accept", "application/json"}}, {}, budget, stopping);
            else {
                std::string raw;
                response = Exchange(target, "GET", {{"accept", "application/json"}}, {}, budget,
                    transports[i] == Transport::SystemProxy, [&](std::string_view bytes) { raw.append(bytes); }, maxBytes, stopping);
                response.body = std::move(raw);
            }
            if (response.body.size() > maxBytes) throw NetworkFailure("服务器响应过大");
            return response;
        } catch (const NetworkFailure& failure) {
            if (stopping && *stopping) throw;
            if (!failures.empty()) failures += "；";
            failures += (transports[i] == Transport::Direct ? "直连：" : transports[i] == Transport::SystemProxy ? "系统代理：" : "系统 curl：");
            failures += failure.what();
        }
    }
    throw NetworkFailure(failures.empty() ? "请求超时" : failures);
}
#endif

Json Diagnose(const HttpUrl& target, const std::atomic<bool>* stopping) {
    // Preserve renderer labels and order across the native implementations.
    Json results = Json::array();
    const auto probe = [&](const char* channel, Transport transport) {
        const auto start = Clock::now();
        Json value = { { "channel", channel }, { "ok", true } };
        try { RequestJsonVia(target, Json::object(), transport, stopping); }
        catch (const std::exception& failure) { value["ok"] = false; value["message"] = failure.what(); }
        value["elapsedMs"] = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - start).count();
        return value;
    };
    auto system = std::async(std::launch::async, probe, "electron-net", Transport::SystemProxy);
    auto direct = std::async(std::launch::async, probe, "node-http", Transport::Direct);
    auto curl = std::async(std::launch::async, probe, "system-curl", Transport::SystemCurl);
    results.push_back(system.get());
    results.push_back(direct.get());
    results.push_back(curl.get());
    return results;
}

void DownloadVerified(const HttpUrl& target, std::uint64_t size, std::string_view sha512,
                      const fs::path& destination, const std::function<void(double)>& progress,
                      const std::atomic<bool>& stopping) {
#ifdef _WIN32
    // Each transport starts a fresh temporary file and hash. Never append a
    // second response to a partial download or change the selected backend.
    const auto transports = HttpReadTransports(target);
    for (std::size_t i = 0; i < 2; ++i) {
        try {
            std::ofstream file(destination, std::ios::binary | std::ios::trunc);
            if (!file) throw std::runtime_error("无法保存更新包");
            Hasher hash(true);
            std::uint64_t received = 0;
            auto last = Clock::now() - 1s;
            Exchange(target, "GET", Json::object(), {}, 15 * 60 * 1000, transports[i] == Transport::SystemProxy,
                [&](std::string_view bytes) {
                    file.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
                    if (!file) throw std::runtime_error("无法保存更新包");
                    hash.Add(bytes); received += bytes.size();
                    if (Clock::now() - last >= 200ms) { last = Clock::now(); progress(std::min(99.0, static_cast<double>(received) * 100.0 / static_cast<double>(size))); }
                }, static_cast<std::size_t>(size), &stopping, true);
            file.close();
            if (!file || received != size || Base64(hash.Finish()) != sha512) throw std::runtime_error("安装包校验失败，请重新下载");
            return;
        } catch (const NetworkFailure&) { if (stopping || i == 1) throw; progress(0); }
    }
#else
    std::ofstream file(destination, std::ios::binary | std::ios::trunc);
    if (!file) throw std::runtime_error("无法保存更新包");
    Hasher hash(true);
    std::uint64_t received = 0;
    auto last = Clock::now() - 1s;
    Exchange(target, "GET", Json::object(), {}, 15 * 60 * 1000, true, [&](std::string_view bytes) {
        file.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
        if (!file) throw std::runtime_error("无法保存更新包");
        hash.Add(bytes);
        received += bytes.size();
        if (Clock::now() - last >= 200ms) {
            last = Clock::now();
            progress(std::min(99.0, static_cast<double>(received) * 100.0 / static_cast<double>(size)));
        }
    }, static_cast<std::size_t>(size), &stopping, true);
    file.close();
    if (!file || received != size || Base64(hash.Finish()) != sha512)
        throw std::runtime_error("安装包校验失败，请重新下载");
#endif
}
