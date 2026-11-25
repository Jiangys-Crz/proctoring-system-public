#include "legacy_drafts.hpp"

#include <array>
#include <charconv>
#include <regex>

namespace proctor {
namespace {

constexpr std::array<std::string_view, 2> kinds{"proctor.contest.code.", "proctor.contest.objective."};
constexpr size_t draftLimit = 512 * 1024;
constexpr size_t totalLimit = 2 * 1024 * 1024;

std::string Decode(std::string_view value) {
    std::string result;
    while (!value.empty()) {
        if (value.front() == '%') {
            if (value.size() < 3) return {};
            unsigned byte = 0;
            const auto end = value.data() + 3;
            const auto [next, error] = std::from_chars(value.data() + 1, end, byte, 16);
            if (error != std::errc{} || next != end || byte < 0x21 || byte > 0x7e) return {};
            result += static_cast<char>(byte);
            value.remove_prefix(3);
            continue;
        }
        if (value.front() == '+') return {};
        result += value.front();
        value.remove_prefix(1);
    }
    return result;
}

std::string Backend(std::string_view input) {
    const auto url = ParseHttpUrl(input);
    return url.path == "/" && url.query.empty() && url.fragment.empty() ? url.origin : "";
}

std::string Text(const Json& value, std::string_view key) {
    if (!value.is_object()) return {};
    const auto field = value.find(key);
    return field != value.end() && field->is_string() ? field->get<std::string>() : "";
}

Json Prefixes(const LegacyDraftTarget& target) {
    auto prefixes = Json::array();
    for (const auto kind : kinds) prefixes.push_back(std::string(kind) + target.sessionId + ".");
    return prefixes;
}

std::string Literal(const Json& value) { return value.dump(-1, ' ', true); }

} // namespace

std::optional<LegacyDraftTarget> LegacyDraftTargetFor(const ContestPolicy& scope, std::string_view raw, const Json& options) {
    if (scope.External() || scope.clientOrigin.empty() || scope.backendOrigin.empty() ||
        !options.is_object() || options.value("restoreLegacyDrafts", Json(false)) != true) return {};
    const auto url = ParseHttpUrl(raw);
    if (url.origin != scope.clientOrigin || url.path != "/contest" || url.query.size() > 4096 || url.query.empty()) return {};

    std::string id, backend;
    bool seenId = false, seenBackend = false;
    auto query = std::string_view(url.query).substr(1);
    while (!query.empty()) {
        const auto end = query.find('&');
        const auto item = query.substr(0, end);
        const auto split = item.find('=');
        if (split != std::string_view::npos) {
            const auto key = Decode(item.substr(0, split));
            if (key == "sessionId") {
                if (seenId) return {};
                seenId = true;
                id = Decode(item.substr(split + 1));
            } else if (key == "apiBase") {
                if (seenBackend) return {};
                seenBackend = true;
                const auto address = Decode(item.substr(split + 1));
                if (address.empty()) return {};
                backend = Backend(address);
            }
        }
        if (end == std::string_view::npos) break;
        query.remove_prefix(end + 1);
    }
    static const std::regex sessionId("[A-Za-z0-9_-]{1,191}");
    if (backend != scope.backendOrigin || !std::regex_match(id, sessionId)) return {};
    const auto headers = Text(options, "extraHeaders");
    static const std::regex tokenHeader(R"((?:^|\r\n)X-Proctor-Session-Token: ([A-Za-z0-9_-]{43})(?:\r\n|$))");
    std::smatch match;
    if (headers.size() > 8500 || !std::regex_search(headers, match, tokenHeader)) return {};
    return LegacyDraftTarget{url.origin, std::move(backend), std::move(id), match[1].str()};
}

bool AuthorizeLegacyDrafts(const LegacyDraftTarget& target, const std::atomic_bool* stopping) {
    try {
        const auto response = RequestHttp(target.backend + "/api/client/contest/state?sessionId=" + target.sessionId,
            "GET", Json{{"X-Proctor-Session-Token", target.token}}, "", 2000, 32 * 1024, true, stopping);
        if (response.status != 200) return false;
        const auto value = Json::parse(response.body, nullptr, false);
        if (!value.is_object() || value.value("ok", Json(false)) != true) return false;
        const auto& data = value.at("data");
        const auto& session = data.at("session");
        return Text(session, "id") == target.sessionId && Text(session, "status") == "IN_EXAM" &&
            !Text(session, "startedAt").empty() && session.value("lockdown", Json(true)) == false;
    } catch (...) { return false; }
}

std::string LegacyDraftReadScript(const LegacyDraftTarget& target) {
    return "(() => { const {origin, backend, sessionId, prefixes, maxEntry, maxTotal} = " +
        Literal(Json{{"origin", target.origin}, {"backend", target.backend}, {"sessionId", target.sessionId},
            {"prefixes", Prefixes(target)}, {"maxEntry", draftLimit}, {"maxTotal", totalLimit}}) + R"JS(;
        const result = Object.create(null);
        if (location.origin !== origin || localStorage.getItem('proctor.contest.sessionId') !== sessionId) return result;
        const apiBase = localStorage.getItem('proctor.contest.sessionApiBase');
        if (!apiBase) return result;
        const api = new URL(apiBase);
        const encoder = new TextEncoder();
        if (api.origin !== backend || api.pathname !== '/' || api.username || api.password || api.search || api.hash) return result;
        let total = 0;
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key || !prefixes.some(prefix => key.startsWith(prefix) && /^\d{1,16}$/.test(key.slice(prefix.length)))) continue;
          const value = localStorage.getItem(key);
          if (value === null || value.length > maxEntry) continue;
          const bytes = encoder.encode(value).length;
          if (bytes > maxEntry || total + bytes + key.length > maxTotal) continue;
          total += bytes + key.length;
          result[key] = value;
        }
        return result;
      })())JS";
}

std::string LegacyDraftInstallScript(const LegacyDraftTarget& target, const Json& drafts) {
    if (!drafts.is_object()) return {};
    auto accepted = Json::object();
    const auto prefixes = Prefixes(target);
    size_t total = 0;
    for (const auto& [key, node] : drafts.items()) {
        if (!node.is_string()) continue;
        const auto& value = node.get_ref<const std::string&>();
        if (value.size() > draftLimit || key.size() > 256 || total + key.size() + value.size() > totalLimit) continue;
        for (const auto& entry : prefixes) {
            const auto& prefix = entry.get_ref<const std::string&>();
            if (!key.starts_with(prefix)) continue;
            const auto pid = std::string_view(key).substr(prefix.size());
            if (pid.empty() || pid.size() > 16 || pid.find_first_not_of("0123456789") != std::string_view::npos) break;
            accepted.emplace(key, node);
            total += key.size() + value.size();
            break;
        }
    }
    if (accepted.empty()) return {};
    return "(() => { const {origin, backend, sessionId, drafts} = " +
        Literal(Json{{"origin", target.origin}, {"backend", target.backend}, {"sessionId", target.sessionId},
            {"drafts", std::move(accepted)}}) + R"JS(;
        if (window !== window.top || location.origin !== origin || location.pathname !== '/contest') return;
        try {
          const params = new URLSearchParams(location.search);
          const ids = params.getAll('sessionId'), apis = params.getAll('apiBase');
          if (ids.length !== 1 || ids[0] !== sessionId || apis.length !== 1) return;
          const api = new URL(apis[0]);
          if (api.origin !== backend || api.pathname !== '/' || api.username || api.password || api.search || api.hash) return;
          const receipt = 'proctor.contest.legacyDrafts.' + backend + '.' + sessionId;
          if (localStorage.getItem(receipt) === '1') return;
          for (const [key, value] of Object.entries(drafts)) {
            if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
          }
          localStorage.setItem(receipt, '1');
        } catch { /* Local storage can be unavailable or full. */ }
      })();)JS";
}

} // namespace proctor
